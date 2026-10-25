import { describe, expect, test, vi } from "vitest";

vi.mock("../../src/browser/utils.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  delay: vi.fn(() => Promise.resolve()),
}));

import {
  enforceThinkingTimeCap,
  isAboveThinkingCap,
  type ThinkingCapSteps,
} from "../../src/browser/actions/thinkingTimeCap.js";
import { runSubmissionWithRecoveryForTest } from "../../src/browser/index.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserModelPickerState } from "../../src/browser/types.js";

const TIERS = ["Instant", "Medium", "High", "Extra High", "Pro"];

function picker(
  value: number | null,
  overrides: Partial<BrowserModelPickerState> = {},
): BrowserModelPickerState {
  return {
    pickerLabel: null,
    modelLabel: "GPT-6",
    modelOptions: [],
    tierLabel: value === null ? null : TIERS[value]!,
    sliderValue: value,
    sliderMin: 0,
    sliderMax: 4,
    announcement: null,
    tierSource: value === null ? null : "header",
    sliderPresent: true,
    ...overrides,
  };
}

/** A picker whose effort moves only as the given steps say. */
function fakePicker(
  start: BrowserModelPickerState | null,
  behaviour: {
    select?: number | null;
    stepDown?: number | null;
    reads?: (BrowserModelPickerState | null)[];
  } = {},
) {
  let current = start;
  const reads = [...(behaviour.reads ?? [])];
  const steps: ThinkingCapSteps = {
    read: vi.fn(async () => (reads.length > 0 ? reads.shift()! : current)),
    select: vi.fn(async () => {
      if (behaviour.select !== undefined) current = picker(behaviour.select);
    }),
    stepDown: vi.fn(async () => {
      if (behaviour.stepDown !== undefined) current = picker(behaviour.stepDown);
    }),
  };
  return steps;
}

const logger = () => Object.assign(vi.fn(), { verbose: false });

