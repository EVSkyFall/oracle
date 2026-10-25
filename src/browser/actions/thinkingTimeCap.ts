import type { BrowserLogger, BrowserModelPickerState, ChromeClient } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import type { BrowserThinkingCapEvidence, BrowserThinkingCapStatus } from "../../sessionStore.js";
import { BrowserAutomationError, BrowserRunCancelledError } from "../../oracle/errors.js";
import { delay } from "../utils.js";
import { ensureThinkingTime } from "./thinkingTime.js";
import {
  highestCurrentTierLevel,
  formatModelPickerState,
  lowerModelPickerTier,
  modelPickerEvidence,
  readModelPickerState,
  thinkingLevelRank,
} from "./modelPickerState.js";

/** The picker operations the cap uses; the browser run passes the real ones. */
export interface ThinkingCapSteps {
  /** Opens the picker, reads it and closes it again; null when it cannot be read. */
  read: () => Promise<BrowserModelPickerState | null>;
  /** The run's regular thinking-time selection, aimed at the cap level. */
  select: (level: ThinkingTimeLevel) => Promise<void>;
  /** Trusted effort-slider steps down to the cap, when the regular selection did not lower it. */
  stepDown: (level: ThinkingTimeLevel) => Promise<void>;
}

/** Whether the tier shown is above the cap; null when the tier (or the cap) cannot be placed. */
export function isAboveThinkingCap(
  shown: ThinkingTimeLevel | null | undefined,
  maxLevel: ThinkingTimeLevel,
): boolean | null {
  const shownRank = thinkingLevelRank(shown);
  const capRank = thinkingLevelRank(maxLevel);
  if (shownRank === undefined || capRank === undefined) return null;
  return shownRank > capRank;
}

export function browserThinkingCapSteps(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  logger: BrowserLogger,
): ThinkingCapSteps {
  return {
    read: () => readModelPickerState(runtime, input),
    select: async (level) => {
      await ensureThinkingTime(runtime, level, logger, null);
    },
    stepDown: async (level) => {
      const result = await lowerModelPickerTier(runtime, input, level);
      if (!result.lowered) {
        logger(`${LOG_PREFIX} (${level}): slider steps did not lower it (${result.detail}).`);
      }
    },
  };
}

const LOG_PREFIX = "[browser] Thinking-time cap";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The --browser-max-thinking-time check, made right before a submission. A tier above the cap is
 * lowered (the regular selection first, then slider steps) and read back; a tier still above it
 * throws `thinking-time-above-max`, so nothing is sent. A picker whose tier cannot be read is
 * logged and the prompt is sent: without evidence of a higher tier nothing is refused.
 */
export async function enforceThinkingTimeCap(
  maxLevel: ThinkingTimeLevel,
  steps: ThinkingCapSteps,
  logger: BrowserLogger,
): Promise<BrowserThinkingCapEvidence> {
  const read = async () => {
    try {
      return await steps.read();
    } catch (error) {
      if (error instanceof BrowserRunCancelledError) throw error;
      logger(`${LOG_PREFIX} (${maxLevel}): reading the picker failed (${errorText(error)}).`);
      return null;
    }
  };
  const beforeState = await read();
  const before = modelPickerEvidence(beforeState);
  const record = (
    status: BrowserThinkingCapStatus,
    afterState?: BrowserModelPickerState | null,
  ): BrowserThinkingCapEvidence => ({
    maxLevel,
    status,
    before,
    ...(afterState !== undefined ? { after: modelPickerEvidence(afterState) } : {}),
    capturedAt: new Date().toISOString(),
  });

  const above = isAboveThinkingCap(highestCurrentTierLevel(beforeState), maxLevel);
  if (above === null) {
    logger(
      `${LOG_PREFIX} (${maxLevel}): warning: the picker tier could not be read (${formatModelPickerState(beforeState)}); sending without a confirmed tier.`,
    );
    return record("unreadable");
  }
  if (!above) {
    logger(`${LOG_PREFIX} (${maxLevel}): ${formatModelPickerState(beforeState)}, within the cap.`);
    return record("within");
  }

  logger(
    `${LOG_PREFIX} (${maxLevel}): ${formatModelPickerState(beforeState)} is above the cap; lowering it before submitting.`,
  );
  try {
    await steps.select(maxLevel);
  } catch (error) {
    if (error instanceof BrowserRunCancelledError) throw error;
    logger(`${LOG_PREFIX} (${maxLevel}): the regular selection failed (${errorText(error)}).`);
  }
  let afterState = await read();
  if (isAboveThinkingCap(highestCurrentTierLevel(afterState), maxLevel) !== false) {
    try {
      await steps.stepDown(maxLevel);
    } catch (error) {
      if (error instanceof BrowserRunCancelledError) throw error;
      logger(`${LOG_PREFIX} (${maxLevel}): slider steps failed (${errorText(error)}).`);
    }
    afterState = await read();
  }
  let stillAbove = isAboveThinkingCap(highestCurrentTierLevel(afterState), maxLevel);
  if (stillAbove === null) {
    // The menu can be mid-render right after a change; read once more before deciding.
    await delay(500);
    afterState = await read();
    stillAbove = isAboveThinkingCap(highestCurrentTierLevel(afterState), maxLevel);
  }
  if (stillAbove !== false) {
    // The last tier that could be read is above the cap: nothing shows it was lowered.
    const shown =
      stillAbove === true
        ? formatModelPickerState(afterState)
        : `${formatModelPickerState(beforeState)} (the picker could not be read back: ${formatModelPickerState(afterState)})`;
    const message = `Thinking time: the picker still shows ${shown} after lowering it to the maximum "${maxLevel}"; nothing was sent.`;
    logger(`${LOG_PREFIX} (${maxLevel}): ${message}`);
    throw new BrowserAutomationError(message, {
      stage: "thinking-time-cap",
      code: "thinking-time-above-max",
      maxThinkingTime: maxLevel,
      before,
      after: modelPickerEvidence(afterState),
    });
  }
  logger(`${LOG_PREFIX} (${maxLevel}): lowered to ${formatModelPickerState(afterState)}.`);
  return record("lowered", afterState);
}
