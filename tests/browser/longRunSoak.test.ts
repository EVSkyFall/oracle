import v8 from "node:v8";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { waitForAssistantResponse } from "../../src/browser/actions/assistantResponse.js";
import { withAppApprovalMonitor } from "../../src/browser/actions/appApprovals.js";
import { startThinkingStatusMonitor } from "../../src/browser/actions/thinkingStatus.js";
import { createRunClient } from "../../src/browser/runClient.js";
import { createTurnResync } from "../../src/browser/turnResync.js";
import type { ChromeClient } from "../../src/browser/types.js";

// A long Pro turn against a fake page: the thread does not change for hours, so the resync
// reloads it at 8, 24, 56 and 120 minutes (each reload destroys the page's pending evaluations),
// while the approval monitor polls every 1.5 s and the heartbeat every 30 s. The worker of
// ask-20261026-120418-ucyp died at about 56 minutes, mid-turn, without a trace.
const CONVERSATION = "https://chatgpt.com/c/6add23d8-0000-0000-0000-000000000000";
const MINUTE = 60_000;

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
const heapMb = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

describe("a long turn under all the wait's monitors", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    process.off("unhandledRejection", onUnhandled);
  });

  test("three hours with four stall reloads: no unhandled rejection and no heap growth", async () => {
    let mark: string | null = null;
    let pending: Array<(error: Error) => void> = [];
    let reloads = 0;
    // Plain functions, not mocks: a mock keeps every call's arguments (the expressions are
    // large), which would be the test's own leak.
    let calls = 0;
    const evaluate = async ({
      expression,
      awaitPromise,
    }: {
      expression: string;
      awaitPromise?: boolean;
    }): Promise<unknown> => {
      calls += 1;
      if (awaitPromise && expression.includes("MutationObserver")) {
        // The in-page observer: it ends only with the document (a reload destroys it).
        return new Promise((_, reject) => pending.push(reject));
      }
      if (awaitPromise) {
        // The heartbeat's status read.
        return { result: { value: { message: "Pro thinking", source: "sidecar" } } };
      }
      if (expression.includes("readTurnProgress")) {
        return { result: { value: { key: "same", length: 9, url: CONVERSATION } } };
      }
      if (expression.includes("window.__oracleApprovalButtons = {")) {
        return { result: { value: { cards: [], skipped: [], hidden: [] } } };
      }
      if (expression.includes("extractAssistantTurn")) {
        return { result: { value: { text: "Thinking", messageId: "m5", turnIndex: 5 } } };
      }
      if (expression.includes("isStopControlVisible")) return { result: { value: true } };
      const set = /window\.__oracleResyncMark = "([^"]+)"/.exec(expression);
      if (set) {
        mark = set[1]!;
        return { result: { value: mark } };
      }
      const asked = /window\.__oracleResyncMark === "([^"]+)"/.exec(expression);
      if (asked) return { result: { value: asked[1] === mark ? "old" : "complete" } };
      if (expression === "location.href") return { result: { value: CONVERSATION } };
      if (expression === "document.readyState") return { result: { value: "complete" } };
      if (expression.endsWith(").length")) return { result: { value: 6 } };
      return { result: { value: null } };
    };
    const reload = async () => {
      reloads += 1;
      mark = null;
      for (const reject of pending) reject(new Error("Execution context was destroyed."));
      pending = [];
      return {};
    };
    const raw = {
      Runtime: { evaluate, terminateExecution: async () => ({}) },
      Page: { reload, navigate: async () => ({}) },
      Input: { dispatchMouseEvent: async () => ({}) },
    } as unknown as ChromeClient;
    const runClient = createRunClient(raw);
    const { Runtime, Page, Input } = runClient.client;
    let logged = 0;
    // A logger that keeps nothing, like the session log writer (it only writes to a file).
    const logger = Object.assign((_line: string) => void (logged += 1), { verbose: false });
    const resync = createTurnResync({
      Runtime,
      Page,
      logger,
      conversationUrl: () => CONVERSATION,
      timeLimit: runClient,
    });
    const stopHeartbeat = startThinkingStatusMonitor(Runtime, logger, {
      intervalMs: 30_000,
      progress: resync,
    });
    const runMs = 180 * MINUTE;
    const run = withAppApprovalMonitor(
      Runtime,
      Input,
      {
        allowApps: ["CODEXish"],
        logger,
        gate: resync.gate,
        deadline: () => resync.deadlineAt(),
        onHiddenSurface: (surface) => resync.reportHiddenApproval(surface),
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
    ).then(
      () => "answered",
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    const atHalfHour = heapMb();
    for (let minute = 30; minute < 179; minute += 1) {
      await vi.advanceTimersByTimeAsync(MINUTE);
    }
    const nearEnd = heapMb();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const outcome = await run;
    stopHeartbeat();
    console.info(
      `[soak] heap ${atHalfHour.toFixed(1)} MB at 30 min, ${nearEnd.toFixed(1)} MB at 179 min; ${reloads} reloads; ${calls} page calls; ${logged} log lines; ended: ${String((outcome as Error)?.message ?? outcome).slice(0, 80)}`,
    );
    expect(unhandled).toEqual([]);
    expect(reloads).toBe(4);
    expect(String((outcome as Error).message)).toContain("assistant-response-watchdog-timeout");
    // Two and a half hours of monitors must not grow the heap (generous bound against noise).
    expect(nearEnd - atHalfHour).toBeLessThan(32);
  }, 300_000);
});
