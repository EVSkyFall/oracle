import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { browserPromptFingerprint } from "../../src/browser/promptFingerprint.js";

// The real slot registry, harvest slot and recovery on a throwaway profile directory; only
// Chrome and the page are faked. The session's tab is gone, so the harvest recovers it.
const PROMPT = "CODEXish Next round: W5sub2 fix round 2";
const ANSWER = "W5sub2 fix round 2: the fix and its checks.";
const OLD_PORT = 9223;
const RECOVERY_PORT = 53999;

const finished = {
  targetId: "target-r",
  url: "https://chatgpt.com/c/saved-conversation",
  conversationId: "saved-conversation",
  state: "completed",
  authenticated: true,
  stopExists: false,
  sendExists: true,
  assistantCount: 2,
  currentModelLabel: "GPT-6 Pro",
  assistantFollowsLatestUser: true,
  lastUserTurnIndex: 2,
  lastAssistantTurnIndex: 3,
  lastUserText: PROMPT,
  lastUserSnippet: PROMPT,
  lastUserMessageId: "current-message",
  lastAssistantText: ANSWER,
  lastAssistantMarkdown: ANSWER,
  lastAssistantSnippet: ANSWER,
  lastAssistantFinished: true,
};

let profileDir = "";
let terminateRecoveryChrome: ReturnType<typeof vi.fn>;
let launches: number;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-slot-"));
  launches = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of [
    "../../src/browser/liveTabs.js",
    "../../src/browser/index.js",
    "../../src/browser/recoveryChromeLifecycle.js",
    "../../src/sessionStore.js",
  ]) {
    vi.doUnmock(id);
  }
  // Windows: the registry's lock and temp files can still be pending deletion under load.
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(options: { maxConcurrentTabs: number; recoveredTabOpens?: boolean }) {
  const meta = {
    id: "sess-recover-slot",
    createdAt: "2026-10-26T03:04:18.000Z",
    status: "completed",
    options: { prompt: PROMPT },
    mode: "browser",
    cwd: profileDir,
    browser: {
      config: {
        manualLogin: true,
        manualLoginProfileDir: profileDir,
        maxConcurrentTabs: options.maxConcurrentTabs,
        // A slot wait that cannot be met fails within this, not after the default 20 minutes.
        timeoutMs: 3_000,
        inputTimeoutMs: 3_000,
      },
      runtime: {
        chromeHost: "127.0.0.1",
        chromePort: OLD_PORT,
        userDataDir: profileDir,
        tabUrl: "https://chatgpt.com/c/saved-conversation",
        conversationId: "saved-conversation",
        submittedPromptHash: browserPromptFingerprint(PROMPT, "current-message"),
      },
    },
  };
  vi.doMock("../../src/browser/liveTabs.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/browser/liveTabs.js")>()),
    // The worker's Chrome is gone; the recovery Chrome shows this turn's finished answer.
    harvestChatGptTab: vi.fn(async (endpoint: { port?: number }) => {
      if (endpoint.port !== RECOVERY_PORT) {
        throw new Error('No ChatGPT tab matched "https://chatgpt.com/c/saved-conversation".');
      }
      return finished;
    }),
    openChatGptTarget: vi.fn(async (endpoint: { port?: number }) => {
      if (endpoint.port !== RECOVERY_PORT) {
        throw new Error(`connect ECONNREFUSED 127.0.0.1:${endpoint.port}`);
      }
      if (options.recoveredTabOpens === false) throw new Error("Target.createTarget failed");
      return "target-r";
    }),
  }));
  vi.doMock("../../src/browser/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/browser/index.js")>()),
    acquireManualLoginChromeForRun: vi.fn(async () => {
      launches += 1;
      return {
        chrome: { pid: 4242, port: RECOVERY_PORT, host: "127.0.0.1", process: { unref() {} } },
        reusedChrome: null,
      };
    }),
  }));
  terminateRecoveryChrome = vi.fn(async () => true);
  vi.doMock("../../src/browser/recoveryChromeLifecycle.js", () => ({
    recordRecoveryChromeOwnership: vi.fn(async () => {}),
    preserveRecoveryChrome: vi.fn(async () => {}),
    terminateRecoveryChrome,
  }));
  vi.doMock("../../src/sessionStore.js", () => ({
    sessionStore: {
      readSession: async () => meta,
      updateSession: vi.fn(async () => {}),
      getPaths: async () => ({ dir: path.join(profileDir, "session") }),
      sessionsDir: () => path.join(profileDir, "sessions"),
    },
  }));
  return meta;
}

const leaseIds = async () => {
  const raw = await readFile(path.join(profileDir, "oracle-tab-leases.json"), "utf8").catch(
    () => '{"leases":[]}',
  );
  return (JSON.parse(raw).leases as Array<{ id: string }>).map((lease) => lease.id).sort();
};

async function otherRunsHoldSlots(count: number) {
  const now = new Date().toISOString();
  const leases = Array.from({ length: count }, (_, index) => ({
    id: `other-run-${index}`,
    pid: process.pid,
    sessionId: `other-session-${index}`,
    createdAt: now,
    updatedAt: now,
  }));
  await writeFile(
    path.join(profileDir, "oracle-tab-leases.json"),
    JSON.stringify({ version: 1, leases }),
  );
}

describe("recovery during --harvest/--live reuses the command's own browser slot", () => {
  test("with one slot per profile, --harvest recovers the tab and returns the answer", async () => {
    setup({ maxConcurrentTabs: 1 });
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover-slot", { quietOutput: true });
    expect(result.lastAssistantMarkdown).toBe(ANSWER);
    expect(launches).toBe(1);
    // The slot went back with the recovery, which closed the Chrome it launched.
    expect(await leaseIds()).toEqual([]);
    expect(terminateRecoveryChrome).toHaveBeenCalledWith(profileDir, expect.any(Function));
  }, 30_000);

  test("with two other runs under the default limit of three, --harvest recovers and leaves their slots", async () => {
    setup({ maxConcurrentTabs: 3 });
    await otherRunsHoldSlots(2);
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover-slot", { quietOutput: true });
    expect(result.lastAssistantMarkdown).toBe(ANSWER);
    expect(await leaseIds()).toEqual(["other-run-0", "other-run-1"]);
    // Other runs still hold slots on the profile: the Chrome stays for them.
    expect(terminateRecoveryChrome).not.toHaveBeenCalled();
  }, 30_000);

  test("a recovery that fails after launching Chrome closes that Chrome and gives the slot back", async () => {
    setup({ maxConcurrentTabs: 3, recoveredTabOpens: false });
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover-slot", { quietOutput: true }),
    ).rejects.toThrow(/Target.createTarget failed/);
    expect(launches).toBe(1);
    expect(terminateRecoveryChrome).toHaveBeenCalledWith(profileDir, expect.any(Function));
    expect(await leaseIds()).toEqual([]);
  }, 30_000);

  test("with one slot per profile, --live recovers the tab and returns the answer", async () => {
    setup({ maxConcurrentTabs: 1 });
    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await liveTailSessionBrowserOutput("sess-recover-slot");
    expect(result.lastAssistantMarkdown).toBe(ANSWER);
    expect(await leaseIds()).toEqual([]);
  }, 30_000);
});
