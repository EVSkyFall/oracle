import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  buildDetachedSessionSpawnSpec,
  openDetachedWorkerLog,
  clearDetachedSessionCancellation,
  detachedSessionCancellationPath,
  launchDetachedSession,
  requestDetachedSessionCancellation,
  resolveOracleCliEntrypoint,
  waitForDetachedSessionCancellation,
} from "../../src/cli/detachedSession.js";

describe("detached session launcher", () => {
  test("observes a cancellation requested before the worker starts waiting", async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "oracle-cancel-marker-"));
    const markerPath = detachedSessionCancellationPath(sessionDir, 4242);
    const stop = new AbortController();

    try {
      await requestDetachedSessionCancellation(markerPath);
      await expect(
        waitForDetachedSessionCancellation({ markerPath, signal: stop.signal, pollIntervalMs: 1 }),
      ).resolves.toBe(true);
      await clearDetachedSessionCancellation(markerPath);
      expect(detachedSessionCancellationPath(sessionDir, 4243)).not.toBe(markerPath);
      await expect(
        waitForDetachedSessionCancellation({ markerPath, signal: AbortSignal.abort() }),
      ).resolves.toBe(false);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("uses a hidden detached Node child with a gated session handoff", () => {
    const spec = buildDetachedSessionSpawnSpec({
      sessionId: "long-pro-session",
      cliEntrypoint: "C:\\oracle\\dist\\bin\\oracle-cli.js",
      env: { EXISTING: "1" },
      nodeExecutable: "C:\\node\\node.exe",
    });

    expect(spec).toMatchObject({
      command: "C:\\node\\node.exe",
      args: ["--", "C:\\oracle\\dist\\bin\\oracle-cli.js", "--exec-session", "long-pro-session"],
      options: {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        env: {
          EXISTING: "1",
          ORACLE_DETACHED_START_GATE: "1",
        },
      },
    });
  });

  test("resolves the built CLI next to the dist source tree", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "dist", "src", "cli", "detachedSession.js"),
    ).href;
    expect(resolveOracleCliEntrypoint(moduleUrl)).toBe(
      path.join(process.cwd(), "dist", "bin", "oracle-cli.js"),
    );
  });

  test("opens the start gate only after durable lifecycle preparation", async () => {
    const stdin = new PassThrough();
    const written: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => written.push(chunk));
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin,
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const prepare = vi.fn(async () => undefined);
    const spawnProcess = vi.fn(() => child);

    const launched = launchDetachedSession({
      sessionId: "long-pro-session",
      prepare,
      spawnProcess,
    });
    child.emit("spawn");

    await expect(launched).resolves.toBe(4242);
    expect(prepare).toHaveBeenCalledWith(4242);
    expect(Buffer.concat(written).toString("utf8")).toBe("ready\n");
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("rejects a failed start gate without an unhandled stream error", async () => {
    const brokenPipe = Object.assign(new Error("start gate closed"), { code: "EPIPE" });
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(brokenPipe);
      },
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin,
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const launched = launchDetachedSession({
      sessionId: "failed-gate",
      prepare: async () => undefined,
      spawnProcess: () => child,
    });
    const rejection = expect(launched).rejects.toBe(brokenPipe);
    child.emit("spawn");
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  test("the worker's stdout and stderr are appended to its log instead of being discarded", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-worker-log-"));
    const logPath = path.join(dir, "worker.log");
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdin: new PassThrough(),
        unref: vi.fn(),
        kill: vi.fn(),
      }) as unknown as ChildProcess;
      const spawnProcess = vi.fn(() => child);
      const launched = launchDetachedSession({
        sessionId: "long-pro-session",
        workerLogPath: logPath,
        prepare: async () => undefined,
        spawnProcess,
      });
      child.emit("spawn");
      await expect(launched).resolves.toBe(4242);
      const stdio = (
        spawnProcess.mock.calls[0] as unknown as [string, string[], { stdio: unknown[] }]
      )[2].stdio;
      expect(stdio[0]).toBe("pipe");
      expect(typeof stdio[1]).toBe("number");
      expect(stdio[2]).toBe(stdio[1]);
      expect(await readFile(logPath, "utf8")).toMatch(
        /^\[\d{4}-\d\d-\d\dT[^\]]+\] oracle worker for session long-pro-session; its output follows\n$/,
      );

      // A real child writes through such a descriptor, appended after earlier runs.
      const fd = openDetachedWorkerLog(logPath, "second-run");
      const spec = buildDetachedSessionSpawnSpec({
        sessionId: "second-run",
        cliEntrypoint: "unused",
        output: fd,
      });
      const real = spawn(
        process.execPath,
        ["-e", "console.log('to stdout'); console.error('to stderr')"],
        {
          ...spec.options,
          stdio: ["ignore", spec.options.stdio![1], spec.options.stdio![2]],
        } as never,
      );
      await new Promise((resolve) => real.once("exit", resolve));
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("oracle worker for session long-pro-session");
      expect(log).toContain("oracle worker for session second-run");
      expect(log).toContain("to stdout");
      expect(log).toContain("to stderr");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a worker log that cannot be opened never keeps the worker from starting", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4243,
      stdin: new PassThrough(),
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => child);
    const launched = launchDetachedSession({
      sessionId: "no-log",
      workerLogPath: path.join(
        os.tmpdir(),
        "oracle-missing-dir-" + Date.now(),
        "nested",
        "worker.log",
      ),
      prepare: async () => undefined,
      spawnProcess,
    });
    child.emit("spawn");
    await expect(launched).resolves.toBe(4243);
    const stdio = (
      spawnProcess.mock.calls[0] as unknown as [string, string[], { stdio: unknown[] }]
    )[2].stdio;
    expect(stdio).toEqual(["pipe", "ignore", "ignore"]);
  });
});
