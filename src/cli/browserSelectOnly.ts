import chalk from "chalk";
import type { BrowserSessionConfig } from "../sessionManager.js";
import type { BrowserLogger, BrowserRunOptions, BrowserRunResult } from "../browser/types.js";

/** Exit codes: the selection was verified and restored / not verified / verified but not restored. */
export const SELECT_ONLY_EXIT = { ok: 0, unverified: 1, restoreFailed: 2 } as const;

/**
 * Runs a select-only check: the requested model and thinking time are selected and verified
 * like a real run, the previous selection is restored and the tab is closed. Nothing is sent.
 */
export async function runBrowserSelectOnly({
  browserConfig,
  model,
  verbose,
  log,
  run,
}: {
  browserConfig: BrowserSessionConfig;
  model: string;
  verbose: boolean;
  log: (message: string) => void;
  run?: (options: BrowserRunOptions) => Promise<BrowserRunResult>;
}): Promise<number> {
  const logger = ((message?: string) => {
    if (typeof message !== "string") return;
    const alwaysPrint =
      message.startsWith("[browser] ") &&
      /select-only|model picker|model selection|thinking|manual login|waiting for chatgpt|browser slot|retry/i.test(
        message,
      );
    if (verbose || alwaysPrint || message.startsWith("Model picker:")) log(message);
  }) as BrowserLogger;
  logger.verbose = verbose;
  const runBrowserMode = run ?? (await import("../browser/index.js")).runBrowserMode;
  log(chalk.dim("Select-only check: selecting and verifying without sending anything."));
  const result = await runBrowserMode({
    prompt: "",
    model,
    config: { ...browserConfig, selectOnly: true },
    log: logger,
    verbose,
    closeOwnedTabOnCancel: !browserConfig.keepBrowser,
  });
  const report = result.selectOnly;
  if (!report) {
    log(chalk.red("Select-only check: the browser run returned no selection report."));
    return SELECT_ONLY_EXIT.unverified;
  }
  if (report.verified && report.restoreVerified) {
    log(chalk.green("Select-only check: verified and restored; nothing was sent."));
    return SELECT_ONLY_EXIT.ok;
  }
  if (!report.verified) {
    log(chalk.red(`Select-only check: NOT verified (${report.reason ?? "unknown reason"}).`));
  }
  if (!report.restoreVerified) {
    log(
      chalk.red(
        `Select-only check: the previous model/effort could not be confirmed as restored (${report.restoreDetail ?? "unknown"}); check the ChatGPT model picker before the next run.`,
      ),
    );
  }
  return report.verified ? SELECT_ONLY_EXIT.restoreFailed : SELECT_ONLY_EXIT.unverified;
}
