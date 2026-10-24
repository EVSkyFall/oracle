import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserModelPickerState } from "../../src/browser/types.js";
import { BrowserRunCancelledError } from "../../src/oracle/errors.js";

const picker = vi.hoisted(() => ({
  readModelPickerState: vi.fn(),
  restoreModelPickerState: vi.fn(),
}));

vi.mock("../../src/browser/actions/modelPickerState.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/browser/actions/modelPickerState.js")>();
  return { ...actual, ...picker };
});

const { runSelectOnlyCheck } = await import("../../src/browser/selectOnly.js");

const state = (tierLabel: string, sliderValue: number, modelLabel = "GPT-6") =>
  ({
    pickerLabel: `Thinking effort ${tierLabel}`,
    modelLabel,
    modelOptions: ["GPT-6", "GPT-5.6 Sol"],
    tierLabel,
    sliderValue,
    sliderMin: 0,
    sliderMax: 4,
    announcement: null,
  }) satisfies BrowserModelPickerState;

const MEDIUM = state("Medium", 1);
const PRO = state("Pro", 4);

const verifiedEvidence = {
  model: {
    requestedModel: "GPT-6",
    resolvedLabel: "GPT-6",
    strategy: "select" as const,
    status: "switched" as const,
    verified: true,
    source: "chatgpt-model-picker" as const,
    capturedAt: "now",
  },
  thinking: {
    requestedLevel: "pro" as const,
    status: "switched" as const,
    resolvedLabel: "Pro",
    verified: true,
    strictFailClosed: true,
    targetModelKind: null,
    observedModelKind: null,
    source: "chatgpt-thinking-picker" as const,
    capturedAt: "now",
  },
};

function options(overrides: Partial<Parameters<typeof runSelectOnlyCheck>[0]> = {}) {
  return {
    runtime: {} as never,
    input: undefined,
    logger: Object.assign(vi.fn(), { verbose: false }),
    requestedModel: "GPT-6",
    requestedThinkingTime: "pro" as const,
    applySelection: vi.fn(async () => undefined),
    readEvidence: () => verifiedEvidence,
    ...overrides,
  };
}

beforeEach(() => {
  picker.readModelPickerState.mockReset();
  picker.restoreModelPickerState.mockReset();
});

describe("select-only check", () => {
  test("verifies the selection, then restores the previous model and effort", async () => {
    picker.readModelPickerState.mockResolvedValueOnce(MEDIUM).mockResolvedValueOnce(PRO);
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: MEDIUM });
    const logger = Object.assign(vi.fn(), { verbose: false });
    const applySelection = vi.fn(async () => undefined);
    const check = options({ logger, applySelection });
    const report = await runSelectOnlyCheck(check);
    expect(applySelection).toHaveBeenCalledTimes(1);
    expect(picker.restoreModelPickerState).toHaveBeenCalledWith(
      check.runtime,
      undefined,
      MEDIUM,
      logger,
    );
    expect(report).toMatchObject({
      verified: true,
      before: MEDIUM,
      selected: PRO,
      restored: MEDIUM,
      restoreVerified: true,
    });
    const lines = logger.mock.calls.map(([line]) => String(line));
    expect(lines).toContain(
      '[browser] Select-only: before: model "GPT-6", tier "Medium", slider 1 (0-4).',
    );
    expect(
      lines.some((line) => line.includes('tier "Pro", slider 4') && line.endsWith("; verified.")),
    ).toBe(true);
  });

  test("still restores when the selection itself fails", async () => {
    picker.readModelPickerState
      .mockResolvedValueOnce(MEDIUM)
      .mockResolvedValueOnce(state("Pro", 4, "GPT-5.6 Sol"));
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: MEDIUM });
    const report = await runSelectOnlyCheck(
      options({
        applySelection: async () => {
          throw new Error("Thinking time: Pro is unavailable on this account");
        },
        readEvidence: () => ({}),
      }),
    );
    expect(picker.restoreModelPickerState).toHaveBeenCalledTimes(1);
    expect(report.verified).toBe(false);
    expect(report.reason).toContain("Pro is unavailable");
    expect(report.restoreVerified).toBe(true);
  });

  test("an unverified effort or a picker showing another tier is not a verified check", async () => {
    picker.readModelPickerState
      .mockResolvedValueOnce(MEDIUM)
      .mockResolvedValueOnce(state("High", 2));
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: MEDIUM });
    const report = await runSelectOnlyCheck(options());
    expect(report.verified).toBe(false);
    expect(report.reason).toContain('tier "High" instead of "pro"');

    picker.readModelPickerState.mockResolvedValueOnce(MEDIUM).mockResolvedValueOnce(PRO);
    const unverified = await runSelectOnlyCheck(
      options({
        readEvidence: () => ({
          model: verifiedEvidence.model,
          thinking: { ...verifiedEvidence.thinking, status: "unverified", verified: false },
        }),
      }),
    );
    expect(unverified.verified).toBe(false);
    expect(unverified.reason).toContain('thinking time "pro" was not verified');
  });

  test("skips the restore when nothing changed and reports an unreadable starting point", async () => {
    picker.readModelPickerState.mockResolvedValueOnce(MEDIUM).mockResolvedValueOnce(MEDIUM);
    const unchanged = await runSelectOnlyCheck(
      options({
        requestedThinkingTime: "standard",
        readEvidence: () => ({
          model: verifiedEvidence.model,
          thinking: { ...verifiedEvidence.thinking, requestedLevel: "standard" },
        }),
      }),
    );
    expect(picker.restoreModelPickerState).not.toHaveBeenCalled();
    expect(unchanged).toMatchObject({ verified: true, restoreVerified: true });

    picker.readModelPickerState.mockResolvedValueOnce(null).mockResolvedValueOnce(PRO);
    const unreadable = await runSelectOnlyCheck(options());
    expect(picker.restoreModelPickerState).not.toHaveBeenCalled();
    expect(unreadable.restoreVerified).toBe(false);
    expect(unreadable.restoreDetail).toContain("could not be read");
  });

  test("still restores when the picker cannot be read after the selection", async () => {
    picker.readModelPickerState
      .mockResolvedValueOnce(MEDIUM)
      .mockRejectedValueOnce(new Error("Execution context was destroyed"));
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: MEDIUM });
    const report = await runSelectOnlyCheck(options());
    expect(picker.restoreModelPickerState).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ selected: null, restoreVerified: true });
  });

  test("a cancelled check restores before it reports the cancellation", async () => {
    picker.readModelPickerState.mockResolvedValueOnce(MEDIUM).mockResolvedValueOnce(PRO);
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: MEDIUM });
    await expect(
      runSelectOnlyCheck(
        options({
          applySelection: async () => {
            throw new BrowserRunCancelledError();
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BrowserRunCancelledError);
    expect(picker.restoreModelPickerState).toHaveBeenCalledTimes(1);
  });
});
