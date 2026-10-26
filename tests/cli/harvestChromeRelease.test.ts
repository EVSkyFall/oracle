import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hasOtherBrowserTabUsers } from "../../src/browser/tabLeaseRegistry.js";

const DEAD_WORKER = 4101;
const OTHER_RUN = 5202;
const liveness = {
  // The dead worker is gone; every other pid lives with its recorded start time.
  isProcessAlive: (pid: number) => pid !== DEAD_WORKER,
  readProcessStartTimeMs: async (pid: number) => (pid === DEAD_WORKER ? null : 1_000),
};

function lease(id: string, pid: number, sessionId: string) {
  const now = new Date().toISOString();
  return { id, pid, processStartedAtMs: 1_000, sessionId, createdAt: now, updatedAt: now };
}

describe("who else uses a session's Chrome after its worker died", () => {
  let profileDir = "";
  beforeEach(async () => {
    profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-harvest-release-"));
  });
  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });
  const writeLeases = (leases: unknown[]) =>
    writeFile(
      path.join(profileDir, "oracle-tab-leases.json"),
      JSON.stringify({ version: 1, leases }),
    );

  test("the session's own dead worker is no user: its fresh lease is dropped", async () => {
    await writeLeases([lease("dead", DEAD_WORKER, "sess-a")]);
    await expect(hasOtherBrowserTabUsers(profileDir, "sess-a", liveness)).resolves.toBe(false);
    const registry = JSON.parse(
      await readFile(path.join(profileDir, "oracle-tab-leases.json"), "utf8"),
    );
    expect(registry.leases).toEqual([]);
  });

  test("another run's lease keeps the Chrome in use", async () => {
    await writeLeases([lease("dead", DEAD_WORKER, "sess-a"), lease("other", OTHER_RUN, "sess-b")]);
    await expect(hasOtherBrowserTabUsers(profileDir, "sess-a", liveness)).resolves.toBe(true);
  });

  test("the session's own lease counts while its process lives", async () => {
    await writeLeases([lease("alive", OTHER_RUN, "sess-a")]);
    await expect(hasOtherBrowserTabUsers(profileDir, "sess-a", liveness)).resolves.toBe(true);
  });

  test("another session's dead but fresh lease still counts (only a missed heartbeat drops it)", async () => {
    await writeLeases([lease("foreign-dead", DEAD_WORKER, "sess-b")]);
    await expect(hasOtherBrowserTabUsers(profileDir, "sess-a", liveness)).resolves.toBe(true);
  });
});

describe("releasing a harvested session's Chrome", () => {
  const session = (overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) =>
    ({
      id: "sess-a",
      status: "completed",
      mode: "browser",
      browser: {
        config: { manualLogin: true, manualLoginProfileDir: "/profiles/oracle", ...config },
        runtime: {
          chromePid: 100960,
          chromePort: 55232,
          userDataDir: "/profiles/oracle",
          controllerPid: DEAD_WORKER,
        },
      },
      lifecycle: { workerPid: DEAD_WORKER },
      ...overrides,
    }) as const;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("../../src/sessionStore.js");
    vi.doUnmock("../../src/browser/recoveryTarget.js");
  });

  async function release(meta: unknown, otherUsers = false, controllerAlive = false) {
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => meta },
    }));
    vi.doMock("../../src/browser/recoveryTarget.js", () => ({
      hasOtherLiveBrowserController: () => controllerAlive,
    }));
    const { releaseHarvestedSessionChrome } = await import("../../src/cli/harvestChromeRelease.js");
    const terminate = vi.fn(async () => true);
    const hasOtherUsers = vi.fn(async () => otherUsers);
    const logger = Object.assign(vi.fn(), { verbose: false });
    const released = await releaseHarvestedSessionChrome("sess-a", logger, {
      terminate,
      hasOtherUsers,
    });
    return { released, terminate, hasOtherUsers };
  }

  test("closes the Chrome oracle launched for the session when its worker is gone and nobody else uses it", async () => {
    const { released, terminate, hasOtherUsers } = await release(session());
    expect(released).toBe(true);
    expect(hasOtherUsers).toHaveBeenCalledWith("/profiles/oracle", "sess-a");
    expect(terminate).toHaveBeenCalledWith("/profiles/oracle", expect.any(Function));
  });

  test.each([
    ["another run uses it", session(), true, false],
    ["the session's controller still runs", session(), false, true],
    ["the session keeps its browser", session({}, { keepBrowser: true }), false, false],
    ["the user's own Chrome (attach-running)", session({}, { attachRunning: true }), false, false],
    [
      "a remote Chrome",
      session({}, { remoteChrome: { host: "10.0.0.2", port: 9222 } }),
      false,
      false,
    ],
    ["the answer was not saved", session({ status: "running" }), false, false],
  ])("leaves it running when %s", async (_label, meta, otherUsers, controllerAlive) => {
    const { released, terminate } = await release(meta, otherUsers, controllerAlive);
    expect(released).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
  });
});
