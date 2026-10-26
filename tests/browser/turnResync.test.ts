import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTurnResync,
  readTurnProgress,
  type TurnResyncAttempt,
} from "../../src/browser/turnResync.js";
import { withAppApprovalMonitor } from "../../src/browser/actions/appApprovals.js";
import { waitForAssistantResponse } from "../../src/browser/actions/assistantResponse.js";
import { startThinkingStatusMonitor } from "../../src/browser/actions/thinkingStatus.js";
import type { BrowserAppApprovalRecord, ChromeClient } from "../../src/browser/types.js";
import { DomNode, FakeDocument } from "./domFixture.js";

const MINUTE = 60_000;
const CONVERSATION = "https://chatgpt.com/c/6add23d8-0000-0000-0000-000000000000";

/** A thread as the progress reader sees it: prior turns, the current turn's rows, the composer. */
function thread(rows: string[], extra: DomNode[] = []) {
  return new FakeDocument([
    new DomNode("main", {}, [
      new DomNode("div", {}, [new DomNode("p", {}, ["Earlier question"])]),
      new DomNode("div", {}, [new DomNode("p", {}, ["Earlier answer"])]),
      new DomNode("div", {}, [new DomNode("p", {}, ["Run the check with CODEXish."])]),
      new DomNode(
        "div",
        {},
        rows.map((row) => new DomNode("div", {}, [row])),
      ),
      ...extra,
      new DomNode("form", {}, [
        new DomNode("div", { contenteditable: "true", role: "textbox" }, ["draft"]),
      ]),
    ]),
  ]) as unknown as Document;
}

/**
 * A ChatGPT tab for the resync: the progress reader runs on `doc()`, reloads and navigations are
 * counted, and each one gives the page a new document (its resync mark is gone).
 */
function fakeTab(doc: () => Document, onLoad: () => void = () => {}) {
  let mark: string | null = null;
  const loads: string[] = [];
  const Runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("readTurnProgress")) {
        const sample = readTurnProgress(doc());
        return { result: { value: { ...sample, url: CONVERSATION } } };
      }
      const set = /window\.__oracleResyncMark = "([^"]+)"/.exec(expression);
      if (set) {
        mark = set[1]!;
        return { result: { value: mark } };
      }
      const asked = /window\.__oracleResyncMark === "([^"]+)"/.exec(expression);
      if (asked) return { result: { value: asked[1] === mark ? "old" : "complete" } };
      if (expression === "location.href") return { result: { value: CONVERSATION } };
      if (expression.endsWith(").length")) return { result: { value: 6 } };
      return { result: { value: null } };
    }),
  };
  const load = (how: string) => {
    loads.push(how);
    mark = null;
    onLoad();
    return Promise.resolve({});
  };
  const Page = {
    reload: vi.fn(async () => load("reload")),
    navigate: vi.fn(async () => load("navigate")),
  };
  return {
    Runtime: Runtime as unknown as ChromeClient["Runtime"],
    Page: Page as unknown as ChromeClient["Page"],
    evaluate: Runtime.evaluate,
    reload: Page.reload,
    loads,
  };
}

/** An attempt that waits until it is aborted, counting how many attempts ran. */
function waitUntilAborted(attempts: TurnResyncAttempt[]) {
  return (attempt: TurnResyncAttempt) => {
    attempts.push(attempt);
    return new Promise<string>((_, reject) => {
      attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason), { once: true });
    });
  };
}

const logLines = (logger: ReturnType<typeof vi.fn>) =>
  logger.mock.calls.map(([line]) => String(line));

