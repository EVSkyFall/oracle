import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "cli", "workerSafety.ts")).href;

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "oracle-worker-safety-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs `body` in a fresh Node process with the worker handlers installed (unless `bare`). */
async function runWorker(body: string, options: { bare?: boolean } = {}) {
  const script = path.join(dir, "worker.mts");
  const outputLog = path.join(dir, "output.log");
  await writeFile(
    script,
    `${options.bare ? "" : `import { installDetachedWorkerHandlers } from ${JSON.stringify(moduleUrl)};\ninstallDetachedWorkerHandlers({ outputLogPath: ${JSON.stringify(outputLog)} });\n`}${body}\n`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  const log = await readFile(outputLog, "utf8").catch(() => "");
  return { code, stdout, stderr, log };
}

describe("the detached worker's crash handlers", () => {
  test("a stray promise rejection is logged with its stack and the worker goes on", async () => {
    const body = `
      Promise.reject(new Error("stray rejection from a monitor"));
      setTimeout(() => console.log("still running"), 100);`;
    // Without the handlers, Node ends the worker on it (exit 1) and says so only on stderr.
    const bare = await runWorker(body, { bare: true });
    expect(bare.code).toBe(1);
    expect(bare.stdout).not.toContain("still running");

    const guarded = await runWorker(body);
    expect(guarded.code).toBe(0);
    expect(guarded.stdout).toContain("still running");
    expect(guarded.log).toMatch(
      /\[worker\] Unhandled promise rejection; the run goes on: Error: stray rejection from a monitor\n\s+at /,
    );
  }, 60_000);

  test("an uncaught exception is logged with its stack to the output log and stderr, and the worker exits as Node does", async () => {
    const { code, stdout, stderr, log } = await runWorker(`
      setTimeout(() => { throw new Error("listener blew up"); }, 10);
      setTimeout(() => console.log("never"), 300);`);
    expect(code).toBe(1);
    expect(stdout).not.toContain("never");
    expect(log).toMatch(
      /\[worker\] Uncaught exception \(uncaughtException\); the worker exits: Error: listener blew up\n\s+at /,
    );
    expect(stderr).toContain("[worker] Uncaught exception (uncaughtException); the worker exits");
    // Node's own report follows, as before.
    expect(stderr.split("listener blew up").length - 1).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("normal exit codes are unchanged", async () => {
    const { code, log } = await runWorker(`process.exitCode = 3;`);
    expect(code).toBe(3);
    expect(log).toBe("");
  }, 60_000);

  test("the worker installs them once its session log exists, before the run starts", async () => {
    const source = await readFile(path.join(process.cwd(), "bin", "oracle-cli.ts"), "utf8");
    const worker = source.slice(source.indexOf("async function executeSession("));
    const install = worker.indexOf(
      "installDetachedWorkerHandlers({ outputLogPath: writer.logPath })",
    );
    expect(install).toBeGreaterThan(worker.indexOf("writer = sessionStore.createLogWriter"));
    expect(install).toBeLessThan(worker.indexOf("await performSessionRun("));
  });
});
