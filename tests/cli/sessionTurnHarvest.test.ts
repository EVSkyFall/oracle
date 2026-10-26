import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { browserPromptFingerprint } from "../../src/browser/promptFingerprint.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

// Never take a browser slot on a real profile in tests (the default is ~/.oracle/browser-profile).
vi.mock("../../src/cli/harvestChromeRelease.js", () => ({
  takeHarvestSlot: vi.fn(async () => null),
  releaseHarvestSlot: vi.fn(async () => false),
}));

// The game session's 13:00 reattach: a follow-up conversation whose earlier turns are complete,
// and this session's Pro turn still being generated with no assistant message yet.
const PROMPT = "CODEXish Next round: W5sub2 fix round 2";
const PREVIOUS = "Completed handoff. Final commit 9490aaa.";
const CURRENT = "W5sub2 fix round 2: the fix and its checks.";

const base = {
  targetId: "target-x",
  url: "https://chatgpt.com/c/saved-conversation",
  conversationId: "saved-conversation",
  authenticated: true,
  sendExists: false,
  currentModelLabel: "GPT-6 Pro",
  lastUserText: PROMPT,
  lastUserSnippet: PROMPT,
  lastUserMessageId: "current-message",
};
/** This session's turn generating, nothing after it yet: the page's last answer is the previous turn's. */
const generatingNoAnswer = {
  ...base,
  state: "running",
  stopExists: true,
  assistantCount: 2,
  assistantFollowsLatestUser: false,
  lastUserTurnIndex: 4,
  lastAssistantTurnIndex: 3,
  lastAssistantText: PREVIOUS,
  lastAssistantMarkdown: PREVIOUS,
  lastAssistantSnippet: PREVIOUS,
};
const generatingPartial = {
  ...base,
  state: "running",
  stopExists: true,
  assistantCount: 3,
  assistantFollowsLatestUser: true,
  lastUserTurnIndex: 4,
  lastAssistantTurnIndex: 5,
  lastAssistantText: "W5sub2 fix round 2: the fix",
  lastAssistantMarkdown: "W5sub2 fix round 2: the fix",
  lastAssistantSnippet: "W5sub2 fix round 2: the fix",
};
const finished = {
  ...base,
  state: "completed",
  stopExists: false,
  sendExists: true,
  assistantCount: 3,
  assistantFollowsLatestUser: true,
  lastUserTurnIndex: 4,
  lastAssistantTurnIndex: 5,
  lastAssistantText: CURRENT,
  lastAssistantMarkdown: CURRENT,
  lastAssistantSnippet: CURRENT,
  // The normal capture's terminal proof confirmed it (harvestChatGptTab's confirmTurnComplete).
  lastAssistantFinished: true,
};
/** A Pro preamble after this session's turn while the stop button is briefly gone: not proven finished. */
const PREAMBLE = "Let me look at the fix and its checks first.";
const preambleNoStop = {
  ...finished,
  state: "completed",
  lastAssistantText: PREAMBLE,
  lastAssistantMarkdown: PREAMBLE,
  lastAssistantSnippet: PREAMBLE,
  lastAssistantFinished: false,
};

let cwd: string;
let updateSession: ReturnType<typeof vi.fn>;