describe("turn progress", () => {
  test("activity rows are progress; ticking digits and the composer are not", () => {
    const base = readTurnProgress(thread(["Used CODEXish integration", "Thinking for 3m 12s"]));
    const ticked = readTurnProgress(thread(["Used CODEXish integration", "Thinking for 3m 59s"]));
    const row = readTurnProgress(
      thread(["Used CODEXish integration", "Thinking for 3m 12s", "Running command"]),
    );
    expect(ticked.key).toBe(base.key);
    expect(row.key).not.toBe(base.key);
    expect(row.length).toBeGreaterThan(base.length);
    const draft = thread(["Used CODEXish integration", "Thinking for 3m 12s"]);
    const editor = draft.querySelector('[contenteditable="true"]') as unknown as DomNode;
    editor.nodes.splice(0, 1, "another draft that is much longer");
    expect(readTurnProgress(draft).key).toBe(base.key);
  });

  test("an approval prompt that is shown is progress, also outside the main area", () => {
    const base = readTurnProgress(thread(["Running command"]));
    const card = new FakeDocument([
      ...(thread(["Running command"]) as unknown as FakeDocument).body.children,
      new DomNode("div", { "data-codex-approval-surface": "true" }, [
        "Allow ChatGPT to use CODEXish?",
      ]),
    ]) as unknown as Document;
    expect(readTurnProgress(card).key).not.toBe(base.key);
  });

  test("a reasoning panel outside the main area streams progress too", () => {
    const withPanel = (summary: string) =>
      new FakeDocument([
        ...(thread(["Running command"]) as unknown as FakeDocument).body.children,
        new DomNode("aside", { "data-testid": "thinking-sidecar" }, [
          new DomNode("div", { "data-testid": "reasoning-step" }, [summary]),
        ]),
      ]) as unknown as Document;
    const first = readTurnProgress(withPanel("Checking the CODEXish output"));
    const next = readTurnProgress(withPanel("Checking the CODEXish output. Comparing the lines"));
    expect(next.key).not.toBe(first.key);
  });
});