describe("thinking-time cap", () => {
  test("ranks tiers against the cap, and cannot place an unknown tier", () => {
    expect(isAboveThinkingCap("pro", "extra-high")).toBe(true);
    expect(isAboveThinkingCap("heavy", "extra-high")).toBe(true);
    expect(isAboveThinkingCap("extra-high", "extra-high")).toBe(false);
    expect(isAboveThinkingCap("standard", "extra-high")).toBe(false);
    expect(isAboveThinkingCap("pro", "pro")).toBe(false);
    expect(isAboveThinkingCap(null, "extra-high")).toBeNull();
  });

  test("a tier within the cap is left alone", async () => {
    const steps = fakePicker(picker(1));
    const log = logger();
    await expect(enforceThinkingTimeCap("extra-high", steps, log)).resolves.toMatchObject({
      maxLevel: "extra-high",
      status: "within",
      before: { modelLabel: "GPT-6", tierLabel: "Medium", sliderValue: 1, readable: true },
    });
    expect(steps.select).not.toHaveBeenCalled();
    expect(steps.stepDown).not.toHaveBeenCalled();
  });

  test("Pro is lowered to the cap by the regular selection and read back", async () => {
    const steps = fakePicker(picker(4), { select: 3 });
    const log = logger();
    const check = await enforceThinkingTimeCap("extra-high", steps, log);
    expect(check).toMatchObject({
      status: "lowered",
      before: { tierLabel: "Pro", sliderValue: 4 },
      after: { tierLabel: "Extra High", sliderValue: 3 },
    });
    expect(steps.select).toHaveBeenCalledWith("extra-high");
    expect(steps.stepDown).not.toHaveBeenCalled();
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toMatch(
      /lowered to model "GPT-6", tier "Extra High", slider 3/,
    );
  });

  test("slider steps lower the tier when the regular selection did not", async () => {
    const steps = fakePicker(picker(4), { select: 4, stepDown: 3 });
    await expect(enforceThinkingTimeCap("extra-high", steps, logger())).resolves.toMatchObject({
      status: "lowered",
      after: { sliderValue: 3 },
    });
    expect(steps.stepDown).toHaveBeenCalledWith("extra-high");
  });

  test("a cap the picker has no exact step for lands on the highest tier below it", async () => {
    const steps = fakePicker(picker(4), { stepDown: 3 });
    await expect(enforceThinkingTimeCap("heavy", steps, logger())).resolves.toMatchObject({
      status: "lowered",
      after: { tierLabel: "Extra High" },
    });
  });

  test("a tier that still reads above the cap stops the submission", async () => {
    const steps = fakePicker(picker(4), { select: 4, stepDown: 4 });
    const error = await enforceThinkingTimeCap("extra-high", steps, logger()).catch((e) => e);
    expect(error).toBeInstanceOf(BrowserAutomationError);
    expect(error).toMatchObject({
      details: {
        code: "thinking-time-above-max",
        maxThinkingTime: "extra-high",
        before: { tierLabel: "Pro", sliderValue: 4 },
        after: { tierLabel: "Pro", sliderValue: 4 },
      },
    });
    expect(error.message).toMatch(/nothing was sent/);
  });

  test("a picker that cannot be read is sent with a warning, not refused", async () => {
    const log = logger();
    const steps = fakePicker(null);
    await expect(enforceThinkingTimeCap("extra-high", steps, log)).resolves.toMatchObject({
      status: "unreadable",
      before: { readable: false },
    });
    expect(steps.select).not.toHaveBeenCalled();
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toMatch(
      /warning: the picker tier could not be read/,
    );
  });

  test("a read that throws counts as unreadable", async () => {
    const steps = fakePicker(null);
    vi.mocked(steps.read).mockRejectedValueOnce(new Error("transport hiccup"));
    await expect(enforceThinkingTimeCap("extra-high", steps, logger())).resolves.toMatchObject({
      status: "unreadable",
    });
  });

  test("a stale announcement naming Pro is no evidence of Pro", async () => {
    const steps = fakePicker(
      picker(null, { tierLabel: "Pro", tierSource: "announcement", sliderPresent: false }),
    );
    await expect(enforceThinkingTimeCap("extra-high", steps, logger())).resolves.toMatchObject({
      status: "unreadable",
      before: { tierLabel: null },
    });
    expect(steps.select).not.toHaveBeenCalled();
  });

  test("a picker that showed Pro and cannot be read back after lowering stops the submission", async () => {
    const steps = fakePicker(picker(4), { reads: [picker(4), null, null, null] });
    await expect(enforceThinkingTimeCap("extra-high", steps, logger())).rejects.toMatchObject({
      details: { code: "thinking-time-above-max" },
    });
  });

  test("a read-back that is briefly unreadable is read once more", async () => {
    const steps = fakePicker(picker(4), { reads: [picker(4), picker(4), null, picker(3)] });
    await expect(enforceThinkingTimeCap("extra-high", steps, logger())).resolves.toMatchObject({
      status: "lowered",
      after: { sliderValue: 3 },
    });
  });

  test("a cap refusal is not retried and not resubmitted through the upload fallback", async () => {
    const refusal = new BrowserAutomationError("above max", {
      stage: "thinking-time-cap",
      code: "thinking-time-above-max",
    });
    const submit = vi.fn(async () => {
      throw refusal;
    });
    const reloadPromptComposer = vi.fn(async () => undefined);
    const prepareFallbackSubmission = vi.fn(async () => undefined);
    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "x",
        attachments: [],
        fallbackSubmission: { prompt: "y", attachments: [] },
        submit,
        reloadPromptComposer,
        prepareFallbackSubmission,
        logger: logger(),
      }),
    ).rejects.toBe(refusal);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reloadPromptComposer).not.toHaveBeenCalled();
    expect(prepareFallbackSubmission).not.toHaveBeenCalled();
  });
});

describe("thinking-time cap with disagreeing tier sources", () => {
  const disagreeing = (header: number, valueText: number) =>
    picker(valueText, {
      tierLabel: TIERS[header]!,
      tierSource: "header",
      currentTiers: [
        { label: TIERS[header]!, source: "header" },
        { label: TIERS[valueText]!, source: "valuetext" },
      ],
    });

  test("a header showing Extra High never hides a slider that says Pro", async () => {
    const steps = fakePicker(disagreeing(3, 4), { select: 3 });
    const check = await enforceThinkingTimeCap("extra-high", steps, logger());
    expect(check.status).toBe("lowered");
    expect(check.before.tierReadings).toEqual([
      { label: "Extra High", source: "header" },
      { label: "Pro", source: "valuetext" },
    ]);
    expect(steps.select).toHaveBeenCalledWith("extra-high");
  });

  test("a slider that still says Pro after lowering is refused, whatever the header says", async () => {
    const steps = fakePicker(disagreeing(3, 4), {
      reads: [disagreeing(3, 4), disagreeing(3, 4), disagreeing(3, 4)],
    });
    await expect(enforceThinkingTimeCap("extra-high", steps, logger())).rejects.toMatchObject({
      details: { code: "thinking-time-above-max" },
    });
  });
});

describe("thinking-time cap and labels that only mention Pro", () => {
  test("a header or slider text that mentions Pro without naming the tier is no evidence of Pro", async () => {
    const steps = fakePicker(
      picker(null, {
        tierLabel: "ChatGPT Pro",
        tierSource: "header",
        currentTiers: [{ label: "ChatGPT Pro", source: "header" }],
      }),
    );
    await expect(enforceThinkingTimeCap("extra-high", steps, logger())).resolves.toMatchObject({
      status: "unreadable",
    });
    expect(steps.select).not.toHaveBeenCalled();
  });
});
