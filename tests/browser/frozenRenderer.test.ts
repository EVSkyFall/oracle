import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { waitForAssistantResponse } from "../../src/browser/actions/assistantResponse.js";
import { createRunClient, RunTimeExpiredError } from "../../src/browser/runClient.js";
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