describe("stalled-turn resync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("(c) eight minutes without a change reload the conversation once, then 16 and 32 minutes later", async () => {
    // A ticking timer is all that changes: that is not progress.
    let seconds = 0;
    const tab = fakeTab(() => thread(["Running command", `Thinking for ${seconds++}s`]));
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: tab.Page,
      logger,
      conversationUrl: () => CONVERSATION,
    });
    const attempts: TurnResyncAttempt[] = [];
    let settled = false;
    const finish: Array<(value: string) => void> = [];
    const waiting = resync
      .run((attempt) => {
        attempts.push(attempt);
        return new Promise<string>((resolve, reject) => {
          finish.push(resolve);
          attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason));
        });
      })
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(8 * MINUTE - 10_000);
    expect(tab.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tab.reload).toHaveBeenCalledTimes(1);
    expect(logLines(logger)).toContain(
      "[browser] Turn looks stalled (no change for 8m); reloading the conversation to resync",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.signal.aborted).toBe(true);
    expect(attempts[1]!.signal.aborted).toBe(false);

    // Backoff: nothing more until 16 minutes after that reload.
    await vi.advanceTimersByTimeAsync(16 * MINUTE - 30_000);
    expect(tab.reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(tab.reload).toHaveBeenCalledTimes(2);
    expect(logLines(logger)).toContain(
      "[browser] Turn looks stalled (no change for 24m); reloading the conversation to resync",
    );
    await vi.advanceTimersByTimeAsync(32 * MINUTE - 30_000);
    expect(tab.reload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(tab.reload).toHaveBeenCalledTimes(3);
    expect(attempts).toHaveLength(4);
    expect(resync.lastChangedAt()).toBeLessThanOrEqual(Date.now() - 56 * MINUTE);

    // Never a stop condition: the wait ends when its attempt ends.
    expect(settled).toBe(false);
    finish.at(-1)!("answer");
    await expect(waiting).resolves.toBe("answer");
    // Remaining time counts from the start: reloads never lengthen the wait.
    expect(attempts[3]!.remainingMs(60 * MINUTE)).toBeLessThan(5 * MINUTE);
  });

  test("progress after a reload starts the eight minutes again", async () => {
    const rows = ["Running command"];
    const tab = fakeTab(() => thread(rows));
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({ Runtime: tab.Runtime, Page: tab.Page, logger });
    const attempts: TurnResyncAttempt[] = [];
    void resync.run(waitUntilAborted(attempts)).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(8 * MINUTE + 10_000);
    expect(tab.reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    rows.push("Used CODEXish integration");
    await vi.advanceTimersByTimeAsync(8 * MINUTE + 10_000);
    expect(tab.reload).toHaveBeenCalledTimes(2);
  });

  test("(b) a turn whose activity rows keep changing is never reloaded", async () => {
    const rows = ["Used CODEXish integration"];
    const tab = fakeTab(() => thread(rows));
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({ Runtime: tab.Runtime, Page: tab.Page, logger });
    void resync.run(waitUntilAborted([])).catch(() => undefined);
    for (let minute = 0; minute < 40; minute += 4) {
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      rows.push(minute % 8 === 0 ? "Running command" : "Used CODEXish integration");
    }
    expect(tab.reload).not.toHaveBeenCalled();
    expect(Date.now() - resync.lastChangedAt()).toBeLessThan(5 * MINUTE);
    expect(logLines(logger).filter((line) => line.includes("stalled"))).toEqual([]);
  });

  test("a page that is not a conversation is never reloaded", async () => {
    const tab = fakeTab(() => thread(["Running command"]));
    tab.evaluate.mockImplementation(async ({ expression }: { expression: string }) => {
      if (expression.includes("readTurnProgress")) {
        return { result: { value: { key: "same", length: 4, url: "https://chatgpt.com/" } } };
      }
      if (expression === "location.href") return { result: { value: "https://chatgpt.com/" } };
      return { result: { value: null } };
    });
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({ Runtime: tab.Runtime, Page: tab.Page, logger });
    void resync.run(waitUntilAborted([])).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.Page.navigate).not.toHaveBeenCalled();
    expect(logLines(logger)).toEqual([
      "[browser] Turn looks stalled (no change for 8m), but no conversation URL is known, so the page is not reloaded.",
    ]);
  });

  test("a wait that ends while the stall is being decided is neither reloaded nor said to be", async () => {
    const tab = fakeTab(() => thread(["Running command"]));
    const pageAnswers = tab.evaluate.getMockImplementation()!;
    // The page is slow to say where it is: the stall decision waits two seconds on location.href.
    tab.evaluate.mockImplementation(async (call: { expression: string }) =>
      call.expression === "location.href"
        ? new Promise((resolve) => {
            setTimeout(() => resolve({ result: { value: CONVERSATION } }), 2_000);
          })
        : pageAnswers(call),
    );
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: tab.Page,
      logger,
      stallMs: 10_000,
      pollMs: 1_000,
    });
    const answer = resync.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("answer"), 10_500);
        }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(answer).resolves.toBe("answer");
    expect(tab.reload).not.toHaveBeenCalled();
    expect(logLines(logger).filter((line) => line.includes("stalled"))).toEqual([]);
  });

  test("a failed reload falls back to opening the conversation URL", async () => {
    const tab = fakeTab(() => thread(["Running command"]));
    tab.reload.mockRejectedValueOnce(new Error("Page.reload is not allowed"));
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: tab.Page,
      logger,
      conversationUrl: () => CONVERSATION,
    });
    void resync.run(waitUntilAborted([])).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(8 * MINUTE + 10_000);
    expect(tab.Page.navigate).toHaveBeenCalledWith({ url: CONVERSATION });
    expect(logLines(logger)).toContain(
      "[browser] Conversation opened again (6 turns on the page); waiting for the turn again.",
    );
  });

  test("(a) a hidden approval prompt makes a quiet turn reload at once, and the shown card is then clicked", async () => {
    // Before the reload the CODEXish prompt is in the page but zero-size; the reload renders it.
    let loaded = 0;
    let clicked = false;
    const tab = fakeTab(
      () => thread(clicked ? ["Running command", "Fs Read done"] : ["Running command"]),
      () => {
        loaded += 1;
      },
    );
    const codexishCard = {
      key: "codexish",
      app: "CODEXish",
      title: "CODEXish",
      toolText: "Allow ChatGPT to use CODEXish? ChatGPT will call CODEXish's Fs Read tool.",
      button: { label: "Always allow", rank: 0, index: 0 },
      subject: 0,
      id: 2,
    };
    const hidden = {
      app: "CODEXish",
      title: "Allow ChatGPT to use CODEXish?",
      state: "zero-size",
      pending: true,
      subject: 0,
      id: 1,
    };
    const progressAndPage = tab.evaluate.getMockImplementation()!;
    tab.evaluate.mockImplementation(async (call: { expression: string }) => {
      const { expression } = call;
      if (expression.includes("window.__oracleApprovalButtons = {")) {
        if (clicked) return { result: { value: { cards: [], skipped: [], hidden: [] } } };
        return {
          result: {
            value:
              loaded === 0
                ? { cards: [], skipped: [], hidden: [hidden] }
                : { cards: [codexishCard], skipped: [], hidden: [] },
          },
        };
      }
      if (expression.includes("__oracleTrustedClickGuards ??=")) {
        return { result: { value: { ready: true, contextMatches: true } } };
      }
      if (expression.includes("const summary = { reached")) {
        clicked = true;
        return { result: { value: { reached: true, blocked: null } } };
      }
      if (expression.includes("'settling'")) {
        return { result: { value: { status: "ready", x: 50, y: 60 } } };
      }
      return progressAndPage(call);
    });
    const logger = Object.assign(vi.fn(), { verbose: false });
    const records: BrowserAppApprovalRecord[] = [];
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: tab.Page,
      logger,
      conversationUrl: () => CONVERSATION,
    });
    const attempts: TurnResyncAttempt[] = [];
    const answer = withAppApprovalMonitor(
      tab.Runtime,
      { dispatchMouseEvent: vi.fn() } as never,
      {
        allowApps: ["CODEXish"],
        logger,
        onApproval: (record) => {
          records.push(record);
        },
        onHiddenSurface: (surface) => resync.reportHiddenApproval(surface),
      },
      () =>
        resync.run((attempt) => {
          attempts.push(attempt);
          return new Promise<string>((resolve, reject) => {
            attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason));
            const check = setInterval(() => {
              if (clicked) {
                clearInterval(check);
                resolve("answered after the approval");
              }
            }, 500);
          });
        }),
    );
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await expect(answer).resolves.toBe("answered after the approval");
    expect(tab.reload).toHaveBeenCalledTimes(1);
    expect(records).toEqual([expect.objectContaining({ app: "CODEXish", button: "Always allow" })]);
    const lines = logLines(logger);
    const hiddenAt = lines.findIndex((line) =>
      line.includes("is in the page but hidden (zero-size)"),
    );
    const stalledAt = lines.findIndex((line) =>
      /^\[browser\] Turn looks stalled \(no change for \d+s; CODEXish's approval prompt is hidden in the page\); reloading the conversation to resync$/.test(
        line,
      ),
    );
    const approvedAt = lines.findIndex((line) =>
      line.includes('CODEXish approved ("Always allow")'),
    );
    expect(hiddenAt).toBeGreaterThanOrEqual(0);
    expect(stalledAt).toBeGreaterThan(hiddenAt);
    expect(approvedAt).toBeGreaterThan(stalledAt);
    expect(attempts).toHaveLength(2);
  });

  test("a hidden prompt does not reload a turn that is still streaming", async () => {
    const rows = ["Running command"];
    const tab = fakeTab(() => thread(rows));
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: tab.Page,
      logger,
      conversationUrl: () => CONVERSATION,
    });
    void resync.run(waitUntilAborted([])).catch(() => undefined);
    for (let second = 0; second < 120; second += 2) {
      rows.push(`streamed words ${"x".repeat(second)}`);
      resync.reportHiddenApproval({ app: "CODEXish", state: "display: none" });
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(tab.reload).not.toHaveBeenCalled();
    // Once it is quiet, the hidden prompt reloads it (once, until the turn moves again).
    for (let second = 0; second < 120; second += 2) {
      resync.reportHiddenApproval({ app: "CODEXish", state: "display: none" });
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });
});

