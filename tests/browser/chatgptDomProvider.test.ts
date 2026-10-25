import { describe, expect, test, vi } from "vitest";

const submitPrompt = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../../src/browser/actions/promptComposer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/actions/promptComposer.js")>()),
  submitPrompt,
}));

const { chatgptDomProvider } = await import("../../src/browser/providers/chatgptDomProvider.js");

describe("ChatGPT DOM provider", () => {
  test("passes the maximum thinking time to the send, so the composer is checked at the click", async () => {
    await chatgptDomProvider.submitPrompt({
      prompt: "hello",
      evaluate: async () => undefined,
      delay: async () => undefined,
      state: {
        runtime: {},
        input: {},
        logger: Object.assign(vi.fn(), { verbose: false }),
        timeoutMs: 1_000,
        maxThinkingTime: "extra-high",
      },
    });
    expect(submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ maxThinkingTime: "extra-high" }),
      "hello",
      expect.any(Function),
    );
  });
});
