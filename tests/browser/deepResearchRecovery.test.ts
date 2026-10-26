import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildAssistantSnapshotExpressionForTest } from "../../src/browser/actions/assistantResponse.js";
import {
  waitForDeepResearchCompletion,
  waitForResearchPlanAutoConfirm,
} from "../../src/browser/actions/deepResearch.js";
import { withAppApprovalMonitor } from "../../src/browser/actions/appApprovals.js";
import { waitForDeepResearchWithRecovery } from "../../src/browser/deepResearchWait.js";
import { createRunClient } from "../../src/browser/runClient.js";
import { moveRunToNewTab } from "../../src/browser/tabReplacement.js";
import type { ChromeClient } from "../../src/browser/types.js";

const CONVERSATION = "https://chatgpt.com/c/6add23d8-0000-0000-0000-000000000000";
const never = () => new Promise<never>(() => {});
const quietLogger = () => Object.assign(vi.fn(), { verbose: false });

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

const researching = {
  finished: false,
  stopVisible: true,
  textLength: 40,
  researchActivity: true,
  turnCount: 1,
  turnKey: "dr",
};

describe("Deep Research waits on a page that stops answering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the completion wait ends at the run's deadline as its own Deep Research timeout", async () => {
    let frozen = false;
    const raw = {
      Runtime: {
        evaluate: vi.fn(async () => (frozen ? never() : { result: { value: researching } })),
      },
    } as unknown as ChromeClient;
    const runClient = createRunClient(raw);
    runClient.setDeadline(Date.now() + 60_000);
    const box = track(
      waitForDeepResearchCompletion(runClient.client.Runtime, quietLogger(), 60_000, 1),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    frozen = true;
    await vi.advanceTimersByTimeAsync(48_000 + 1_000);
    expect(box.state).toBe("rejected");
    expect(box.error).toMatchObject({ details: { code: "deep-research-timeout" } });
  });

  test("the research-plan wait goes on to the completion wait when the page does not answer within its bound", async () => {
    const raw = { Runtime: { evaluate: vi.fn(never) } } as unknown as ChromeClient;
    const runClient = createRunClient(raw);
    runClient.setDeadline(Date.now() + 160_000);
    const logger = quietLogger();
    const box = track(waitForResearchPlanAutoConfirm(runClient.client.Runtime, logger));
    await vi.advanceTimersByTimeAsync(160_000 + 1);
    expect(box.state).toBe("resolved");
    expect(box.value).toBeNull();
    expect(logger.mock.calls.map(([line]) => String(line))).toContain(
      "[browser] Deep Research plan wait: the page did not answer within the plan wait; proceeding to monitor research progress.",
    );
  });

  test("a frozen research page is replaced by a new tab: the wait goes on there, scoped like a reattach, and returns the report from it", async () => {
    const report = "Deep research report: the findings, with sources.";
    let frozen = false;
    const evaluateA = vi.fn(async ({ expression }: { expression: string }) => {
      if (frozen) return never();
      if (expression.includes("readTurnProgress")) {
        return { result: { value: { key: `dr:${Date.now()}`, length: 9, url: CONVERSATION } } };
      }
      if (expression.includes("deepResearchFrameInScope"))
        return { result: { value: researching } };
      return { result: { value: null } };
    });
    const snapshotExpression = buildAssistantSnapshotExpressionForTest(1);
    const evaluateB = vi.fn(
      async ({ expression }: { expression: string }): Promise<{ result: { value: unknown } }> => {
        if (expression.includes("readTurnProgress")) {
          return { result: { value: { key: "done", length: 9, url: CONVERSATION } } };
        }
        if (expression.includes("deepResearchFrameInScope")) {
          return {
            result: {
              value: { ...researching, finished: true, stopVisible: false, textLength: 5000 },
            },
          };
        }
        if (expression === snapshotExpression) {
          return {
            result: { value: { text: report, turnId: "t2", messageId: "m2", turnIndex: 1 } },
          };
        }
        if (expression === "1") return { result: { value: 1 } };
        if (expression === "document.readyState") return { result: { value: "complete" } };
        if (expression.endsWith(").length")) return { result: { value: 2 } };
        return { result: { value: null } };
      },
    );
    const tabA = {
      Runtime: { evaluate: evaluateA, terminateExecution: vi.fn(never) },
      Page: { reload: vi.fn(never), navigate: vi.fn(never) },
      close: vi.fn(async () => {}),
    };
    const tabB = {
      Runtime: { evaluate: evaluateB },
      Page: { reload: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      close: vi.fn(async () => {}),
    };
    const runClient = createRunClient(tabA as unknown as ChromeClient);
    const { Runtime, Page, Input } = runClient.client;
    const logger = quietLogger();
    const calls: Array<{ target: string; options: unknown; minTurnIndex: unknown }> = [];
    // The sent turn as each attempt finds it: index 2 on the first tab, 1 in the new tab's window.
    const sentTurnIndexes = [2, 1];
    const resolveMinTurnIndex = vi.fn(async () => sentTurnIndexes.shift());
    const box = track(
      waitForDeepResearchWithRecovery({
        Runtime,
        Page,
        client: runClient.client,
        logger,
        conversationUrl: () => CONVERSATION,
        timeLimit: runClient,
        replaceTab: (url, givenUp) =>
          moveRunToNewTab({
            runClient,
            logger,
            givenUp,
            open: async () => ({
              client: tabB as unknown as ChromeClient,
              targetId: "TAB-B",
              discard: async () => {},
            }),
            retire: (retired) => [() => retired.close()],
            moved: () => {},
          }),
        timeoutMs: 30 * 60_000,
        // The scope the run had before the plan wait; the recovery must not reuse it.
        minTurnIndex: 3,
        resolveMinTurnIndex,
        options: { ignoredTargetKeys: ["old"], targetBaselineCaptured: true },
        wait: (runtime, waitLogger, timeoutMs, minTurnIndex, page, client, options) => {
          calls.push({
            target: runClient.current() === (tabB as unknown) ? "B" : "A",
            options,
            minTurnIndex,
          });
          return waitForDeepResearchCompletion(
            runtime,
            waitLogger,
            timeoutMs,
            minTurnIndex,
            page,
            client,
            options,
          );
        },
        watch: (operation, monitor) =>
          withAppApprovalMonitor(
            Runtime,
            Input,
            { allowApps: ["CODEXish"], logger, ...monitor },
            operation,
          ),
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    frozen = true;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(box.state).toBe("resolved");
    expect(box.value?.text).toBe(report);
    expect(calls.map((call) => call.target)).toEqual(["A", "B"]);
    // Each attempt, the recovery included, starts at the sent turn as that page renders it.
    expect(resolveMinTurnIndex).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.minTurnIndex)).toEqual([2, 1]);
    expect(calls[0]!.options).toMatchObject({ targetBaselineCaptured: true });
    expect(calls[0]!.options).not.toHaveProperty("requireScopedTargetOwner");
    // After the move the target baseline no longer holds: the report must belong to this prompt.
    expect(calls[1]!.options).toMatchObject({
      ignoredTargetKeys: ["old"],
      requireScopedTargetOwner: true,
    });
    expect(tabA.Runtime.terminateExecution).toHaveBeenCalled();
    expect(tabA.Page.reload).toHaveBeenCalled();
    const lines = logger.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes("the wait moved to a new tab (target TAB-B)"))).toBe(
      true,
    );
    // Research can be quiet for long: a quiet spell is not a reason to reload.
    expect(lines.filter((line) => line.includes("Turn looks stalled"))).toEqual([]);
  });

  test("a long quiet research spell on a page that answers is never reloaded", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("readTurnProgress")) {
        return { result: { value: { key: "same", length: 9, url: CONVERSATION } } };
      }
      if (expression.includes("deepResearchFrameInScope"))
        return { result: { value: researching } };
      return { result: { value: null } };
    });
    const reload = vi.fn(async () => ({}));
    const navigate = vi.fn(async () => ({}));
    const raw = {
      Runtime: { evaluate },
      Page: { reload, navigate },
    } as unknown as ChromeClient;
    const runClient = createRunClient(raw);
    const logger = quietLogger();
    const box = track(
      waitForDeepResearchWithRecovery({
        Runtime: runClient.client.Runtime,
        Page: runClient.client.Page,
        client: runClient.client,
        logger,
        conversationUrl: () => CONVERSATION,
        timeLimit: runClient,
        timeoutMs: 40 * 60_000,
        minTurnIndex: 1,
        watch: (operation) => operation(),
      }),
    );
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(
      logger.mock.calls.filter(([line]) => String(line).includes("Turn looks stalled")),
    ).toEqual([]);
    expect(box.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10_000);
    expect(box.state).toBe("rejected");
    expect(box.error).toMatchObject({ details: { code: "deep-research-timeout" } });
  });

  test("a sent-turn read that fails or finds nothing leaves the attempt at the run's scope", async () => {
    const raw = {
      Runtime: { evaluate: vi.fn(async () => ({ result: { value: null } })) },
      Page: { reload: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
    } as unknown as ChromeClient;
    const runClient = createRunClient(raw);
    const seen: unknown[] = [];
    const run = (resolveMinTurnIndex: () => Promise<number | null | undefined>) =>
      waitForDeepResearchWithRecovery({
        Runtime: runClient.client.Runtime,
        Page: runClient.client.Page,
        client: runClient.client,
        logger: quietLogger(),
        conversationUrl: () => CONVERSATION,
        timeoutMs: 60_000,
        minTurnIndex: 3,
        resolveMinTurnIndex,
        watch: (operation) => operation(),
        wait: async (_runtime, _logger, _timeoutMs, minTurnIndex) => {
          seen.push(minTurnIndex);
          return { text: "report" } as never;
        },
      });
    await run(async () => {
      throw new Error("page gone");
    });
    await run(async () => null);
    expect(seen).toEqual([3, 3]);
  });

  test("every Deep Research wait of the runs and both reattach paths goes through the recovery", async () => {
    const { readFile } = await import("node:fs/promises");
    const index = await readFile(new URL("../../src/browser/index.ts", import.meta.url), "utf8");
    const reattach = await readFile(
      new URL("../../src/browser/reattach.ts", import.meta.url),
      "utf8",
    );
    expect(index.split("waitForDeepResearchWithRecovery({").length - 1).toBe(2);
    expect(index.split("deepResearchPlanWaitBoundMs()").length - 1).toBe(2);
    expect(index).not.toContain("waitForDeepResearchCompletion(");
    expect(reattach.split("waitForDeepResearchWithRecovery({").length - 1).toBe(2);
    for (const source of [index, reattach]) {
      for (const block of source.split("waitForDeepResearchWithRecovery({").slice(1)) {
        expect(block.slice(0, block.indexOf("}),"))).toContain("replaceTab: replaceFrozenTab");
      }
    }
    // The runs' waits find the sent turn again for every attempt, recovery included.
    for (const block of index.split("waitForDeepResearchWithRecovery({").slice(1)) {
      expect(block.slice(0, block.indexOf("watch:"))).toMatch(
        /resolveMinTurnIndex: async \(\) => \{\s*await scopeAnswerToSentTurn\(\);\s*return baselineTurns;\s*\},/,
      );
    }
  });
});
