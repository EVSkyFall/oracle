import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { waitForAssistantResponse } from "../../src/browser/actions/assistantResponse.js";
import {
  startAppApprovalMonitor,
  withAppApprovalMonitor,
} from "../../src/browser/actions/appApprovals.js";
import { createRunClient, RunTimeExpiredError } from "../../src/browser/runClient.js";
import { moveRunToNewTab } from "../../src/browser/tabReplacement.js";
import { createTurnResync } from "../../src/browser/turnResync.js";
import type { ChromeClient } from "../../src/browser/types.js";

const CONVERSATION = "https://chatgpt.com/c/6add23d8-0000-0000-0000-000000000000";
const never = () => new Promise<never>(() => {});
const quietLogger = () => Object.assign(vi.fn(), { verbose: false });

/** Settles `promise` into a box the test can read while fake timers run. */
function track<T>(promise: Promise<T>) {
  const box: { state: "pending" | "resolved" | "rejected"; value?: T; error?: unknown } = {
    state: "pending",
  };
  promise.then(
    (value) => {
      box.state = "resolved";
      box.value = value;
    },
    (error: unknown) => {
      box.state = "rejected";
      box.error = error;
    },
  );
  return box;
}

describe("the run's time bounds every CDP call of the wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("(a) the response wait's timeout handling never waits on a terminateExecution that does not answer", async () => {
    // The turn keeps running (its stop button stays), so the wait times out; stopping the
    // leftover in-page observer never answers.
    const evaluate = vi.fn(
      async ({ expression, awaitPromise }: { expression: string; awaitPromise?: boolean }) => {
        if (awaitPromise) return never();
        if (expression.includes("extractAssistantTurn")) {
          return { result: { value: { text: "Running command", messageId: "m1", turnIndex: 1 } } };
        }
        if (expression.includes("isStopControlVisible")) return { result: { value: true } };
        return { result: { value: null } };
      },
    );
    const Runtime = {
      evaluate,
      terminateExecution: vi.fn(never),
    } as unknown as ChromeClient["Runtime"];
    const box = track(waitForAssistantResponse(Runtime, 10_000, quietLogger(), 1));
    await vi.advanceTimersByTimeAsync(10_000 + 1_500);
    expect(box.state).toBe("rejected");
    expect(String((box.error as Error).message)).toContain("assistant-response-watchdog-timeout");
  });

  test("a call that never answers is given up when the run's time runs out, then later calls get a short grace", async () => {
    let answer = false;
    const raw = {
      Runtime: {
        evaluate: vi.fn(() => (answer ? Promise.resolve({ result: { value: 1 } }) : never())),
      },
    } as unknown as ChromeClient;
    const runClient = createRunClient(raw);
    const { Runtime } = runClient.client;
    // No deadline (the submission): no bound.
    const unbounded = track(Runtime.evaluate({ expression: "1" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unbounded.state).toBe("pending");

    runClient.setDeadline(Date.now() + 10_000);
    const during = track(Runtime.evaluate({ expression: "1" }));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(during.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(during.state).toBe("rejected");
    expect(during.error).toBeInstanceOf(RunTimeExpiredError);
    expect((during.error as Error).message).toContain("assistant-response-watchdog-timeout");

    // After the time: the next call gets 250 ms (one already went unanswered).
    const after = track(Runtime.evaluate({ expression: "1" }));
    await vi.advanceTimersByTimeAsync(250);
    expect(after.state).toBe("rejected");
    // A page that answers again is read normally.
    answer = true;
    const answered = track(Runtime.evaluate({ expression: "1" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(answered.state).toBe("resolved");
  });

  test("a page that stops answering ends the run at its deadline, as its timeout", async () => {
    // Everything the page is asked after the first seconds goes unanswered, terminate included,
    // and nothing can be reloaded either.
    let frozen = false;
    const evaluate = vi.fn(
      async ({ expression, awaitPromise }: { expression: string; awaitPromise?: boolean }) => {
        if (frozen || awaitPromise) return never();
        if (expression.includes("readTurnProgress")) {
          return { result: { value: { key: "same", length: 4, url: CONVERSATION } } };
        }
        if (expression.includes("extractAssistantTurn")) {
          return { result: { value: { text: "Running command", messageId: "m1", turnIndex: 1 } } };
        }
        if (expression.includes("isStopControlVisible")) return { result: { value: true } };
        return { result: { value: null } };
      },
    );
    const raw = {
      Runtime: { evaluate, terminateExecution: vi.fn(never) },
      Page: { reload: vi.fn(never), navigate: vi.fn(never) },
    } as unknown as ChromeClient;
    const runClient = createRunClient(raw);
    const { Runtime, Page } = runClient.client;
    const logger = quietLogger();
    const resync = createTurnResync({
      Runtime,
      Page,
      logger,
      conversationUrl: () => CONVERSATION,
      timeLimit: runClient,
    });
    const runMs = 5 * 60_000;
    const box = track(
      resync.run(
        (attempt) =>
          waitForAssistantResponse(
            Runtime,
            attempt.remainingMs(runMs),
            logger,
            1,
            undefined,
            attempt.signal,
          ),
        { timeoutMs: runMs },
      ),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    frozen = true;
    await vi.advanceTimersByTimeAsync(runMs - 3_000 - 1_000);
    expect(box.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(box.state).toBe("rejected");
    expect(String((box.error as Error).message)).toContain("assistant-response-watchdog-timeout");
  });
});

describe("a frozen approval check", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const codexishCard = {
    key: "codexish",
    app: "CODEXish",
    title: "CODEXish",
    toolText: "Allow ChatGPT to use CODEXish? ChatGPT will call CODEXish's Fs Read tool.",
    button: { label: "Always allow", rank: 0, index: 0 },
    subject: 0,
    id: "page1:1",
  };

  test("(b) a check whose page call hangs is given up after a minute, the reload goes ahead, and its late answer never clicks", async () => {
    let page = 1;
    let mark: string | null = null;
    const late: { arm?: (value: unknown) => void } = {};
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("readTurnProgress")) {
        return { result: { value: { key: `page${page}`, length: 5, url: CONVERSATION } } };
      }
      if (expression.includes("window.__oracleApprovalButtons = {")) {
        return {
          result: { value: { cards: page === 1 ? [codexishCard] : [], skipped: [], hidden: [] } },
        };
      }
      if (expression.includes("'settling'")) {
        return { result: { value: { status: "ready", x: 50, y: 60 } } };
      }
      // Arming the click's guard is the call the frozen page never answers (until much later).
      if (expression.includes("__oracleTrustedClickGuards ??=")) {
        return new Promise((resolve) => {
          late.arm = resolve;
        });
      }
      const set = /window\.__oracleResyncMark = "([^"]+)"/.exec(expression);
      if (set) {
        mark = set[1]!;
        return { result: { value: mark } };
      }
      const asked = /window\.__oracleResyncMark === "([^"]+)"/.exec(expression);
      if (asked) return { result: { value: asked[1] === mark ? "old" : "complete" } };
      if (expression === "location.href") return { result: { value: CONVERSATION } };
      if (expression.endsWith(").length")) return { result: { value: 4 } };
      return { result: { value: null } };
    });
    const reloads: number[] = [];
    const startedAt = Date.now();
    const reload = vi.fn(async () => {
      reloads.push(Date.now() - startedAt);
      page = 2;
      mark = null;
      return {};
    });
    const dispatchMouseEvent = vi.fn(async () => ({}));
    const logger = quietLogger();
    const Runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const resync = createTurnResync({
      Runtime,
      Page: { reload, navigate: vi.fn() } as unknown as ChromeClient["Page"],
      logger,
      conversationUrl: () => CONVERSATION,
      stallMs: 30_000,
    });
    const runMs = 10 * 60_000;
    const box = track(
      withAppApprovalMonitor(
        Runtime,
        { dispatchMouseEvent } as unknown as ChromeClient["Input"],
        {
          allowApps: ["CODEXish"],
          logger,
          gate: resync.gate,
          deadline: () => resync.deadlineAt(),
        },
        () =>
          resync.run(
            (attempt) =>
              new Promise<string>((resolve, reject) => {
                attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason));
                const check = setInterval(() => {
                  if (page === 2) {
                    clearInterval(check);
                    resolve("waited on the reloaded page");
                  }
                }, 1_000);
              }),
            { timeoutMs: runMs },
          ),
      ),
    );
    // The stall is due at 30 s, but the frozen check holds the page until it is given up.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloads[0]).toBeGreaterThanOrEqual(60_000);
    // The frozen page finally answers the old check: nothing is clicked.
    late.arm?.({ result: { value: { ready: true, contextMatches: true } } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatchMouseEvent).not.toHaveBeenCalled();
    expect(box.state).toBe("resolved");
    expect(
      logger.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("got no answer from the page for 60s")),
    ).toHaveLength(1);
  });

  test("(c) stop() returns by the run's deadline while a check hangs", async () => {
    const evaluate = vi.fn(never);
    const deadline = Date.now() + 20_000;
    const stop = startAppApprovalMonitor(
      { evaluate } as unknown as ChromeClient["Runtime"],
      undefined,
      { allowApps: ["CODEXish"], logger: quietLogger(), deadline: () => deadline },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const stopped = track(stop());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(stopped.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped.state).toBe("resolved");
    const calls = evaluate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(evaluate.mock.calls.length).toBe(calls);
  });
});

