import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserModelPickerState } from "../../src/browser/types.js";
import { BrowserRunCancelledError } from "../../src/oracle/errors.js";
import { BrowserCancellation } from "../../src/browser/cancellation.js";

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

  test("skips the restore when nothing changed", async () => {
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
  });

  test.each([
    ["an unreadable picker", null],
    ["a picker without its model", { ...MEDIUM, modelLabel: null }],
    [
      "a picker whose effort slider never mounted",
      { ...MEDIUM, sliderValue: null, tierLabel: null },
    ],
    [
      "a picker whose tier is only named by an announcement",
      { ...MEDIUM, sliderValue: null, tierSource: "announcement" as const },
    ],
  ])("changes nothing when the starting point is incomplete (%s)", async (_case, before) => {
    picker.readModelPickerState.mockResolvedValueOnce(before);
    const applySelection = vi.fn(async () => undefined);
    const result = await runSelectOnlyCheck(options({ applySelection }));
    expect(applySelection).not.toHaveBeenCalled();
    expect(picker.restoreModelPickerState).not.toHaveBeenCalled();
    expect(result).toMatchObject({ verified: false, restoreVerified: true });
    expect(result.reason).toContain("nothing was changed");
  });

  test("a picker that cannot be read, or shows no known tier, after selecting is not verified", async () => {
    picker.readModelPickerState
      .mockResolvedValueOnce(MEDIUM)
      .mockRejectedValueOnce(new Error("Execution context was destroyed"));
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: MEDIUM });
    const unreadable = await runSelectOnlyCheck(options());
    expect(picker.restoreModelPickerState).toHaveBeenCalledTimes(1);
    expect(unreadable).toMatchObject({ verified: false, selected: null, restoreVerified: true });

    picker.readModelPickerState
      .mockResolvedValueOnce(MEDIUM)
      .mockResolvedValueOnce(state("Turbo", 4));
    const unknownTier = await runSelectOnlyCheck(options());
    expect(unknownTier.verified).toBe(false);
    expect(unknownTier.reason).toContain('tier "Turbo" instead of "pro"');
  });

  test("after a cancel, page-side selection work finishes before the restore", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const cancellation = new BrowserCancellation(controller.signal);
    // The run's Runtime is the cancellation proxy: it stops waiting on abort, the page does not.
    const pageRuntime = {
      evaluate: vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              events.push("page selection finished");
              resolve({ result: { value: { status: "switched" } } });
            }, 300),
          ),
      ),
    };
    const runtime = cancellation.client({ Runtime: pageRuntime } as never).Runtime;
    picker.readModelPickerState.mockImplementation(async () => {
      events.push("read");
      return events.includes("page selection finished") ? PRO : MEDIUM;
    });
    picker.restoreModelPickerState.mockImplementation(async () => {
      events.push("restore");
      return { restored: true, state: MEDIUM };
    });
    await expect(
      cancellation.run(() =>
        runSelectOnlyCheck(
          options({
            runtime,
            applySelection: async (selectionRuntime = runtime) => {
              setTimeout(() => controller.abort(), 50);
              await selectionRuntime.evaluate({ expression: "select Pro" });
            },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(BrowserRunCancelledError);
    expect(events).toEqual(["read", "page selection finished", "read", "restore"]);
    picker.readModelPickerState.mockReset();
    picker.restoreModelPickerState.mockReset();
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

describe("select-only check with a maximum thinking time", () => {
  const EXTRA_HIGH = state("Extra High", 3);
  const capCheck = (status: "within" | "lowered") => ({
    maxLevel: "extra-high" as const,
    status,
    before: {
      modelLabel: "GPT-6",
      tierLabel: status === "lowered" ? "Pro" : "Medium",
      sliderValue: status === "lowered" ? 4 : 1,
      readable: true,
      source: "chatgpt-model-picker" as const,
      capturedAt: "now",
    },
    capturedAt: "now",
  });
  const capOptions = (overrides: Partial<Parameters<typeof runSelectOnlyCheck>[0]> = {}) =>
    options({
      requestedModel: null,
      requestedThinkingTime: null,
      maxThinkingTime: "extra-high",
      ...overrides,
    });

  test("runs the cap as a real run would, reports it and restores the previous tier", async () => {
    picker.readModelPickerState.mockResolvedValueOnce(PRO).mockResolvedValueOnce(EXTRA_HIGH);
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: PRO });
    const report = await runSelectOnlyCheck(
      capOptions({ readEvidence: () => ({ thinkingCap: capCheck("lowered") }) }),
    );
    expect(report).toMatchObject({
      verified: true,
      maxThinkingTime: "extra-high",
      thinkingCap: { status: "lowered", maxLevel: "extra-high" },
      selected: { tierLabel: "Extra High", sliderValue: 3 },
      restoreVerified: true,
    });
  });

  test("a selection that ends above the maximum is not verified", async () => {
    picker.readModelPickerState.mockResolvedValueOnce(MEDIUM).mockResolvedValueOnce(PRO);
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: MEDIUM });
    const report = await runSelectOnlyCheck(
      capOptions({ readEvidence: () => ({ thinkingCap: capCheck("within") }) }),
    );
    expect(report.verified).toBe(false);
    expect(report.reason).toMatch(/tier "Pro" above the maximum "extra-high"/);
  });

  test("a cap refusal is reported and the previous selection is still restored", async () => {
    picker.readModelPickerState.mockResolvedValueOnce(MEDIUM).mockResolvedValueOnce(PRO);
    picker.restoreModelPickerState.mockResolvedValue({ restored: true, state: MEDIUM });
    const report = await runSelectOnlyCheck(
      capOptions({
        applySelection: vi.fn(async () => {
          throw new Error("Thinking time: the picker still shows Pro; nothing was sent.");
        }),
        readEvidence: () => ({}),
      }),
    );
    expect(report.verified).toBe(false);
    expect(report.reason).toMatch(/still shows Pro/);
    expect(report.reason).not.toMatch(/was not checked/);
    expect(picker.restoreModelPickerState).toHaveBeenCalledTimes(1);
  });
});
