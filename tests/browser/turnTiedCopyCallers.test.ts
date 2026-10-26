import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { extractDeepResearchResult } from "../../src/browser/actions/deepResearch.js";

// The copy button lookup falls back to other turns' buttons when the captured turn shows none.
// Every capture the run makes ties the copy to the turn it captures; another turn's Markdown
// never stands in for that turn's text.
const REPORT = "Research report: the findings for this turn.";
const REPORT_MD = "## Research report\n\nThe findings for this turn.";
const EARLIER_MD = "## Earlier report\n\nAnother turn's findings.";

function runtime(copy: { markdown: string; ownerMessageId: string }) {
  const evaluate = vi
    .fn()
    // readAssistantSnapshot: the Deep Research turn being captured.
    .mockResolvedValueOnce({
      result: { value: { text: REPORT, html: `<p>${REPORT}</p>`, turnId: null, messageId: "m4" } },
    })
    // The copy: the clicked button and the turn it belongs to.
    .mockResolvedValueOnce({
      result: {
        value: {
          success: true,
          markdown: copy.markdown,
          owner: { turnIndex: 3, messageId: copy.ownerMessageId, turnId: null },
        },
      },
    });
  return { evaluate } as never;
}
const logger = Object.assign(vi.fn(), { verbose: false });

describe("Deep Research's capture", () => {
  test("saves the report's text when the copy came from another turn's button", async () => {
    const result = await extractDeepResearchResult(
      runtime({ markdown: EARLIER_MD, ownerMessageId: "m2" }),
      logger,
    );
    expect(result.text).toBe(REPORT);
  });

  test("keeps the report's own copy", async () => {
    const result = await extractDeepResearchResult(
      runtime({ markdown: REPORT_MD, ownerMessageId: "m4" }),
      logger,
    );
    expect(result.text).toBe(REPORT_MD);
  });
});

describe("every capture the run makes uses the turn-tied copy", () => {
  const read = (file: string) => readFile(path.join(process.cwd(), "src", "browser", file), "utf8");

  test("local and remote runs, reattach, Deep Research and the harvest never call the untied copy", async () => {
    for (const file of [
      "index.ts",
      "reattach.ts",
      "liveTabs.ts",
      path.join("actions", "deepResearch.ts"),
    ]) {
      expect(await read(file), file).not.toMatch(/captureAssistantMarkdown\s*\(/);
    }
    const index = await read("index.ts");
    // The local run and the remote run (runRemoteBrowserMode) each capture through it.
    expect(index.match(/captureRunAnswerMarkdown\(Runtime, turnAnswer\.meta/g)).toHaveLength(2);
    const reattach = await read("reattach.ts");
    expect(reattach.match(/deps\.captureAssistantMarkdown \?\? captureTurnMarkdown/g)).toHaveLength(
      2,
    );
  });
});