describe("the heartbeat's last change", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("(b) a Pro agent turn whose activity rows keep changing is never reported unchanged", async () => {
    // The thinking status never changes ("response streaming": only the stop button is seen), as
    // in the 2026-10-26 run; only the activity rows move, every two minutes.
    const rows = ["Used CODEXish integration"];
    const tab = fakeTab(() => thread(rows));
    const progressAndPage = tab.evaluate.getMockImplementation()!;
    tab.evaluate.mockImplementation(async (call: { expression: string; awaitPromise?: boolean }) =>
      call.expression.includes("thinking sidecar active")
        ? { result: { value: { message: "response streaming", source: "inline" } } }
        : progressAndPage(call),
    );
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({ Runtime: tab.Runtime, Page: tab.Page, logger });
    void resync.run(waitUntilAborted([])).catch(() => undefined);
    const stop = startThinkingStatusMonitor(tab.Runtime, logger, {
      intervalMs: MINUTE,
      progress: resync,
    });
    for (let minute = 2; minute <= 20; minute += 2) {
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      rows.push(minute % 4 === 0 ? "Running command" : "Used CODEXish integration");
    }
    stop();
    const heartbeats = logLines(logger).filter((line) => line.includes("ChatGPT thinking"));
    expect(heartbeats.length).toBeGreaterThanOrEqual(19);
    expect(heartbeats.filter((line) => line.includes("stale-hint"))).toEqual([]);
    // "last change" never says more than the two minutes between rows (and a poll).
    const agoSeconds = heartbeats.map((line) => {
      const ago = /last change (?:(\d+)m )?(\d+)s ago/.exec(line);
      return ago ? Number(ago[1] ?? 0) * 60 + Number(ago[2]) : 0;
    });
    expect(agoSeconds.filter((seconds) => seconds > 0).length).toBeGreaterThan(5);
    expect(Math.max(...agoSeconds)).toBeLessThanOrEqual(130);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  test("a turn that stopped moving says so: last change grows and the stale hint appears", async () => {
    const tab = fakeTab(() => thread(["Running command"]));
    const progressAndPage = tab.evaluate.getMockImplementation()!;
    tab.evaluate.mockImplementation(async (call: { expression: string; awaitPromise?: boolean }) =>
      call.expression.includes("thinking sidecar active")
        ? { result: { value: { message: "response streaming", source: "inline" } } }
        : progressAndPage(call),
    );
    const logger = Object.assign(vi.fn(), { verbose: false });
    // A stall time beyond the window, so the turn is not reloaded while it is watched.
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: tab.Page,
      logger,
      stallMs: 60 * MINUTE,
    });
    void resync.run(waitUntilAborted([])).catch(() => undefined);
    const stop = startThinkingStatusMonitor(tab.Runtime, logger, {
      intervalMs: MINUTE,
      progress: resync,
    });
    await vi.advanceTimersByTimeAsync(11 * MINUTE + 1_000);
    stop();
    const heartbeats = logLines(logger).filter((line) => line.includes("ChatGPT thinking"));
    expect(heartbeats.at(-1)).toContain("last change 11m 0s ago; stale-hint=no UI progress change");
  });
});

