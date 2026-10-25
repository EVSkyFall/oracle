import { mkdtemp, readFile, rm, writeFile, link, rename, rmdir, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireBrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(actual.rm),
    rmdir: vi.fn(actual.rmdir),
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
  };
});

const LOCK = "oracle-tab-leases.lock";
const OWNER = "owner.json";
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

afterEach(() => {
  vi.mocked(rm).mockImplementation(actual.rm);
  vi.mocked(rmdir).mockImplementation(actual.rmdir);
  vi.mocked(link).mockImplementation(actual.link);
  vi.mocked(rename).mockImplementation(actual.rename);
});

// Another controller that is alive (this very process), as far as the registry can tell.
const foreignOwner = () =>
  `${JSON.stringify({ id: "controller-b", pid: process.pid, createdAt: new Date().toISOString() })}\n`;

test("a retried lock removal never deletes an owner record another controller published", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-lock-foreign-"));
  const lockDir = path.join(dir, LOCK);
  let injected = false;
  // The first removal attempt fails while controller B takes over the directory.
  const takeOver = async () => {
    injected = true;
    await actual.rm(path.join(lockDir, OWNER), { force: true });
    await actual.writeFile(path.join(lockDir, OWNER), foreignOwner());
    throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
  };
  try {
    const lease = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 5_000 });
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (!injected && String(target) === lockDir) return takeOver();
      return actual.rm(target, options);
    });
    vi.mocked(rmdir).mockImplementation(async (target) => {
      if (!injected && String(target) === lockDir) return takeOver();
      return actual.rmdir(target);
    });
    await lease.release().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(JSON.parse(await readFile(path.join(lockDir, OWNER), "utf8")).id).toBe("controller-b");
  } finally {
    vi.mocked(rm).mockImplementation(actual.rm);
    vi.mocked(rmdir).mockImplementation(actual.rmdir);
    await actual.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 30_000);

test.each(["EPERM", "EXDEV", "ENOTSUP"])(
  "a hard link failing with %s never overwrites another controller's owner",
  async (code) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-lock-nolink-"));
    const ownerPath = path.join(dir, LOCK, OWNER);
    // Controller B publishes at the moment our link fails (no hard links here).
    vi.mocked(link).mockImplementation(async (_source, destination) => {
      if (String(destination) === ownerPath) await writeFile(ownerPath, foreignOwner());
      throw Object.assign(new Error(`link ${code}`), { code });
    });
    try {
      await expect(
        acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 1_000 }),
      ).rejects.toThrow(/Timed out waiting for ChatGPT browser slot/);
      expect(JSON.parse(await readFile(ownerPath, "utf8")).id).toBe("controller-b");
    } finally {
      await actual.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  60_000,
);

test("without hard links the owner is still published, exclusively", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-lock-copy-"));
  vi.mocked(link).mockRejectedValue(Object.assign(new Error("link EXDEV"), { code: "EXDEV" }));
  try {
    const lease = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 5_000 });
    await lease.release();
    const again = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 5_000 });
    await again.release();
  } finally {
    await actual.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60_000);

test("a temporary owner file that cannot be deleted after publishing never blocks later runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-lock-tmp-"));
  const lockDir = path.join(dir, LOCK);
  let failTemporary = true;
  // Windows keeps our own .tmp busy (antivirus, indexer) while the lease is being acquired.
  vi.mocked(rm).mockImplementation(async (target, options) => {
    const file = String(target);
    if (failTemporary && file.startsWith(lockDir) && file.endsWith(".tmp")) {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }
    return actual.rm(target, options);
  });
  try {
    const lease = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 5_000 });
    failTemporary = false;
    await lease.release();
    const started = Date.now();
    const again = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    await again.release();
  } finally {
    vi.mocked(rm).mockImplementation(actual.rm);
    await actual.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60_000);

test("an ownerless lock that cannot be reclaimed is waited for, not retried in a tight loop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-lock-unknown-"));
  const lockDir = path.join(dir, LOCK);
  // A stale ownerless lock that holds a file this registry did not create.
  await actual.mkdir(lockDir);
  await actual.writeFile(path.join(lockDir, "notes.txt"), "not ours\n");
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lockDir, old, old);
  let lockRmdirs = 0;
  vi.mocked(rmdir).mockImplementation(async (target) => {
    if (String(target) === lockDir) lockRmdirs += 1;
    return actual.rmdir(target);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    await acquireBrowserTabLease(dir, {
      maxConcurrentTabs: 2,
      timeoutMs: 30_000,
      signal: controller.signal,
    }).catch(() => undefined);
    // The normal wait polls every 50 ms; a tight loop retries the reclaim as fast as it can.
    expect(lockRmdirs).toBeLessThanOrEqual(30);
    expect(await readFile(path.join(lockDir, "notes.txt"), "utf8")).toBe("not ours\n");
  } finally {
    clearTimeout(timer);
    await actual.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60_000);

test("two controllers can never both publish an owner into the same lock directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-lock-publish-"));
  const ownerPath = path.join(dir, LOCK, OWNER);
  let injected = false;
  // Controller B publishes into the directory at the moment this controller publishes.
  const publishFirst = async () => {
    if (injected) return;
    injected = true;
    await writeFile(ownerPath, foreignOwner());
  };
  vi.mocked(link).mockImplementation(async (source, destination) => {
    if (String(destination) === ownerPath) await publishFirst();
    return actual.link(source, destination);
  });
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    if (String(destination) === ownerPath) await publishFirst();
    return actual.rename(source, destination);
  });
  try {
    await expect(
      acquireBrowserTabLease(dir, { maxConcurrentTabs: 2, timeoutMs: 1_000 }),
    ).rejects.toThrow(/Timed out waiting for ChatGPT browser slot/);
    expect(JSON.parse(await readFile(ownerPath, "utf8")).id).toBe("controller-b");
  } finally {
    await actual.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60_000);