function mockSession(harvests: unknown[], config: Record<string, unknown> = {}) {
  let index = 0;
  const harvestChatGptTab = vi.fn(async () => harvests[Math.min(index++, harvests.length - 1)]);
  const meta = {
    id: "sess-turn",
    createdAt: "2026-10-26T03:04:18.000Z",
    status: "running",
    options: { prompt: PROMPT },
    mode: "browser",
    cwd,
    browser: {
      config: { manualLogin: true, timeoutMs: 10 * 60_000, inputTimeoutMs: 3_000, ...config },
      runtime: {
        chromeHost: "127.0.0.1",
        chromePort: 9223,
        tabUrl: "https://chatgpt.com/c/saved-conversation",
        conversationId: "saved-conversation",
        submittedPromptHash: browserPromptFingerprint(PROMPT, "current-message"),
      },
    },
  } as unknown as SessionMetadata;
  updateSession = vi.fn(async () => {});
  vi.doMock("../../src/browser/liveTabs.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/browser/liveTabs.js")>()),
    harvestChatGptTab,
  }));
  vi.doMock("../../src/browser/recoverConversation.js", () => ({
    recoverConversationTab: vi.fn(),
    isRecoveredConversationHarvestReady: () => true,
  }));
  vi.doMock("../../src/sessionStore.js", () => ({
    sessionStore: {
      readSession: async () => meta,
      updateSession,
      getPaths: async () => ({ dir: path.join(os.tmpdir(), `oracle-turn-${randomUUID()}`) }),
      sessionsDir: () => path.join(os.tmpdir(), "oracle-turn-sessions-dir"),
    },
  }));
  return { harvestChatGptTab };
}

const savedTexts = () => JSON.stringify(updateSession.mock.calls);

/** Advances fake time a second at a time, letting real file work finish in between. */
async function advance(ms: number): Promise<void> {
  for (let spent = 0; spent < ms; spent += 1_000) {
    await vi.advanceTimersByTimeAsync(Math.min(1_000, ms - spent));
    await fs.stat(cwd);
  }
}

