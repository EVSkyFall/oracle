import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { sessionStore } from "../sessionStore.js";

const CANCELLATION_MARKER = ".cancel-requested";
/** The detached worker's stdout and stderr, appended in its session directory. */
export const DETACHED_WORKER_LOG = "worker.log";

/**
 * Opens the worker's log for appending and marks where this worker's output starts. Returns
 * null when it cannot be opened: the worker then starts with its output discarded, as before.
 */
export function openDetachedWorkerLog(
  logPath: string,
  sessionId: string,
  now: Date = new Date(),
): number | null {
  let fd: number;
  try {
    fd = openSync(logPath, "a", 0o600);
  } catch {
    return null;
  }
  try {
    writeSync(
      fd,
      `[${now.toISOString()}] oracle worker for session ${sessionId}; its output follows
`,
    );
  } catch {
    // the log is still usable for the worker's own output
  }
  return fd;
}

function defaultDetachedWorkerLogPath(sessionId: string): string | null {
  try {
    return path.join(sessionStore.sessionsDir(), sessionId, DETACHED_WORKER_LOG);
  } catch {
    return null;
  }
}

export function detachedSessionCancellationPath(sessionDir: string, workerPid: number): string {
  return path.join(sessionDir, `${CANCELLATION_MARKER}-${workerPid}`);
}

export async function requestDetachedSessionCancellation(markerPath: string): Promise<void> {
  await writeFile(markerPath, "cancel\n", "utf8");
}

export async function clearDetachedSessionCancellation(markerPath: string): Promise<void> {
  await rm(markerPath, { force: true });
}

export async function waitForDetachedSessionCancellation({
  markerPath,
  signal,
  pollIntervalMs = 100,
  accessFile = access,
  onCheckFailed,
}: {
  markerPath: string;
  signal: AbortSignal;
  pollIntervalMs?: number;
  accessFile?: (path: string) => Promise<void>;
  /** Called once per distinct failure of the marker check other than "not there". */
  onCheckFailed?: (error: unknown) => void;
}): Promise<boolean> {
  const reported = new Set<string>();
  while (!signal.aborted) {
    try {
      await accessFile(markerPath);
      return true;
    } catch (error) {
      // "Not there" is the normal answer. Any other failure (a transient EPERM or EBUSY while
      // the session directory is busy) is checked again on the next poll: over a run of hours
      // this check runs tens of thousands of times, and one failure must never end the run.
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        const key =
          error instanceof Error
            ? `${(error as NodeJS.ErrnoException).code ?? ""}:${error.message}`
            : String(error);
        if (!reported.has(key)) {
          reported.add(key);
          onCheckFailed?.(error);
        }
      }
    }
    try {
      await delay(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (signal.aborted && error instanceof Error && error.name === "AbortError") {
        return false;
      }
      throw error;
    }
  }
  return false;
}

export interface DetachedSessionSpawnSpec {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export interface LaunchDetachedSessionOptions {
  sessionId: string;
  /**
   * Where the worker's stdout and stderr are appended (default: worker.log in the session
   * directory); null discards them.
   */
  workerLogPath?: string | null;
  cliEntrypoint?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  prepare: (pid: number) => Promise<void>;
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

export function resolveOracleCliEntrypoint(moduleUrl: string = import.meta.url): string {
  const extension = fileURLToPath(moduleUrl).endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`../../bin/oracle-cli.${extension}`, moduleUrl));
}

export function buildDetachedSessionSpawnSpec({
  sessionId,
  cliEntrypoint = resolveOracleCliEntrypoint(),
  env = process.env,
  nodeExecutable = process.execPath,
  output,
}: Omit<LaunchDetachedSessionOptions, "prepare" | "spawnProcess" | "workerLogPath"> & {
  /** An open file descriptor for the worker's stdout and stderr; without one they are discarded. */
  output?: number | null;
}): DetachedSessionSpawnSpec {
  const sink = typeof output === "number" ? output : "ignore";
  return {
    command: nodeExecutable,
    args: ["--", cliEntrypoint, "--exec-session", sessionId],
    options: {
      detached: true,
      stdio: ["pipe", sink, sink],
      env: {
        ...env,
        ORACLE_DETACHED_START_GATE: "1",
      },
      windowsHide: true,
    },
  };
}

export function launchDetachedSession({
  sessionId,
  cliEntrypoint,
  env,
  nodeExecutable,
  workerLogPath,
  prepare,
  spawnProcess = spawn,
}: LaunchDetachedSessionOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    // Without its output a worker that dies leaves no trace; a log that cannot be opened never
    // keeps the worker from starting.
    const logPath =
      workerLogPath === undefined ? defaultDetachedWorkerLogPath(sessionId) : workerLogPath;
    const output = logPath ? openDetachedWorkerLog(logPath, sessionId) : null;
    try {
      const spec = buildDetachedSessionSpawnSpec({
        sessionId,
        cliEntrypoint,
        env,
        nodeExecutable,
        output,
      });
      child = spawnProcess(spec.command, spec.args, spec.options);
    } catch (error) {
      reject(error);
      return;
    } finally {
      // The child holds its own copy of the descriptor once spawned.
      if (output !== null) {
        try {
          closeSync(output);
        } catch {
          // already closed
        }
      }
    }

    child.once("error", reject);
    child.once("spawn", async () => {
      if (child.pid === undefined) {
        child.kill();
        reject(new Error("Detached session worker started without a process ID."));
        return;
      }
      try {
        await prepare(child.pid);
        if (!child.stdin) {
          throw new Error("Detached session worker started without a writable start gate.");
        }
        const startGate = child.stdin;
        await new Promise<void>((resolveGate, rejectGate) => {
          startGate.once("error", rejectGate);
          startGate.end("ready\n", (error?: Error) => {
            if (error) rejectGate(error);
            else resolveGate();
          });
        });
        child.unref();
        resolve(child.pid);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
  });
}
