import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { acquireBrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";

const DEAD_WORKER = 4101;
const HARVEST = 7777;
const NEW_RUN = 8888;
const leaseDeps = (pid: number) => ({
  pid,
  // The dead worker is gone; every other pid lives with its recorded start time.
  isProcessAlive: (candidate: number) => candidate !== DEAD_WORKER,
  readProcessStartTimeMs: async (candidate: number) => (candidate === DEAD_WORKER ? null : 1_000),
});
const quiet = () => Object.assign(vi.fn(), { verbose: false });

let profileDir = "";
beforeEach(async () => {
  vi.resetModules();
  profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-harvest-slot-"));
});
afterEach(async () => {
  vi.doUnmock("../../src/sessionStore.js");
  vi.doUnmock("../../src/browser/recoveryTarget.js");
  // Windows: the registry's lock and temp files can still be pending deletion under load.
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function session(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return {
    id: "sess-a",
    status: "completed",
    mode: "browser",
    browser: {
      config: { manualLogin: true, manualLoginProfileDir: profileDir, ...config },
      runtime: { chromePid: 100960, chromePort: 55232, userDataDir: profileDir },
    },
    ...overrides,
  };
}

async function load(meta: unknown, controllerAlive = false) {
  vi.doMock("../../src/sessionStore.js", () => ({
    sessionStore: { readSession: async () => meta },
  }));
  vi.doMock("../../src/browser/recoveryTarget.js", () => ({
    hasOtherLiveBrowserController: () => controllerAlive,
  }));
  return import("../../src/cli/harvestChromeRelease.js");
}

const registryLeases = async () =>
  JSON.parse(await readFile(path.join(profileDir, "oracle-tab-leases.json"), "utf8"))
    .leases as Array<{
    id: string;
    sessionId?: string;
  }>;

describe("the harvest's browser slot", () => {
  test("takes over the slot of the session's own dead worker, and leaves another session's slot", async () => {
    const now = new Date().toISOString();
    const lease = (id: string, pid: number, sessionId: string) => ({
      id,
      pid,
      processStartedAtMs: 1_000,
      sessionId,
      createdAt: now,
      updatedAt: now,
    });
    await writeFile(
      path.join(profileDir, "oracle-tab-leases.json"),
      JSON.stringify({
        version: 1,
        leases: [lease("dead-own", DEAD_WORKER, "sess-a"), lease("other", NEW_RUN, "sess-b")],
      }),
    );
    const meta = session();
    const { takeHarvestSlot, releaseHarvestSlot } = await load(meta);
    const slot = await takeHarvestSlot(meta as never, quiet(), { leaseDeps: leaseDeps(HARVEST) });
    expect(slot?.userDataDir).toBe(profileDir);
    expect((await registryLeases()).map((entry) => entry.id).sort()).toEqual(
      [slot!.lease.id, "other"].sort(),
    );
    await releaseHarvestSlot(slot, "sess-a", false, quiet());
    expect((await registryLeases()).map((entry) => entry.id)).toEqual(["other"]);
  });

  test("is never taken on a Chrome the user attached", async () => {
    for (const config of [
      { attachRunning: true },
      { remoteChrome: { host: "10.0.0.2", port: 9222 } },
    ]) {
      const meta = session({}, config);
      const { takeHarvestSlot } = await load(meta);
      expect(await takeHarvestSlot(meta as never, quiet(), { leaseDeps: leaseDeps(HARVEST) })).toBe(
        null,
      );
    }
  });
});

describe("releasing the session's Chrome with the harvest's slot", () => {
  test("closes it when this was the last slot and the session's run is over", async () => {
    const meta = session();
    const { takeHarvestSlot, releaseHarvestSlot } = await load(meta);
    const slot = await takeHarvestSlot(meta as never, quiet(), { leaseDeps: leaseDeps(HARVEST) });
    const terminate = vi.fn(async () => true);
    await expect(releaseHarvestSlot(slot, "sess-a", true, quiet(), { terminate })).resolves.toBe(
      true,
    );
    expect(terminate).toHaveBeenCalledWith(profileDir, expect.any(Function));
  });

  test("a run that took a slot before the decision keeps its Chrome", async () => {
    const meta = session();
    const { takeHarvestSlot, releaseHarvestSlot } = await load(meta);
    const slot = await takeHarvestSlot(meta as never, quiet(), { leaseDeps: leaseDeps(HARVEST) });
    const newRun = await acquireBrowserTabLease(
      profileDir,
      { sessionId: "sess-new", timeoutMs: 5_000 },
      leaseDeps(NEW_RUN),
    );
    const terminate = vi.fn(async () => true);
    await expect(releaseHarvestSlot(slot, "sess-a", true, quiet(), { terminate })).resolves.toBe(
      false,
    );
    expect(terminate).not.toHaveBeenCalled();
    await newRun.release();
  });

  test("a run taking a slot while the Chrome is being closed waits until the close is done", async () => {
    const meta = session();
    const { takeHarvestSlot, releaseHarvestSlot } = await load(meta);
    const slot = await takeHarvestSlot(meta as never, quiet(), { leaseDeps: leaseDeps(HARVEST) });
    const events: string[] = [];
    let newRun: Promise<{ release: () => Promise<void> }> | null = null;
    const terminate = vi.fn(async () => {
      // A new run starts right between the last-slot decision and the termination.
      newRun = acquireBrowserTabLease(
        profileDir,
        { sessionId: "sess-new", timeoutMs: 10_000, pollMs: 50 },
        leaseDeps(NEW_RUN),
      ).then((lease) => {
        events.push("new run has its slot");
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      events.push("chrome terminated");
      return true;
    });
    await releaseHarvestSlot(slot, "sess-a", true, quiet(), { terminate });
    const lease = await newRun!;
    // Its slot came only after the termination: it launches its own Chrome, never loses it.
    expect(events).toEqual(["chrome terminated", "new run has its slot"]);
    await lease.release();
  });

  test.each([
    ["nothing was saved", session(), false, false],
    ["the session's controller still runs", session(), true, true],
    ["the session keeps its browser", session({}, { keepBrowser: true }), true, false],
    ["the answer was not saved as completed", session({ status: "running" }), true, false],
  ])("leaves it running when %s", async (_label, meta, mayClose, controllerAlive) => {
    const { takeHarvestSlot, releaseHarvestSlot } = await load(meta, controllerAlive);
    const slot = await takeHarvestSlot(meta as never, quiet(), { leaseDeps: leaseDeps(HARVEST) });
    const terminate = vi.fn(async () => true);
    await expect(
      releaseHarvestSlot(slot, "sess-a", mayClose, quiet(), { terminate }),
    ).resolves.toBe(false);
    expect(terminate).not.toHaveBeenCalled();
  });
});