describe("a page that stops answering while the answer is awaited", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("(d) a hung page is stopped, reloaded, then replaced by a new tab: the wait and the approval check go on there and the answer is captured from it", async () => {
    const answerText = "The check passed: CODEXish read the file and found 42 lines.";
    // Tab A runs the turn; then its renderer stops and nothing it is asked answers again.
    let frozen = false;
    const evaluateA = vi.fn(
      async ({ expression, awaitPromise }: { expression: string; awaitPromise?: boolean }) => {
        if (frozen || awaitPromise) return never();
        if (expression.includes("readTurnProgress")) {
          return {
            result: { value: { key: `running:${Date.now()}`, length: 9, url: CONVERSATION } },
          };
        }
        if (expression.includes("window.__oracleApprovalButtons = {")) {
          return { result: { value: { cards: [], skipped: [], hidden: [] } } };
        }
        if (expression.includes("extractAssistantTurn")) {
          return { result: { value: { text: "Running command", messageId: "m5", turnIndex: 5 } } };
        }
        if (expression.includes("isStopControlVisible")) return { result: { value: true } };
        return { result: { value: null } };
      },
    );
    const tabA = {
      Runtime: { evaluate: evaluateA, terminateExecution: vi.fn(never) },
      Page: { reload: vi.fn(never), navigate: vi.fn(never) },
      Input: { dispatchMouseEvent: vi.fn(async () => ({})) },
      close: vi.fn(async () => {}),
    };
    // Tab B shows the same turn waiting on an approval; once it is approved, the answer comes.
    let approved = false;
    const card = {
      key: "codexish",
      app: "CODEXish",
      title: "CODEXish",
      toolText: "Allow ChatGPT to use CODEXish? ChatGPT will call CODEXish's Fs Read tool.",
      button: { label: "Always allow", rank: 0, index: 0 },
      subject: 0,
      id: "pageB:1",
    };
    const evaluateB = vi.fn(
      async ({
        expression,
        awaitPromise,
      }: {
        expression: string;
        awaitPromise?: boolean;
      }): Promise<{ result: { value: unknown } }> => {
        if (awaitPromise) return never();
        if (expression.includes("readTurnProgress")) {
          return {
            result: { value: { key: approved ? "done" : "waiting", length: 9, url: CONVERSATION } },
          };
        }
        if (expression.includes("window.__oracleApprovalButtons = {")) {
          return { result: { value: { cards: approved ? [] : [card], skipped: [], hidden: [] } } };
        }
        if (expression.includes("'settling'")) {
          return { result: { value: { status: "ready", x: 50, y: 60 } } };
        }
        if (expression.includes("__oracleTrustedClickGuards ??=")) {
          return { result: { value: { ready: true, contextMatches: true } } };
        }
        if (expression.includes("const summary = { reached")) {
          approved = true;
          return { result: { value: { reached: true, blocked: null } } };
        }
        if (expression.includes("extractAssistantTurn")) {
          const text = approved ? answerText : "Used CODEXish integration. Running command";
          return { result: { value: { text, messageId: "m5", turnIndex: 5 } } };
        }
        if (expression.includes("Find the LAST assistant turn")) {
          return { result: { value: approved } };
        }
        if (expression.includes("isStopControlVisible")) return { result: { value: !approved } };
        if (expression.includes("readThinkingActivity")) {
          return { result: { value: { active: false, strong: false } } };
        }
        if (expression === "1") return { result: { value: 1 } };
        if (expression.endsWith(").length")) return { result: { value: 6 } };
        return { result: { value: null } };
      },
    );
    const tabB = {
      Runtime: { evaluate: evaluateB, terminateExecution: vi.fn(async () => ({})) },
      Page: { reload: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Input: { dispatchMouseEvent: vi.fn(async () => ({})) },
      close: vi.fn(async () => {}),
    };
    const runClient = createRunClient(tabA as unknown as ChromeClient);
    const { Runtime, Page, Input } = runClient.client;
    const logger = quietLogger();
    const opened: string[] = [];
    const resync = createTurnResync({
      Runtime,
      Page,
      logger,
      conversationUrl: () => CONVERSATION,
      timeLimit: runClient,
      replaceTab: (url, givenUp) =>
        moveRunToNewTab({
          runClient,
          logger,
          givenUp,
          open: async () => {
            opened.push(url);
            return {
              client: tabB as unknown as ChromeClient,
              targetId: "TAB-B",
              discard: async () => {},
            };
          },
          retire: (retired) => [() => retired.close()],
          moved: () => {},
        }),
    });
    const runMs = 30 * 60_000;
    const box = track(
      withAppApprovalMonitor(
        Runtime,
        Input,
        {
          allowApps: ["CODEXish"],
          logger,
          gate: resync.gate,
          deadline: () => resync.deadlineAt(),
        },
        () =>
          resync.run(
            (attempt) =>
              waitForAssistantResponse(
                Runtime,
                attempt.remainingMs(runMs),
                logger,
                5,
                undefined,
                attempt.signal,
              ),
            { timeoutMs: runMs },
          ),
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    frozen = true;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(box.state).toBe("resolved");
    expect((box.value as { text: string }).text).toBe(answerText);
    // The ladder: its script stopped, a browser-side reload, then the new tab.
    expect(tabA.Runtime.terminateExecution).toHaveBeenCalled();
    expect(tabA.Page.reload).toHaveBeenCalled();
    expect(opened).toEqual([CONVERSATION]);
    expect(tabA.close).toHaveBeenCalled();
    // The approval was clicked on the new tab; the frozen one was never clicked.
    expect(tabB.Input.dispatchMouseEvent).toHaveBeenCalled();
    expect(tabA.Input.dispatchMouseEvent).not.toHaveBeenCalled();
    const lines = logger.mock.calls.map(([line]) => String(line));
    const steps = lines.filter((line) => line.startsWith("[browser] The page stopped answering"));
    expect(steps[0]).toMatch(/\(\d+s\); stopping its script\.$/);
    expect(steps.some((line) => line.endsWith("reloading it from the browser."))).toBe(true);
    expect(steps.some((line) => line.endsWith("opening the conversation in a new tab."))).toBe(
      true,
    );
    expect(steps.at(-1)).toMatch(
      /the wait moved to a new tab \(target TAB-B\) with 6 turns on the page\.$/,
    );
  });

  test("every turn resync of a run and of both reattach paths can move the wait to a new tab", async () => {
    const { readFile } = await import("node:fs/promises");
    const sources: Array<[string, number]> = [
      ["src/browser/index.ts", 2],
      ["src/browser/reattach.ts", 2],
    ];
    for (const [file, sites] of sources) {
      const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
      const blocks = source.split("createTurnResync({").slice(1);
      expect(blocks).toHaveLength(sites);
      for (const block of blocks) {
        expect(block.slice(0, block.indexOf("});"))).toContain("replaceTab: replaceFrozenTab");
      }
    }
  });
});

describe("an approval check waiting for a frozen page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a probe that fails because the frozen tab was closed under it is not reported as a failed check", async () => {
    // The page stops answering; then its tab is replaced and closed, so the probe still waiting
    // on it fails; the replacement tab answers.
    let state: "frozen" | "closed" | "answers" = "frozen";
    const pending: Array<(error: Error) => void> = [];
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (state === "frozen") {
        return new Promise((_, reject) => {
          pending.push(reject);
        });
      }
      if (expression.includes("window.__oracleApprovalButtons = {")) {
        return { result: { value: { cards: [], skipped: [], hidden: [] } } };
      }
      return { result: { value: 1 } };
    });
    const logger = quietLogger();
    const stop = startAppApprovalMonitor(
      { evaluate } as unknown as ChromeClient["Runtime"],
      undefined,
      { allowApps: ["CODEXish"], logger, frozenMs: 10_000 },
    );
    // The check is given up after 10 s; the probe that follows waits on the frozen page.
    await vi.advanceTimersByTimeAsync(15_000);
    state = "closed";
    for (const reject of pending.splice(0)) reject(new Error("WebSocket connection closed"));
    state = "answers";
    await vi.advanceTimersByTimeAsync(5_000);
    const stopped = track(stop());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped.state).toBe("resolved");
    const lines = logger.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes("got no answer from the page"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("App approval check failed"))).toEqual([]);
    expect(lines).toContain("[browser] App approval check: the page answers again.");
  });
});
