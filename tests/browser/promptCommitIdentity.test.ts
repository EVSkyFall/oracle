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

async function verify(value: Record<string, unknown>) {
  const logger = Object.assign(vi.fn(), { verbose: false });
  const outcome = await promptComposer
    .verifyPromptCommitted(runtimeShowing(value), PROMPT, 300, logger, 4, {
      baselineUserIds: ["u1", "u2", "u3", "u4"],
    })
    .then(
      (committed) => ({ committed }),
      (error: unknown) => ({ error }),
    );
  return { outcome, logger };
}

describe("the commit check proves a send by the latest user turn's identity", () => {
  test("a new user turn on a page that unmounted its oldest turn (count unchanged) is a proven commit", async () => {
    const { outcome } = await verify(
      probe({ latestUserIsNew: true, latestUserId: "u5", latestUserIndex: 3 }),
    );
    // The committed count ends at the sent user turn: the answer wait starts at index 3.
    expect(outcome).toEqual({ committed: 4 });
  });
});
