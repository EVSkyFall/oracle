import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTurnResync, type TurnResyncAttempt } from "../../src/browser/turnResync.js";
import { withAppApprovalMonitor } from "../../src/browser/actions/appApprovals.js";
import type { BrowserAppApprovalRecord, ChromeClient } from "../../src/browser/types.js";
import { DomNode, FakeDocument } from "./domFixture.js";

const MINUTE = 60_000;
const CONVERSATION = "https://chatgpt.com/c/6add23d8-0000-0000-0000-000000000000";

const lines = (logger: ReturnType<typeof vi.fn>) => logger.mock.calls.map(([line]) => String(line));
const quietLogger = () => Object.assign(vi.fn(), { verbose: false });

/**
 * The page side of a tab: the progress read, the resync's document mark, the URL and the turn
 * count; `scan` answers the approval scan; the guarded trusted click is ready at (50, 60).
 * `reload()` replaces the document (the mark is gone).
 */
function fakePage(options: {
  scan: () => unknown;
  onClickDelivered?: () => void;
  url?: () => string;
  hang?: (expression: string) => boolean;
}) {
  let mark: string | null = null;
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
    if (options.hang?.(expression)) return new Promise(() => {});
    if (expression.includes("readTurnProgress")) {
      return {
        result: { value: { key: "same", length: 4, url: options.url?.() ?? CONVERSATION } },
      };
    }
    if (expression.includes("window.__oracleApprovalButtons = {")) {
      return { result: { value: options.scan() } };
    }
    if (expression.includes("__oracleTrustedClickGuards ??=")) {
      return { result: { value: { ready: true, contextMatches: true } } };
    }
    if (expression.includes("const summary = { reached")) {
      options.onClickDelivered?.();
      return { result: { value: { reached: true, blocked: null } } };
    }
    if (expression.includes("'settling'")) {
      return { result: { value: { status: "ready", x: 50, y: 60 } } };
    }
    const set = /window\.__oracleResyncMark = "([^"]+)"/.exec(expression);
    if (set) {
      mark = set[1]!;
      return { result: { value: mark } };
    }
    const asked = /window\.__oracleResyncMark === "([^"]+)"/.exec(expression);
    if (asked) return { result: { value: asked[1] === mark ? "old" : "complete" } };
    if (expression === "location.href")
      return { result: { value: options.url?.() ?? CONVERSATION } };
    if (expression.endsWith(").length")) return { result: { value: 6 } };
    return { result: { value: null } };
  });
  return {
    evaluate,
    Runtime: { evaluate } as unknown as ChromeClient["Runtime"],
    newDocument: () => {
      mark = null;
    },
  };
}

const card = (id: string) => ({
  key: `codexish-${id}`,
  app: "CODEXish",
  title: "CODEXish",
  toolText: "Allow ChatGPT to use CODEXish? ChatGPT will call CODEXish's Fs Read tool.",
  button: { label: "Always allow", rank: 0, index: 0 },
  subject: 0,
  id,
});

// The attempt with no time left ends as the response wait does at its timeout.
const timedWait =
  (attempts: TurnResyncAttempt[], totalMs: number) => (attempt: TurnResyncAttempt) => {
    attempts.push(attempt);
    if (attempt.remainingMs(totalMs) <= 0) {
      return Promise.reject(new Error("Response timeout"));
    }
    return new Promise<string>((_, reject) => {
      attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason));
      setTimeout(() => reject(new Error("Response timeout")), attempt.remainingMs(totalMs));
    });
  };

