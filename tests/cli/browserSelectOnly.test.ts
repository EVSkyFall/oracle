import { describe, expect, test, vi } from "vitest";
import { runBrowserSelectOnly, SELECT_ONLY_EXIT } from "../../src/cli/browserSelectOnly.js";
import type { BrowserRunResult, BrowserSelectOnlyReport } from "../../src/browser/types.js";
import { shouldRequirePrompt } from "../../src/cli/promptRequirement.js";

const baseReport: BrowserSelectOnlyReport = {
  verified: true,
  requestedModel: "GPT-6",
  requestedThinkingTime: "pro",
  before: null,
  selected: null,
  restored: null,
  restoreVerified: true,
};

function runWith(report: BrowserSelectOnlyReport | undefined) {
  return vi.fn(async (): Promise<BrowserRunResult> => ({
    answerText: "",
    answerMarkdown: "",
    tookMs: 1,
    answerTokens: 0,
    answerChars: 0,
    ...(report ? { selectOnly: report } : {}),
  }));
}

describe("--browser-select-only", () => {
  test("runs the browser with selectOnly and no prompt, and maps the report to exit codes", async () => {
    const log = vi.fn();
    const run = runWith(baseReport);
    const code = await runBrowserSelectOnly({
      browserConfig: { desiredModel: "GPT-6", thinkingTime: "pro" },
      model: "gpt-6-pro",
      verbose: false,
      log,
      run,
    });
    expect(code).toBe(SELECT_ONLY_EXIT.ok);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "",
        model: "gpt-6-pro",
        config: expect.objectContaining({ selectOnly: true, desiredModel: "GPT-6" }),
      }),
    );

    const notVerified = await runBrowserSelectOnly({
      browserConfig: {},
      model: "gpt-6-pro",
      verbose: false,
      log,
      run: runWith({ ...baseReport, verified: false, reason: "Pro unavailable" }),
    });
    expect(notVerified).toBe(SELECT_ONLY_EXIT.unverified);

    const notRestored = await runBrowserSelectOnly({
      browserConfig: {},
      model: "gpt-6-pro",
      verbose: false,
      log,
      run: runWith({ ...baseReport, restoreVerified: false, restoreDetail: "slider stuck" }),
    });
    expect(notRestored).toBe(SELECT_ONLY_EXIT.restoreFailed);
    expect(log.mock.calls.some(([line]) => String(line).includes("slider stuck"))).toBe(true);

    expect(
      await runBrowserSelectOnly({
        browserConfig: {},
        model: "gpt-6",
        verbose: false,
        log,
        run: runWith(undefined),
      }),
    ).toBe(SELECT_ONLY_EXIT.unverified);
  });

  test("does not require a prompt", () => {
    expect(
      shouldRequirePrompt(["--engine", "browser", "--browser-select-only"], {
        browserSelectOnly: true,
      }),
    ).toBe(false);
    expect(shouldRequirePrompt(["--engine", "browser"], {})).toBe(true);
  });
});
