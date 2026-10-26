import { describe, expect, test } from "vitest";
import { captureTurnMarkdown } from "../../src/browser/actions/assistantResponse.js";
import type { ChromeClient } from "../../src/browser/types.js";

// The copy button lookup falls back to other turns' buttons; the copy reports whose button it
// clicked, and only a copy from the named turn itself counts.
const runtime = (value: unknown) =>
  ({
    evaluate: async () => ({ result: { value } }),
  }) as unknown as ChromeClient["Runtime"];
const copied = (owner: unknown) => ({ success: true, markdown: "**Answer**", owner });
const quiet = () => {};

describe("the Markdown of exactly the proven turn", () => {
  test("is the copy when the clicked button belongs to that message", async () => {
    const r = runtime(copied({ turnIndex: 3, messageId: "m4", turnId: null }));
    expect(await captureTurnMarkdown(r, { messageId: "m4" }, quiet)).toBe("**Answer**");
  });

  test("is never an earlier turn's copy", async () => {
    const r = runtime(copied({ turnIndex: 1, messageId: "m2", turnId: null }));
    expect(await captureTurnMarkdown(r, { messageId: "m4" }, quiet)).toBeNull();
  });

  test("is tied by turn id when the turn has no message id", async () => {
    const owner = { turnIndex: 3, messageId: null, turnId: "turn-4" };
    expect(await captureTurnMarkdown(runtime(copied(owner)), { turnId: "turn-4" }, quiet)).toBe(
      "**Answer**",
    );
    expect(
      await captureTurnMarkdown(runtime(copied(owner)), { turnId: "turn-2" }, quiet),
    ).toBeNull();
  });

  test("is null when the copy cannot be tied to the turn or did not happen", async () => {
    expect(await captureTurnMarkdown(runtime(copied(null)), { messageId: "m4" }, quiet)).toBeNull();
    expect(await captureTurnMarkdown(runtime(copied({ messageId: "m4" })), {}, quiet)).toBeNull();
    expect(
      await captureTurnMarkdown(
        runtime({ success: false, status: "missing-button" }),
        { messageId: "m4" },
        quiet,
      ),
    ).toBeNull();
  });
});