describe("card identity per document", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Each document is its own `window` (a vm context) holding a fake DOM: the scan expression runs
   * in it for real, so the identities are the page's own. A closed details hides a prompt
   * without any layout.
   */
  const documentWith = (prompt: DomNode) => {
    const fake = new FakeDocument([new DomNode("main", {}, [prompt])]);
    const context = vm.createContext({ document: fake });
    (context as { window?: unknown }).window = context;
    return context;
  };
  const shownPrompt = () =>
    new DomNode("div", { "data-codex-approval-surface": "true" }, [
      new DomNode("div", { role: "alert" }, [
        new DomNode("p", {}, ["CODEXish"]),
        new DomNode("p", {}, ["Allow ChatGPT to use CODEXish?"]),
      ]),
      new DomNode("form", {}, [new DomNode("button", {}, ["Always allow"])]),
    ]);
  const hiddenPrompt = () =>
    new DomNode("details", {}, [new DomNode("summary", {}, ["Approval"]), shownPrompt()]);

  test("a card approved before a reload never hides a new prompt that the reloaded page numbers the same", async () => {
    // Page 1 shows a prompt (approved); page 2, after a reload, has a new one hidden; the reload
    // that follows renders it on page 3, where it is approved.
    const documents = [
      documentWith(shownPrompt()),
      documentWith(hiddenPrompt()),
      documentWith(shownPrompt()),
    ];
    let current = 0;
    const clicked = new Set<number>();
    const idsByPage: Array<Set<unknown>> = documents.map(() => new Set());
    const tab = fakePage({ scan: () => null });
    const pageAnswers = tab.evaluate.getMockImplementation()!;
    tab.evaluate.mockImplementation(async (call: { expression: string }) => {
      if (call.expression.includes("window.__oracleApprovalButtons = {")) {
        if (clicked.has(current))
          return { result: { value: { cards: [], skipped: [], hidden: [] } } };
        const value = vm.runInContext(call.expression, documents[current]!) as {
          cards: Array<{ id?: unknown }>;
          hidden: Array<{ id?: unknown }>;
        };
        for (const found of [...value.cards, ...value.hidden]) idsByPage[current]!.add(found.id);
        return { result: { value } };
      }
      if (call.expression.includes("const summary = { reached")) clicked.add(current);
      return pageAnswers(call);
    });
    const newDocument = () => {
      current += 1;
      tab.newDocument();
      return Promise.resolve({});
    };
    const reload = vi.fn(newDocument);
    const logger = quietLogger();
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: { reload, navigate: vi.fn() } as unknown as ChromeClient["Page"],
      logger,
      conversationUrl: () => CONVERSATION,
      hiddenQuietMs: 0,
    });
    const onHiddenSurface = vi.fn((surface: { app: string; state: string }) =>
      resync.reportHiddenApproval(surface),
    );
    const records: BrowserAppApprovalRecord[] = [];
    const answer = withAppApprovalMonitor(
      tab.Runtime,
      { dispatchMouseEvent: vi.fn(async () => ({})) } as unknown as ChromeClient["Input"],
      {
        allowApps: ["CODEXish"],
        logger,
        onApproval: (record) => {
          records.push(record);
        },
        onHiddenSurface,
      },
      () =>
        resync.run(
          (attempt) =>
            new Promise<string>((resolve, reject) => {
              attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason));
              const check = setInterval(() => {
                // The first reload comes from elsewhere (a stall), after page 1's approval.
                if (current === 0 && clicked.has(0)) void newDocument();
                if (clicked.has(2)) {
                  clearInterval(check);
                  resolve("approved on page 3");
                }
              }, 500);
            }),
          { timeoutMs: 30 * MINUTE },
        ),
    );
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await expect(answer).resolves.toBe("approved on page 3");
    expect(records).toHaveLength(2);
    expect(onHiddenSurface).toHaveBeenCalled();
    expect(
      lines(logger).filter((line) =>
        line.includes("is in the page but hidden (inside a closed details)"),
      ),
    ).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
    // Both pages numbered their prompt 1; their identities differ by the page's own token.
    const [approved] = [...idsByPage[0]!];
    const [hiddenOnReload] = [...idsByPage[1]!];
    expect(String(approved)).toMatch(/:1$/);
    expect(String(hiddenOnReload)).toMatch(/:1$/);
    expect(hiddenOnReload).not.toBe(approved);
  });
});

describe("a hidden-prompt reload and the conversation URL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a hidden prompt seen before the conversation URL is known reloads as soon as it is known", async () => {
    let url = "https://chatgpt.com/";
    const tab = fakePage({ scan: () => ({ cards: [], skipped: [], hidden: [] }), url: () => url });
    const reload = vi.fn(async () => {
      tab.newDocument();
      return {};
    });
    const logger = quietLogger();
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: { reload, navigate: vi.fn() } as unknown as ChromeClient["Page"],
      logger,
      hiddenQuietMs: 0,
    });
    void resync.run(timedWait([], 30 * MINUTE), { timeoutMs: 30 * MINUTE }).catch(() => undefined);
    const report = setInterval(
      () => resync.reportHiddenApproval({ app: "CODEXish", state: "zero-size" }),
      1_000,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reload).not.toHaveBeenCalled();
    url = CONVERSATION;
    await vi.advanceTimersByTimeAsync(10_000);
    clearInterval(report);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      lines(logger).filter((line) => line.includes("no conversation URL is known")),
    ).toHaveLength(1);
  });
});

describe("approval clicks and conversation reloads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a reload asked for between mouseMoved and mousePressed waits for the click; the monitor goes on on the new document", async () => {
    let page = 1;
    const clickedOn = new Set<number>();
    const events: string[] = [];
    const tab = fakePage({
      scan: () => ({
        cards: clickedOn.has(page) ? [] : [card(`page${page}:1`)],
        skipped: [],
        hidden: [],
      }),
      onClickDelivered: () => {
        clickedOn.add(page);
      },
    });
    const logger = quietLogger();
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: {
        reload: vi.fn(async () => {
          events.push("reload");
          page += 1;
          tab.newDocument();
          return {};
        }),
        navigate: vi.fn(),
      } as unknown as ChromeClient["Page"],
      logger,
      conversationUrl: () => CONVERSATION,
      hiddenQuietMs: 0,
    });
    const Input = {
      dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
        events.push(`${type}@page${page}`);
        if (type === "mouseMoved" && page === 1) {
          // The reload is asked for right after the pointer moved onto the button.
          resync.reportHiddenApproval({ app: "CODEXish", state: "zero-size" });
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        return {};
      }),
    };
    const records: BrowserAppApprovalRecord[] = [];
    const answer = withAppApprovalMonitor(
      tab.Runtime,
      Input as unknown as ChromeClient["Input"],
      {
        allowApps: ["CODEXish"],
        logger,
        onApproval: (record) => {
          records.push(record);
        },
        onHiddenSurface: (surface) => resync.reportHiddenApproval(surface),
        gate: resync.gate,
      },
      () =>
        resync.run(
          (attempt) =>
            new Promise<string>((resolve, reject) => {
              attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason));
              const check = setInterval(() => {
                if (clickedOn.has(2)) {
                  clearInterval(check);
                  resolve("approved on the reloaded page");
                }
              }, 250);
            }),
          { timeoutMs: 30 * MINUTE },
        ),
    );
    await vi.advanceTimersByTimeAsync(MINUTE);
    await expect(answer).resolves.toBe("approved on the reloaded page");
    expect(events).toEqual([
      "mouseMoved@page1",
      "mousePressed@page1",
      "mouseReleased@page1",
      "reload",
      "mouseMoved@page2",
      "mousePressed@page2",
      "mouseReleased@page2",
    ]);
    expect(records).toHaveLength(2);
  });
});
