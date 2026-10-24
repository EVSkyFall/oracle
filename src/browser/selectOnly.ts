import type {
  BrowserLogger,
  BrowserModelPickerState,
  BrowserSelectOnlyReport,
  ChromeClient,
} from "./types.js";
import type {
  BrowserModelSelectionEvidence,
  BrowserThinkingSelectionEvidence,
} from "../sessionStore.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";
import { BrowserRunCancelledError } from "../oracle/errors.js";
import { currentBrowserAbortSignal, withoutBrowserCancellation } from "./cancellation.js";
import {
  formatModelPickerState,
  isCompletePickerState,
  readModelPickerState,
  restoreModelPickerState,
  thinkingLevelFromTierLabel,
  type ModelPickerRestoreResult,
} from "./actions/modelPickerState.js";

export interface SelectOnlyCheckOptions {
  runtime: ChromeClient["Runtime"];
  input: ChromeClient["Input"] | undefined;
  logger: BrowserLogger;
  /** Model the run selects with strategy "select"; null when the run keeps ChatGPT's model. */
  requestedModel: string | null;
  requestedThinkingTime: ThinkingTimeLevel | null;
  /**
   * The run's own model and thinking-time selection, exactly as before a real submit. It must
   * use the Runtime it is given, so its page-side work can be awaited before restoring.
   */
  applySelection: (runtime: ChromeClient["Runtime"]) => Promise<void>;
  readEvidence: () => {
    model?: BrowserModelSelectionEvidence;
    thinking?: BrowserThinkingSelectionEvidence;
  };
}

/**
 * A Runtime whose evaluations are tracked. A cancelled run stops waiting for an evaluation, but
 * the page keeps running its script (a late click or arrow key could re-select Pro after the
 * restore), so `settle` waits for every started evaluation to finish in the page.
 */
function trackPageWork(runtime: ChromeClient["Runtime"]): {
  runtime: ChromeClient["Runtime"];
  settle: () => Promise<void>;
} {
  const pending = new Set<Promise<unknown>>();
  const tracked = new Proxy(runtime, {
    get(target, key, receiver) {
      if (key !== "evaluate") return Reflect.get(target, key, receiver);
      return (...args: Parameters<ChromeClient["Runtime"]["evaluate"]>) => {
        const signal = currentBrowserAbortSignal();
        if (signal?.aborted) return Promise.reject(new BrowserRunCancelledError());
        // Outside the cancellation context the call resolves when the page script finishes.
        const raw = withoutBrowserCancellation(() => target.evaluate(...args));
        pending.add(raw);
        void raw.then(
          () => pending.delete(raw),
          () => pending.delete(raw),
        );
        if (!signal) return raw;
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new BrowserRunCancelledError());
          signal.addEventListener("abort", onAbort, { once: true });
          raw.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (error: unknown) => {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
        });
      };
    },
  });
  return {
    runtime: tracked,
    settle: async () => {
      while (pending.size > 0) await Promise.allSettled(pending);
    },
  };
}

function sameSelection(a: BrowserModelPickerState, b: BrowserModelPickerState): boolean {
  if (a.modelLabel !== b.modelLabel) return false;
  if (a.sliderValue !== null || b.sliderValue !== null) return a.sliderValue === b.sliderValue;
  return thinkingLevelFromTierLabel(a.tierLabel) === thinkingLevelFromTierLabel(b.tierLabel);
}

/**
 * Select-only check: records the picker, runs the normal selection and its verification, reads
 * the result, then puts the previous model and effort back. Nothing is typed or sent.
 */
export async function runSelectOnlyCheck(
  options: SelectOnlyCheckOptions,
): Promise<BrowserSelectOnlyReport> {
  const { runtime, input, logger } = options;
  const report = (
    fields: Omit<BrowserSelectOnlyReport, "requestedModel" | "requestedThinkingTime">,
  ) => ({
    ...fields,
    requestedModel: options.requestedModel,
    requestedThinkingTime: options.requestedThinkingTime,
  });
  const before = await readModelPickerState(runtime, input).catch(() => null);
  logger(`[browser] Select-only: before: ${formatModelPickerState(before)}.`);
  if (!isCompletePickerState(before)) {
    // Without the previous model and effort nothing could be restored, so nothing is changed.
    const reason = `the model picker could not be read completely before selecting (${formatModelPickerState(before)}); nothing was changed`;
    logger(`[browser] Select-only: NOT verified (${reason}).`);
    return report({
      verified: false,
      reason,
      before,
      selected: null,
      restored: before,
      restoreVerified: true,
    });
  }

  const page = trackPageWork(runtime);
  let selectionError: string | undefined;
  let cancelled: unknown;
  try {
    await options.applySelection(page.runtime);
  } catch (error) {
    if (error instanceof BrowserRunCancelledError) cancelled = error;
    selectionError = error instanceof Error ? error.message : String(error);
  }

  // From here on the account's remembered selection may be changed, so reading it back and
  // restoring it also runs for a cancelled check.
  return withoutBrowserCancellation(async () => {
    await page.settle();
    // A failed read must not skip the restore below.
    const selected = await readModelPickerState(runtime, input).catch(() => null);
    const { model, thinking } = options.readEvidence();
    const problems: string[] = [];
    if (selectionError) problems.push(selectionError);
    if (!selected) problems.push("the model picker could not be read after selecting");
    if (options.requestedModel) {
      if (!model?.verified) problems.push(`model "${options.requestedModel}" was not verified`);
      if (selected && !selected.modelLabel) problems.push("the picker shows no model");
    }
    if (options.requestedThinkingTime) {
      if (!thinking?.verified) {
        problems.push(`thinking time "${options.requestedThinkingTime}" was not verified`);
      }
      const shown = thinkingLevelFromTierLabel(selected?.tierLabel);
      if (selected && shown !== options.requestedThinkingTime) {
        problems.push(
          `the picker shows tier "${selected.tierLabel ?? "unknown"}" instead of "${options.requestedThinkingTime}"`,
        );
      }
    }
    const verified = problems.length === 0;
    logger(
      `[browser] Select-only: selected: ${formatModelPickerState(selected)}` +
        `${model?.resolvedLabel ? `; model evidence "${model.resolvedLabel}"` : ""}` +
        `${thinking?.resolvedLabel ? `; effort evidence "${thinking.resolvedLabel}"` : ""}` +
        `; ${verified ? "verified" : `NOT verified (${problems.join("; ")})`}.`,
    );

    let restore: ModelPickerRestoreResult;
    if (selected && isCompletePickerState(selected) && sameSelection(selected, before)) {
      restore = { restored: true, state: selected };
    } else {
      restore = await restoreModelPickerState(runtime, input, before, logger).catch(
        (error: unknown) => ({
          restored: false,
          state: null,
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    logger(
      `[browser] Select-only: restored: ${formatModelPickerState(restore.state)}` +
        `${restore.restored ? "." : `; restore incomplete (${restore.detail ?? "unknown"}).`}`,
    );
    if (cancelled) throw cancelled;
    return report({
      verified,
      ...(verified ? {} : { reason: problems.join("; ") }),
      before,
      selected,
      restored: restore.state,
      restoreVerified: restore.restored,
      ...(restore.detail ? { restoreDetail: restore.detail } : {}),
    });
  });
}
