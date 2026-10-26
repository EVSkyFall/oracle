import { describe, expect, test, vi } from "vitest";
import { __test__ as promptComposer } from "../../src/browser/actions/promptComposer.js";

// The commit check after the send click, against canned page probes. A long conversation keeps
// only a window of turns rendered, so a new turn can unmount an old one and the count stays the
// same; the latest user turn's identity tells a new turn apart.
const PROMPT = "CODEXish Next round: W5sub2 fix round 2, with the checks in the brief.";

const probe = (overrides: Record<string, unknown>) => ({
  baseline: 4,
  turnsCount: 4,
  userMatched: true,
  prefixMatched: true,
  lastMatched: true,
  hasNewTurn: false,
  stopVisible: false,
  assistantVisible: true,
  composerCleared: true,
  inConversation: true,
  latestUserMatched: true,
  latestUserIsNew: false,
  latestUserKnown: false,
  latestUserIndex: 3,
  latestUserId: null,
  latestUserRawText: PROMPT,
  ...overrides,
});
const runtimeShowing = (value: Record<string, unknown>) =>
  ({
    evaluate: vi.fn(async () => ({ result: { value } })),
  }) as never;

async function verify(value: Record<string, unknown>, onUnproven = vi.fn()) {
  const logger = Object.assign(vi.fn(), { verbose: false });
  const outcome = await promptComposer
    .verifyPromptCommitted(runtimeShowing(value), PROMPT, 300, logger, 4, {
      baselineUserIds: ["u1", "u2", "u3", "u4"],
      onUnproven,
    })
    .then(
      (committed) => ({ committed }),
      (error: unknown) => ({ error }),
    );
  return { outcome, logger, onUnproven };
}

describe("the commit check proves a send by the latest user turn's identity", () => {
  test("a new user turn on a page that unmounted its oldest turn (count unchanged) is a proven commit", async () => {
    const { outcome, onUnproven } = await verify(
      probe({ latestUserIsNew: true, latestUserId: "u5", latestUserIndex: 3 }),
    );
    // The committed count ends at the sent user turn: the answer wait starts at index 3.
    expect(outcome).toEqual({ committed: 4 });
    expect(onUnproven).not.toHaveBeenCalled();
  });

  test("an identical prompt that is still the baseline's latest user turn is not proven, and never stands for the send", async () => {
    const { outcome, onUnproven, logger } = await verify(
      probe({ latestUserKnown: true, latestUserId: "u4" }),
    );
    // The run goes on (the composer was cleared), with the answer wait's scope unchanged.
    expect(outcome).toEqual({ committed: null });
    expect(onUnproven).toHaveBeenCalledWith(null);
    expect(logger).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[browser\] Prompt commit not proven \(.*\); treating it as sent and waiting for the answer$/,
      ),
    );
  });
});

describe("an unproven send never ends the run unless the prompt never left the composer", () => {
  test("shown in the latest user turn with the composer cleared: the run goes on from that turn", async () => {
    const { outcome, onUnproven } = await verify(probe({}));
    expect(outcome).toEqual({ committed: 4 });
    expect(onUnproven).toHaveBeenCalledWith({ index: 3, text: PROMPT, messageId: null });
  });

  test("still in the composer and in no turn: not sent, today's error", async () => {
    const { outcome, onUnproven } = await verify(
      probe({
        userMatched: false,
        prefixMatched: false,
        lastMatched: false,
        latestUserMatched: false,
        composerCleared: false,
        editorValue: PROMPT,
      }),
    );
    expect((outcome as { error?: Error }).error?.message).toMatch(
      /Prompt did not appear in conversation before timeout/,
    );
    expect(onUnproven).not.toHaveBeenCalled();
  });
});

describe("the fingerprint of an unproven send", () => {
  test("is the one --live/--harvest compare against, taken from the turn standing for the send", async () => {
    const { browserPromptFingerprint, fingerprintOfUserTurn } =
      await import("../../src/browser/promptFingerprint.js");
    expect(fingerprintOfUserTurn({ text: PROMPT, messageId: "u5" })).toBe(
      browserPromptFingerprint(PROMPT, "u5"),
    );
    // Without an identity there is no fingerprint; the session is then found by its text.
    expect(fingerprintOfUserTurn({ text: PROMPT, messageId: null })).toBeUndefined();
    expect(fingerprintOfUserTurn(null)).toBeUndefined();
  });

  test("both the local and the remote run take it after an unproven commit", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const index = await readFile(path.join(process.cwd(), "src", "browser", "index.ts"), "utf8");
    expect(
      index.match(
        /providerState\.commitUnproven === true\s*\?\s*fingerprintOfUserTurn\(providerState\.unprovenCommitTurn/g,
      ),
    ).toHaveLength(2);
  });
});
