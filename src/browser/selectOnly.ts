import type { BrowserLogger, BrowserSelectOnlyReport, ChromeClient } from "./types.js";
import type {
  BrowserModelSelectionEvidence,
  BrowserThinkingSelectionEvidence,
} from "../sessionStore.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";
import { BrowserRunCancelledError } from "../oracle/errors.js";
import { withoutBrowserCancellation } from "./cancellation.js";
import {
  formatModelPickerState,
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
  /** The run's own model and thinking-time selection, exactly as before a real submit. */
  applySelection: () => Promise<void>;
  readEvidence: () => {
    model?: BrowserModelSelectionEvidence;
    thinking?: BrowserThinkingSelectionEvidence;
  };
}

/**
 * Select-only check: records the picker, runs the normal selection and its verification, reads
 * the result, then puts the previous model and effort back. Nothing is typed or sent.
 */
export async function runSelectOnlyCheck(
  options: SelectOnlyCheckOptions,
): Promise<BrowserSelectOnlyReport> {
  const { runtime, input, logger } = options;
  const before = await readModelPickerState(runtime, input);
  logger(`[browser] Select-only: before: ${formatModelPickerState(before)}.`);

  let selectionError: string | undefined;
  let cancelled: unknown;
  try {
    await options.applySelection();
  } catch (error) {
    if (error instanceof BrowserRunCancelledError) cancelled = error;
    selectionError = error instanceof Error ? error.message : String(error);
  }

  // From here on the account's remembered selection may be changed, so reading it back and
  // restoring it also runs for a cancelled check.
  return withoutBrowserCancellation(async () => {
    // A failed read must not skip the restore below.
    const selected = await readModelPickerState(runtime, input).catch(() => null);
    const { model, thinking } = options.readEvidence();
    const problems: string[] = [];
    if (selectionError) problems.push(selectionError);
    if (options.requestedModel && !model?.verified) {
      problems.push(`model "${options.requestedModel}" was not verified`);
    }
    if (options.requestedThinkingTime) {
      if (!thinking?.verified) {
        problems.push(`thinking time "${options.requestedThinkingTime}" was not verified`);
      }
      const shown = thinkingLevelFromTierLabel(selected?.tierLabel);
      if (shown && shown !== options.requestedThinkingTime) {
        problems.push(
          `the picker shows tier "${selected?.tierLabel}" instead of "${options.requestedThinkingTime}"`,
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
    if (!before) {
      restore = {
        restored: false,
        state: selected,
        detail: "the selection before the check could not be read",
      };
    } else if (
      selected &&
      selected.modelLabel === before.modelLabel &&
      selected.sliderValue === before.sliderValue
    ) {
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
    return {
      verified,
      ...(verified ? {} : { reason: problems.join("; ") }),
      requestedModel: options.requestedModel,
      requestedThinkingTime: options.requestedThinkingTime,
      before,
      selected,
      restored: restore.state,
      restoreVerified: restore.restored,
      ...(restore.detail ? { restoreDetail: restore.detail } : {}),
    };
  });
}
