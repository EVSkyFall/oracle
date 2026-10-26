import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import { DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS } from "./constants.js";
import { createTurnResync, type PageGate, type TurnResyncOptions } from "./turnResync.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

type DeepResearchResult = Awaited<ReturnType<typeof waitForDeepResearchCompletion>>;
type DeepResearchOptions = NonNullable<Parameters<typeof waitForDeepResearchCompletion>[6]>;

/**
 * The most the research-plan wait can take on a page that answers: its 60 s for the plan, the
 * auto-confirm countdown and 30 s for the reads in between. The run client bounds the plan wait
 * by it, so a page that stops answering there cannot hold the run; the wait then goes on to the
 * completion wait, which recovers the page.
 */
export function deepResearchPlanWaitBoundMs(
  autoConfirmWaitMs: number = DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
): number {
  return 60_000 + autoConfirmWaitMs + 30_000;
}

/**
 * The Deep Research completion wait, bounded by the run's time (every call through the run
 * client) and with the page recovered when it stops answering: its script stopped, the tab
 * reloaded, or the wait moved to a new tab (turnResync.ts, frozen pages only: research can be
 * quiet for many minutes, so a quiet thread or a hidden prompt never reloads it). After a
 * recovery the wait starts again scoped like a reattach: a report frame counts only when it
 * belongs to a turn of this prompt, since the target baseline taken before the submission does
 * not survive a reload. Each attempt, recovery included, starts at the sent turn as the page
 * renders it then (resolveMinTurnIndex): a reload or a new tab can render another window of turns.
 * Never resubmits or types.
 */
export function waitForDeepResearchWithRecovery(params: {
  Runtime: ChromeClient["Runtime"];
  Page: ChromeClient["Page"];
  client: ChromeClient;
  logger: BrowserLogger;
  conversationUrl: () => string | null | undefined;
  timeLimit?: TurnResyncOptions["timeLimit"];
  replaceTab?: TurnResyncOptions["replaceTab"];
  saveInterruptedBannerDiagnostic?: TurnResyncOptions["saveInterruptedBannerDiagnostic"];
  timeoutMs: number;
  minTurnIndex?: number | null;
  /** Resolved again for every attempt; minTurnIndex when it is not given or fails. */
  resolveMinTurnIndex?: () => Promise<number | null | undefined>;
  options?: Omit<DeepResearchOptions, "signal">;
  /** Runs the wait with the approval monitor, which shares the page with the recovery. */
  watch: <T>(
    operation: () => Promise<T>,
    monitor: { gate: PageGate; deadline: () => number },
  ) => Promise<T>;
  wait?: typeof waitForDeepResearchCompletion;
}): Promise<DeepResearchResult> {
  const wait = params.wait ?? waitForDeepResearchCompletion;
  const resync = createTurnResync({
    Runtime: params.Runtime,
    Page: params.Page,
    logger: params.logger,
    conversationUrl: params.conversationUrl,
    timeLimit: params.timeLimit,
    replaceTab: params.replaceTab,
    saveInterruptedBannerDiagnostic: params.saveInterruptedBannerDiagnostic,
    frozenOnly: true,
  });
  let attempts = 0;
  return params.watch(
    () =>
      resync.run(
        async (attempt) => {
          attempts += 1;
          const minTurnIndex = params.resolveMinTurnIndex
            ? await params.resolveMinTurnIndex().catch(() => params.minTurnIndex)
            : params.minTurnIndex;
          return wait(
            params.Runtime,
            params.logger,
            attempt.remainingMs(params.timeoutMs),
            minTurnIndex ?? params.minTurnIndex,
            params.Page,
            params.client,
            {
              ...params.options,
              ...(attempts > 1 ? { requireScopedTargetOwner: true } : {}),
              signal: attempt.signal,
            },
          );
        },
        { timeoutMs: params.timeoutMs },
      ),
    { gate: resync.gate, deadline: () => resync.deadlineAt() },
  );
}