describe("the response wait across a resync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("(d) after the reload the wait finds the same turn and returns its final answer, not the reloaded partial turn", async () => {
    // The turn (index 5, after the 5 turns that were there before the prompt) stalled on a hidden
    // prompt. The reloaded page shows the partial turn with neither a stop button nor an action
    // bar, then the answer streams once the shown card is approved.
    type Phase = "stalled" | "reloaded" | "streaming" | "done";
    let phase: Phase = "stalled";
    let streamedAt = 0;
    let mark: string | null = null;
    let observers: Array<(error: Error) => void> = [];
    const turn = () => {
      if (phase === "stalled" || phase === "reloaded") {
        return {
          text: "Used CODEXish integration. Running command",
          messageId: "m5",
          turnIndex: 5,
        };
      }
      if (phase === "streaming") {
        return { text: "The check passed: CODEXish read", messageId: "m5", turnIndex: 5 };
      }
      return {
        text: "The check passed: CODEXish read the file and found 42 lines.",
        messageId: "m5",
        turnIndex: 5,
      };
    };
    const card = {
      key: "codexish",
      app: "CODEXish",
      title: "CODEXish",
      toolText: "Allow ChatGPT to use CODEXish? ChatGPT will call CODEXish's Fs Read tool.",
      button: { label: "Always allow", rank: 0, index: 0 },
      subject: 0,
      id: 2,
    };
    const evaluate = vi.fn(
      async ({ expression, awaitPromise }: { expression: string; awaitPromise?: boolean }) => {
        if (phase === "streaming" && Date.now() - streamedAt > 20_000) phase = "done";
        if (awaitPromise) {
          // The in-page observer: it never settles on this page; a reload destroys it.
          return new Promise((_, reject) => {
            observers.push(reject);
          });
        }
        if (expression.includes("readTurnProgress")) {
          return {
            result: { value: { key: `${phase}:${turn().text}`, length: 9, url: CONVERSATION } },
          };
        }
        if (expression.includes("window.__oracleApprovalButtons = {")) {
          const value =
            phase === "stalled"
              ? {
                  cards: [],
                  skipped: [],
                  hidden: [
                    {
                      app: "CODEXish",
                      title: "Allow ChatGPT to use CODEXish?",
                      state: "zero-size",
                      pending: true,
                      subject: 0,
                      id: 1,
                    },
                  ],
                }
              : phase === "reloaded"
                ? { cards: [card], skipped: [], hidden: [] }
                : { cards: [], skipped: [], hidden: [] };
          return { result: { value } };
        }
        if (expression.includes("__oracleTrustedClickGuards ??=")) {
          return { result: { value: { ready: true, contextMatches: true } } };
        }
        if (expression.includes("const summary = { reached")) {
          phase = "streaming";
          streamedAt = Date.now();
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
        if (expression === "location.href") return { result: { value: CONVERSATION } };
        if (expression.includes("extractAssistantTurn")) return { result: { value: turn() } };
        // The finished-action bar of the turn: only once the answer is done.
        if (expression.includes("Find the LAST assistant turn")) {
          return { result: { value: phase === "done" } };
        }
        // The stop button: shown while the turn runs, not on the reloaded partial turn.
        if (expression.includes("isStopControlVisible")) {
          return { result: { value: phase === "stalled" || phase === "streaming" } };
        }
        if (expression.includes("readThinkingActivity")) {
          return { result: { value: { active: false, strong: false } } };
        }
        if (expression.endsWith(").length")) return { result: { value: 6 } };
        return { result: { value: null } };
      },
    );
    const reload = vi.fn(async () => {
      mark = null;
      phase = "reloaded";
      for (const reject of observers) reject(new Error("Execution context was destroyed."));
      observers = [];
      return {};
    });
    const Runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const Page = { reload, navigate: vi.fn() } as unknown as ChromeClient["Page"];
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({
      Runtime,
      Page,
      logger,
      conversationUrl: () => CONVERSATION,
    });
    const answer = withAppApprovalMonitor(
      Runtime,
      { dispatchMouseEvent: vi.fn() } as never,
      {
        allowApps: ["CODEXish"],
        logger,
        onHiddenSurface: (surface) => resync.reportHiddenApproval(surface),
      },
      () =>
        resync.run((attempt) =>
          waitForAssistantResponse(
            Runtime,
            attempt.remainingMs(60 * MINUTE),
            logger,
            5,
            undefined,
            attempt.signal,
          ),
        ),
    );
    let settled: unknown = null;
    void answer.then(
      (value) => {
        settled = value;
      },
      (error) => {
        settled = error;
      },
    );
    // Long after the reload and before the approval, the reloaded partial turn is not an answer.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const result = await answer;
    expect(settled).toBe(result);
    expect(result.text).toBe("The check passed: CODEXish read the file and found 42 lines.");
    expect(result.meta.messageId).toBe("m5");
    expect(reload).toHaveBeenCalledTimes(1);
    const lines = logLines(logger);
    expect(lines.filter((line) => line === "Waiting for ChatGPT response")).toHaveLength(2);
    // The aborted attempt ends with the abort: it never goes on to recover or confirm a capture.
    expect(lines.filter((line) => line.includes("Recovered a candidate response"))).toEqual([]);
    expect(lines.filter((line) => line.includes("could not be confirmed"))).toEqual([]);
    // Once the answer is in, nothing keeps polling.
    const calls = evaluate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(evaluate.mock.calls.length).toBe(calls);
  });
});
