import { describe, expect, test, vi } from "vitest";
import { __test__ as promptComposer } from "../../src/browser/actions/promptComposer.js";

// The commit check after the send click, against canned page probes. A long conversation keeps
// only a window of turns rendered, so a new turn can unmount an old one and the count stays the
// same; the latest user turn's identity tells a new turn apart. With the pre-send identities
// every decision is made by id: older turns with similar text (round templates, "continue", a
// retried prompt) never count.
const PROMPT = "CODEXish Next round: W5sub2 fix round 2, with the checks in the brief.";
const PRESEND_IDS = ["u1", "u2", "u3", "u4"];

const probe = (overrides: Record<string, unknown>) => ({
  baseline: 4,
  turnsCount: 4,
  userMatched: false,
  prefixMatched: false,
  lastMatched: false,
  hasNewTurn: false,
  stopVisible: false,
  assistantVisible: true,
  composerCleared: true,
  inConversation: true,
  latestUserMatched: false,
  latestUserIsNew: false,
  latestUserKnown: true,
  latestUserIndex: 3,
  latestUserId: "u4",
  latestUserRawText: "Earlier question 4",
  ...overrides,
});
const runtimeShowing = (value: Record<string, unknown>) =>
  ({
    evaluate: vi.fn(async () => ({ result: { value } })),
  }) as never;

async function verify(
  value: Record<string, unknown>,
  // null: the page's user turns had no ids before the send.
  { ids = PRESEND_IDS as readonly string[] | null } = {},
) {
  const logger = Object.assign(vi.fn(), { verbose: false });
  const onUnproven = vi.fn();
  const outcome = await promptComposer
    .verifyPromptCommitted(runtimeShowing(value), PROMPT, 300, logger, 4, {
      baselineUserIds: ids ?? undefined,
      onUnproven,
    })
    .then(
      (committed) => ({ committed }),
      (error: unknown) => ({ error }),
    );
  return { outcome, logger, onUnproven };
}
const notSent = (outcome: unknown) =>
  expect((outcome as { error?: Error }).error?.message).toMatch(
    /Prompt did not appear in conversation before timeout/,
  );

describe("the commit check proves a send by the latest user turn's identity", () => {
  test("a new user turn on a page that unmounted its oldest turn (count unchanged) is a proven commit", async () => {
    const { outcome, onUnproven } = await verify(
      probe({
        latestUserMatched: true,
        latestUserIsNew: true,
        latestUserKnown: false,
        latestUserId: "u5",
        latestUserRawText: PROMPT,
      }),
    );
    // The committed count ends at the sent user turn: the answer wait starts at index 3.
    expect(outcome).toEqual({ committed: 4 });
    expect(onUnproven).not.toHaveBeenCalled();
  });

  test("with the ids known, a grown count and text in older turns prove nothing", async () => {
    const { outcome, onUnproven } = await verify(
      probe({ hasNewTurn: true, turnsCount: 5, userMatched: true, prefixMatched: true }),
    );
    // Not proven: the run goes on (the composer was cleared) with its scope unchanged.
    expect(outcome).toEqual({ committed: null });
    expect(onUnproven).toHaveBeenCalledWith(null);
  });
});

describe("a lost click (the composer still holds the prompt, no new user turn by id) is not sent", () => {
  test("even when an older user turn shares the prompt's first 120 characters", async () => {
    const { outcome, onUnproven } = await verify(
      probe({
        composerCleared: false,
        userMatched: true,
        prefixMatched: true,
        lastMatched: true,
        latestUserMatched: true,
        latestUserRawText: `${PROMPT.slice(0, 60)} (the previous round)`,
      }),
    );
    notSent(outcome);
    expect(onUnproven).not.toHaveBeenCalled();
  });

  test("even when a short prompt is contained in an older assistant answer", async () => {
    const { outcome } = await verify(
      probe({ composerCleared: false, userMatched: true, lastMatched: true }),
    );
    notSent(outcome);
  });

  test("even when it retries the previous prompt, which is the latest user turn", async () => {
    const { outcome } = await verify(
      probe({
        composerCleared: false,
        userMatched: true,
        prefixMatched: true,
        lastMatched: true,
        latestUserMatched: true,
        latestUserRawText: PROMPT,
      }),
    );
    notSent(outcome);
  });

  test("still in the composer and in no turn: today's error", async () => {
    const { outcome, onUnproven } = await verify(probe({ composerCleared: false }));
    notSent(outcome);
    expect(onUnproven).not.toHaveBeenCalled();
  });
});