describe("a reattach saves only this session's own turn", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-turn-cwd-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("../../src/browser/liveTabs.js");
    vi.doUnmock("../../src/browser/recoverConversation.js");
    vi.doUnmock("../../src/sessionStore.js");
    await fs.rm(cwd, { recursive: true, force: true });
  });

  test("--live keeps waiting while this turn is generating with no answer, never saves the previous answer, and saves this turn's answer when it comes", async () => {
    // Five minutes of an unchanged page with the stop button (a Pro turn thinking), then the answer.
    const harvests = [
      ...Array.from({ length: 150 }, () => generatingNoAnswer),
      generatingPartial,
      finished,
    ];
    const { harvestChatGptTab } = mockSession(harvests);
    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = liveTailSessionBrowserOutput("sess-turn", { writeOutputPath: "answer.md" });
    const settled = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await advance(2 * 60_000);
    // Long past the old 60 s stall exit: still waiting, nothing written.
    await expect(fs.access(path.join(cwd, "answer.md"))).rejects.toThrow();
    await advance(4 * 60_000);
    const outcome = await settled;
    expect(outcome).toMatchObject({ value: { lastAssistantMarkdown: CURRENT } });
    expect(await fs.readFile(path.join(cwd, "answer.md"), "utf8")).toBe(CURRENT);
    expect(harvestChatGptTab.mock.calls.length).toBeGreaterThan(150);
    expect(savedTexts()).not.toContain(PREVIOUS);
  });

  test("--live with this turn's answer already on the page returns it", async () => {
    mockSession([finished]);
    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await liveTailSessionBrowserOutput("sess-turn", {
      writeOutputPath: "answer.md",
    });
    expect(result.lastAssistantMarkdown).toBe(CURRENT);
    expect(await fs.readFile(path.join(cwd, "answer.md"), "utf8")).toBe(CURRENT);
  });

  test("--live whose time runs out while this turn is still generating saves nothing", async () => {
    mockSession([generatingNoAnswer], { timeoutMs: 60_000 });
    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const settled = liveTailSessionBrowserOutput("sess-turn", {
      writeOutputPath: "answer.md",
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await advance(65_000);
    const outcome = (await settled) as { error?: Error };
    expect(String(outcome.error?.message)).toMatch(/still being generated.*nothing was saved/);
    await expect(fs.access(path.join(cwd, "answer.md"))).rejects.toThrow();
    expect(savedTexts()).not.toContain(PREVIOUS);
  });

  test("--harvest of a turn still being generated saves nothing, even with part of its answer on the page", async () => {
    mockSession([generatingPartial]);
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const settled = harvestSessionBrowserOutput("sess-turn", {
      writeOutputPath: "answer.md",
      quietOutput: true,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await advance(4_000);
    const outcome = (await settled) as { error?: Error };
    expect(String(outcome.error?.message)).toMatch(/still being generated.*nothing was saved/);
    await expect(fs.access(path.join(cwd, "answer.md"))).rejects.toThrow();
    expect(updateSession).not.toHaveBeenCalled();
  });

  test("--harvest of a turn with no answer yet saves nothing and never the previous answer", async () => {
    mockSession([{ ...generatingNoAnswer, stopExists: false, state: "completed" }]);
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const settled = harvestSessionBrowserOutput("sess-turn", { quietOutput: true }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await advance(4_000);
    const outcome = (await settled) as { error?: Error };
    expect(String(outcome.error?.message)).toMatch(/no assistant answer.*nothing was saved/);
    expect(updateSession).not.toHaveBeenCalled();
  });

  test("a page that renders only the latest turns (virtualized history): this turn's pair is enough", async () => {
    mockSession([
      { ...finished, assistantCount: 1, lastUserTurnIndex: 0, lastAssistantTurnIndex: 1 },
    ]);
    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await liveTailSessionBrowserOutput("sess-turn");
    expect(result.lastAssistantMarkdown).toBe(CURRENT);
  });

  test("a page whose latest rendered user turn is an earlier one is never taken as this session's", async () => {
    // Virtualized: this session's user turn is not rendered, an earlier pair is.
    const earlier = {
      ...finished,
      lastUserText: "An earlier request",
      lastUserSnippet: "An earlier request",
      lastUserMessageId: "earlier-message",
      lastAssistantText: PREVIOUS,
      lastAssistantMarkdown: PREVIOUS,
    };
    mockSession([earlier], { timeoutMs: 10_000 });
    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const settled = liveTailSessionBrowserOutput("sess-turn").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await advance(15_000);
    const outcome = (await settled) as { error?: Error };
    expect(String(outcome.error?.message)).toMatch(/not the one this session submitted/);
    expect(savedTexts()).not.toContain(PREVIOUS);
  });

  test("--harvest of a preamble shown while the stop button is briefly absent saves nothing", async () => {
    const { harvestChatGptTab } = mockSession([preambleNoStop]);
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const settled = harvestSessionBrowserOutput("sess-turn", {
      writeOutputPath: "answer.md",
      quietOutput: true,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await advance(4_000);
    const outcome = (await settled) as { error?: Error };
    expect(String(outcome.error?.message)).toMatch(/still being generated.*nothing was saved/);
    await expect(fs.access(path.join(cwd, "answer.md"))).rejects.toThrow();
    expect(updateSession).not.toHaveBeenCalled();
    // Every read asked for the normal capture's terminal proof on this turn.
    for (const [options] of harvestChatGptTab.mock.calls as unknown as Array<[unknown]>) {
      expect(options).toMatchObject({ confirmTurnComplete: { timeoutMs: expect.any(Number) } });
    }
  });

  test("--live does not end on a preamble shown while the stop button is briefly absent; it returns the finished answer", async () => {
    const { harvestChatGptTab } = mockSession([
      generatingPartial,
      ...Array.from({ length: 5 }, () => preambleNoStop),
      generatingPartial,
      finished,
    ]);
    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const settled = liveTailSessionBrowserOutput("sess-turn", {
      writeOutputPath: "answer.md",
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await advance(30_000);
    expect(await settled).toMatchObject({ value: { lastAssistantMarkdown: CURRENT } });
    expect(await fs.readFile(path.join(cwd, "answer.md"), "utf8")).toBe(CURRENT);
    // The first read only probes the tab; every read that decides asked for the proof.
    for (const [options] of harvestChatGptTab.mock.calls.slice(1) as unknown as Array<[unknown]>) {
      expect(options).toMatchObject({ confirmTurnComplete: { timeoutMs: expect.any(Number) } });
    }
  });

  test.each([["ChatGPT said:"], ["Pro thinking\nAnswer now"], ["Stopped thinking\nEdit"]])(
    "a turn showing only placeholder or UI chrome (%j) is never saved as its answer",
    async (text) => {
      const placeholder = {
        ...finished,
        lastAssistantText: text,
        lastAssistantMarkdown: text,
        lastAssistantSnippet: text,
      };
      mockSession([placeholder]);
      const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
      for (const browserTabRef of [undefined, "target-x"]) {
        const settled = harvestSessionBrowserOutput("sess-turn", {
          writeOutputPath: "answer.md",
          quietOutput: true,
          browserTabRef,
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await advance(4_000);
        const outcome = (await settled) as { error?: Error };
        expect(String(outcome.error?.message)).toMatch(/no assistant answer.*nothing was saved/);
      }
      await expect(fs.access(path.join(cwd, "answer.md"))).rejects.toThrow();
      expect(updateSession).not.toHaveBeenCalled();
    },
  );

  test("--harvest of this turn's finished answer returns and saves it", async () => {
    const { harvestChatGptTab } = mockSession([finished]);
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-turn", {
      writeOutputPath: "answer.md",
      quietOutput: true,
    });
    expect(result.lastAssistantMarkdown).toBe(CURRENT);
    expect(await fs.readFile(path.join(cwd, "answer.md"), "utf8")).toBe(CURRENT);
    expect(savedTexts()).toContain(CURRENT);
    expect(harvestChatGptTab).toHaveBeenCalledWith(
      expect.objectContaining({ confirmTurnComplete: { timeoutMs: expect.any(Number) } }),
    );
  });

  test("--live and --harvest hold a slot while reading; the session's Chrome may be released only after its answer was saved, never for an explicit tab", async () => {
    const slot = { lease: { id: "slot" }, userDataDir: "/profiles/oracle" };
    const takeHarvestSlot = vi.fn(async () => slot);
    const releaseHarvestSlot = vi.fn(async () => false);
    vi.doMock("../../src/cli/harvestChromeRelease.js", () => ({
      takeHarvestSlot,
      releaseHarvestSlot,
    }));
    try {
      mockSession([finished]);
      const { liveTailSessionBrowserOutput, harvestSessionBrowserOutput } =
        await import("../../src/cli/browserTabs.js");
      await liveTailSessionBrowserOutput("sess-turn");
      await harvestSessionBrowserOutput("sess-turn", { quietOutput: true });
      expect(takeHarvestSlot).toHaveBeenCalledTimes(2);
      expect(releaseHarvestSlot.mock.calls.map((call) => call.slice(0, 3))).toEqual([
        [slot, "sess-turn", true],
        [slot, "sess-turn", true],
      ]);
      await harvestSessionBrowserOutput("sess-turn", {
        quietOutput: true,
        browserTabRef: "target-x",
      });
      expect(takeHarvestSlot).toHaveBeenCalledTimes(2);
      expect(releaseHarvestSlot.mock.calls.at(-1)?.slice(0, 3)).toEqual([null, "sess-turn", true]);
    } finally {
      vi.doUnmock("../../src/cli/harvestChromeRelease.js");
    }
  });

  test("a harvest that saves nothing gives its slot back without releasing the Chrome", async () => {
    const slot = { lease: { id: "slot" }, userDataDir: "/profiles/oracle" };
    const releaseHarvestSlot = vi.fn(async () => false);
    vi.doMock("../../src/cli/harvestChromeRelease.js", () => ({
      takeHarvestSlot: vi.fn(async () => slot),
      releaseHarvestSlot,
    }));
    try {
      mockSession([generatingPartial]);
      const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
      const settled = harvestSessionBrowserOutput("sess-turn", { quietOutput: true }).catch(
        (error: unknown) => error,
      );
      await advance(4_000);
      expect(await settled).toBeInstanceOf(Error);
      expect(releaseHarvestSlot.mock.calls.map((call) => call.slice(0, 3))).toEqual([
        [slot, "sess-turn", false],
      ]);
    } finally {
      vi.doUnmock("../../src/cli/harvestChromeRelease.js");
    }
  });
});
