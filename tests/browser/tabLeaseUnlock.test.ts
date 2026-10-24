import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
} from "../../src/browser/tabLeaseRegistry.js";
import { __test__ as browserIndex } from "../../src/browser/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm), rmdir: vi.fn(actual.rmdir) };
});

const LOCK_DIRNAME = "oracle-tab-leases.lock";

async function restoreFsMocks() {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rm).mockImplementation(actual.rm);
  vi.mocked(rmdir).mockImplementation(actual.rmdir);
}

afterEach(restoreFsMocks);

/**
 * Windows reported ENOTEMPTY while another handle kept the deleted owner.json "delete
 * pending": the owner record is gone but the lock directory cannot be removed until that
 * handle closes. `stillOpen` says whether the other handle is still open.
 */
async function simulateDeletePendingOwner(stillOpen: () => boolean) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const isLockDir = (target: unknown) => String(target).endsWith(LOCK_DIRNAME);
  const notEmpty = () => Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
  vi.mocked(rm).mockImplementation(async (target, options) => {
    if (isLockDir(target) && stillOpen()) {
      await actual.rm(path.join(String(target), "owner.json"), { force: true });
      throw notEmpty();
    }
    return actual.rm(target, options);
  });
  vi.mocked(rmdir).mockImplementation(async (target) => {
    if (isLockDir(target) && stillOpen()) throw notEmpty();
    return actual.rmdir(target);
  });
}

test("retries ENOTEMPTY while removing the registry lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-unlock-retry-"));
  let failures = 0;
  await simulateDeletePendingOwner(() => {
    failures += 1;
    return failures <= 3;
  });
  try {
    const lease = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 5_000 });
    await lease.release();
    expect(failures).toBeGreaterThan(3);
    expect(existsSync(path.join(dir, LOCK_DIRNAME))).toBe(false);
  } finally {
    await restoreFsMocks();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);

test("a lock directory that outlives the unlock retries fails neither the release nor later runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-unlock-stuck-"));
  // Longer than the whole foreground retry budget of one unlock.
  const handleClosesAt = Date.now() + 6_000;
  await simulateDeletePendingOwner(() => Date.now() < handleClosesAt);
  try {
    const first = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 5_000 });
    await expect(first.release()).resolves.toBeUndefined();
    const registry = JSON.parse(await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"));
    expect(registry.leases).toEqual([]);
    const second = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 30_000 });
    await second.release();
    // The background removal finishes once the other handle has closed.
    const deadline = Date.now() + 20_000;
    while (existsSync(path.join(dir, LOCK_DIRNAME)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(path.join(dir, LOCK_DIRNAME))).toBe(false);
  } finally {
    await restoreFsMocks();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);

test("reclaims an empty ownerless lock after a few seconds but leaves a fresh one alone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-unlock-reclaim-"));
  const lockDir = path.join(dir, LOCK_DIRNAME);
  try {
    await mkdir(lockDir);
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    await utimes(lockDir, tenSecondsAgo, tenSecondsAgo);
    const startedAt = Date.now();
    const lease = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 1, timeoutMs: 10_000 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await lease.release();

    // A just-created empty directory may belong to a controller about to publish its owner.
    await mkdir(lockDir);
    const blocked = acquireBrowserTabLease(dir, { maxConcurrentTabs: 1, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(lockDir)).toBe(true);
    const lease2 = await blocked;
    await lease2.release();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);

test("probes stale lease identities before taking the registry lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-probe-outside-lock-"));
  try {
    const stale = {
      id: "stale-foreign",
      pid: 424_242,
      processStartedAtMs: 1_000,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    await writeFile(
      path.join(dir, "oracle-tab-leases.json"),
      JSON.stringify({ version: 1, leases: [stale] }),
    );
    const lockHeldDuringProbe: boolean[] = [];
    const deps = {
      isProcessAlive: () => false,
      readProcessStartTimeMs: async (pid: number) => {
        if (pid === stale.pid) {
          lockHeldDuringProbe.push(existsSync(path.join(dir, LOCK_DIRNAME)));
          return null;
        }
        return 5_000;
      },
    };
    const lease = await acquireBrowserTabLease(
      dir,
      { maxConcurrentTabs: 1, timeoutMs: 5_000 },
      deps,
    );
    expect(lockHeldDuringProbe.length).toBeGreaterThan(0);
    expect(lockHeldDuringProbe.every((held) => !held)).toBe(true);
    expect(await hasOtherActiveBrowserTabLeases(dir, lease.id, deps)).toBe(false);
    await lease.release();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);

test("a slot release failure after a captured answer becomes a run warning", () => {
  const logger = vi.fn();
  const result = {
    answerText: "done",
    answerMarkdown: "done",
    tookMs: 1,
    answerTokens: 1,
    answerChars: 4,
  };
  browserIndex.recordBrowserSlotReleaseWarning(result, new Error("lock busy"), logger);
  expect(result).toMatchObject({
    warnings: [{ code: "browser-slot-release-failed", severity: "warning" }],
  });
  expect(logger).toHaveBeenCalledWith(
    expect.stringContaining("Warning: ChatGPT browser slot release failed"),
  );
});
