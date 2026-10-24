import { mkdtemp, readFile, rm, writeFile, link, rename, rmdir } from "node:fs/promises";
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