describe("an unproven send whose composer was cleared goes on, scoped only to a new turn", () => {
  test("a user turn that is new by id stands for the send even when its text differs", async () => {
    const { outcome, onUnproven, logger } = await verify(
      probe({
        latestUserIsNew: true,
        latestUserKnown: false,
        latestUserId: "u5",
        latestUserRawText: "ChatGPT rendered it differently",
      }),
    );
    expect(outcome).toEqual({ committed: 4 });
    expect(onUnproven).toHaveBeenCalledWith({
      index: 3,
      text: "ChatGPT rendered it differently",
      messageId: "u5",
    });
    expect(logger).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[browser\] Prompt commit not proven \(.*\); treating it as sent and waiting for the answer$/,
      ),
    );
  });

  test("an older user turn showing the same prompt never stands for the send", async () => {
    const { outcome, onUnproven } = await verify(
      probe({ latestUserMatched: true, latestUserRawText: PROMPT, userMatched: true }),
    );
    expect(outcome).toEqual({ committed: null });
    expect(onUnproven).toHaveBeenCalledWith(null);
  });

  test("with ids known, a latest user turn without an id never stands for the send", async () => {
    const { outcome, onUnproven } = await verify(
      probe({ latestUserMatched: true, latestUserKnown: false, latestUserId: null }),
    );
    expect(outcome).toEqual({ committed: null });
    expect(onUnproven).toHaveBeenCalledWith(null);
  });

  test("without ids, the previous assistant's text showing the prompt never lowers the scope", async () => {
    const { outcome, onUnproven } = await verify(
      probe({ lastMatched: true, userMatched: true, latestUserKnown: false, latestUserId: null }),
      { ids: null },
    );
    // Not turnsCount: that would start the answer wait at the previous exchange.
    expect(outcome).toEqual({ committed: null });
    expect(onUnproven).toHaveBeenCalledWith(null);
  });

  test("without ids, the latest user turn showing the prompt after a grown count stands for the send", async () => {
    const { outcome, onUnproven } = await verify(
      probe({
        hasNewTurn: true,
        turnsCount: 5,
        latestUserIndex: 4,
        latestUserKnown: false,
        latestUserId: null,
        latestUserMatched: true,
        latestUserRawText: PROMPT,
        // No other sign, so the in-loop count rules did not take it.
        assistantVisible: false,
        inConversation: false,
      }),
      { ids: null },
    );
    expect(outcome).toEqual({ committed: 5 });
    expect(onUnproven).toHaveBeenCalledWith({ index: 4, text: PROMPT, messageId: null });
  });

  test("without ids and without a grown count, a latest user turn showing the prompt never stands", async () => {
    const { outcome, onUnproven } = await verify(
      probe({
        latestUserKnown: false,
        latestUserId: null,
        latestUserMatched: true,
        latestUserRawText: PROMPT,
      }),
      { ids: null },
    );
    // It could be an older identical turn.
    expect(outcome).toEqual({ committed: null });
    expect(onUnproven).toHaveBeenCalledWith(null);
  });
});

describe("the fingerprint of an unproven send", () => {
  test("is the one --live/--harvest compare against, taken from the turn standing for the send", async () => {
    const { browserPromptFingerprint, fingerprintOfUserTurn } =
      await import("../../src/browser/promptFingerprint.js");
    expect(fingerprintOfUserTurn({ text: PROMPT, messageId: "u5" })).toBe(
      browserPromptFingerprint(PROMPT, "u5"),
    );
    // Without an identity there is no fingerprint.
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

describe("the run decides by id on every send, local and remote, initial and in-run follow-ups", () => {
  test("pre-send ids, the submitted prompt's index and the id-scoped answer wait are wired in both runs", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const index = await readFile(path.join(process.cwd(), "src", "browser", "index.ts"), "utf8");
    const count = (pattern: string) => index.split(pattern).length - 1;
    // The ids the run read before the send go to the send (no second, single read).
    expect(count("providerState.previousUserMessageIds = previousUserMessageIds;")).toBe(2);
    // Each answer wait attempt, the recheck included, starts at the sent turn found by id.
    expect(count("resync.run(scopedToSentTurn(operation, timeoutMs), { timeoutMs })")).toBe(2);
    expect(count("await scopeAnswerToSentTurn(undefined, deepResearchPlanWaitBoundMs());")).toBe(2);
    // Initial sends and in-run follow-ups (local and remote) record their scope and prompt index.
    expect(count("sentTurnUserIds = submission.presendUserTurnIds ?? null;")).toBe(4);
    expect(count("pendingPromptIndex = 0;") - count("let pendingPromptIndex = 0;")).toBe(2);
    expect(count("pendingPromptIndex = index + 1;")).toBe(2);
    // Recorded with promptSubmitted, and carried wherever the submitted-turn hash goes.
    expect(count("presendUserTurnIds = pendingPresendUserTurnIds;")).toBe(2);
    const withHash = index.match(/\n\s+submittedPromptHash,\n/g) ?? [];
    const withAll =
      index.match(
        /\n\s+submittedPromptHash,\n\s+presendUserTurnIds,\n\s+submittedPromptIndex,\n/g,
      ) ?? [];
    expect(withHash.length).toBe(12);
    expect(withAll.length).toBe(withHash.length);
  });
});
