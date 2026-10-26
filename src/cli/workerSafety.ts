import { appendFileSync } from "node:fs";

const describe = (reason: unknown): string => {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  try {
    return typeof reason === "string" ? reason : (JSON.stringify(reason) ?? String(reason));
  } catch {
    return String(reason);
  }
};

/**
 * Keeps a detached `--exec-session` worker from dying without a trace.
 *
 * - A promise rejection nobody handles is written, with its stack, to the session's output log,
 *   and the worker goes on: such a rejection comes from a background check (a monitor, a
 *   heartbeat, a cleanup) and is never a reason to lose the run, which Node's default (exit with
 *   code 1) would.
 * - An uncaught exception is written, with its stack, to the output log and to stderr (the
 *   worker's log), and the worker then exits as Node always does: the monitor hook does not
 *   change that, nor any exit code on normal paths.
 *
 * Writes are synchronous so that they land before the process exits.
 */
export function installDetachedWorkerHandlers(options: {
  outputLogPath: string;
  writeStderr?: (text: string) => void;
  now?: () => Date;
}): () => void {
  const now = options.now ?? (() => new Date());
  const writeStderr =
    options.writeStderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const toOutputLog = (text: string) => {
    try {
      appendFileSync(options.outputLogPath, text, "utf8");
    } catch {
      // the stderr copy (worker.log) still carries it
    }
  };
  const onRejection = (reason: unknown) => {
    toOutputLog(
      `[${now().toISOString()}] [worker] Unhandled promise rejection; the run goes on: ${describe(reason)}\n`,
    );
  };
  const onUncaught = (error: unknown, origin: string) => {
    const text = `[${now().toISOString()}] [worker] Uncaught exception (${origin}); the worker exits: ${describe(error)}\n`;
    toOutputLog(text);
    try {
      writeStderr(text);
    } catch {
      // nothing left to report to
    }
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtExceptionMonitor", onUncaught);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtExceptionMonitor", onUncaught);
  };
}
