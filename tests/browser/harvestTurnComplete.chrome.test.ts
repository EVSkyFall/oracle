import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { harvestChatGptTab } from "../../src/browser/liveTabs.js";

// Real-Chrome fixture of a harvest reading a follow-up's turn: the earlier turn is complete, and
// this turn shows a preamble without the stop button, a placeholder, nothing yet, or its finished
// answer. Only the normal capture's terminal proof makes a turn finished.
// Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";
const ID = "6add23d8-bbbb-4ccc-8ddd-000000000003";
const PREVIOUS = "Completed handoff. Final commit 9490aaa.";
const PREAMBLE = "Let me look at the fix and its checks first.";
const CURRENT = "W5sub2 fix round 2: the fix and its checks.";
// What each turn's copy button puts on the clipboard (its Markdown), unlike its rendered text.
const PREVIOUS_MD = "**Completed handoff.** Final commit 9490aaa.";
const CURRENT_MD = "**W5sub2 fix round 2:** the fix and its checks.";

const actions = (markdown: string) =>
  `<div class="turn-action-controls"><button type="button" data-testid="copy-turn-action-button" aria-label="Copy" data-md="${markdown}">c</button></div>`;
// A finished bar whose copy button has not rendered.
const RATE_ONLY =
  '<div class="turn-action-controls"><button type="button" aria-label="Rate response">r</button></div>';
const STOP =
  '<button type="button" data-testid="stop-button" aria-label="Stop streaming">■</button>';
const turn4 = (body: string, bar = "") =>
  `<div data-testid="conversation-turn-4" id="turn4"><div data-message-author-role="assistant" data-message-id="m4">${body}</div>${bar}</div>`;
const answer = (text: string) => `<div class="markdown"><p>${text}</p></div>`;

interface Page {
  turn: string;
  /** Whether the earlier answer shows its copy button. */
  previousCopy?: boolean;
  stop?: boolean;
  script?: string;
}

const PAGES: Record<string, Page> = {
  preamble: { turn: turn4(answer(PREAMBLE)) },
  placeholder: {
    turn: turn4(
      '<div>Pro thinking</div><button type="button">Answer now</button>',
      actions(CURRENT_MD),
    ),
  },
  none: { turn: "" },
  finished: { turn: turn4(answer(CURRENT), actions(CURRENT_MD)) },
  // This turn is finished, its copy button not rendered: the lookup falls back to earlier turns.
  earlierCopy: { turn: turn4(answer(CURRENT), RATE_ONLY) },
  // This turn's text is final; its bar (with the copy button) mounts 12 s later.
  lateBar: {
    turn: turn4(answer(CURRENT)),
    previousCopy: false,
    script: `setTimeout(() => document.getElementById('turn4').insertAdjacentHTML('beforeend', ${JSON.stringify(actions(CURRENT_MD))}), 12000);`,
  },
  streaming: { turn: turn4(answer("W5sub2 fix round 2: the")), previousCopy: false, stop: true },
};

function conversation(page: Page): string {
  const previousBar = page.previousCopy === false ? "" : actions(PREVIOUS_MD);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Follow-up</title></head><body>
<main id="thread">
  <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div>Write the handoff</div></div></div>
  <div data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="m2"><div class="markdown"><p>${PREVIOUS}</p></div></div>${previousBar}</div>
  <div data-testid="conversation-turn-3"><div data-message-author-role="user" data-message-id="u3"><div>CODEXish Next round: W5sub2 fix round 2</div></div></div>
  ${page.turn}
</main>
<form id="composer"><div contenteditable="true" role="textbox" class="ProseMirror"></div>${page.stop ? STOP : ""}</form>
<script>
  // Like ChatGPT's copy button: the turn's Markdown goes to the clipboard.
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-md]');
    if (button) navigator.clipboard.writeText(button.dataset.md);
  }, true);
  ${page.script ?? ""}
</script>
</body></html>`;
}

describe.runIf(enabled)("harvest's finished-turn proof (real Chrome)", () => {
  let chrome: chromeLauncher.LaunchedChrome | undefined;
  let userDataDir = "";
  let server: http.Server | undefined;
  let base = "";

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const match = String(request.url).match(new RegExp(`^/c/${ID}\\?turn=(\\w+)$`));
      const page = match ? PAGES[match[1]] : undefined;
      if (page === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(conversation(page));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-harvest-proof-"));
    chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=1280,900", "--no-first-run"],
      userDataDir,
    });
  }, 60_000);

  afterAll(async () => {
    chrome?.kill();
    await new Promise((resolve) => server?.close(resolve));
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function harvest(page: keyof typeof PAGES, timeoutMs: number) {
    const url = `${base}/c/${ID}?turn=${page}`;
    const target = await CDP.New({ host: "127.0.0.1", port: chrome!.port, url });
    try {
      const client = await CDP({ host: "127.0.0.1", port: chrome!.port, target: target.id });
      try {
        await client.Runtime.enable();
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const { result } = await client.Runtime.evaluate({
            expression: "document.readyState",
            returnByValue: true,
          });
          if (result.value === "complete") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        await client.close().catch(() => undefined);
      }
      return await harvestChatGptTab({
        host: "127.0.0.1",
        port: chrome!.port,
        target: { targetId: target.id, url, title: "Follow-up", type: "page" },
        confirmTurnComplete: { timeoutMs },
      });
    } finally {
      await CDP.Close({ host: "127.0.0.1", port: chrome!.port, id: target.id }).catch(
        () => undefined,
      );
    }
  }

  test("a preamble without the stop button and without a finished bar is not finished", async () => {
    const harvested = await harvest("preamble", 4_000);
    expect(harvested.stopExists).toBe(false);
    expect(harvested.assistantFollowsLatestUser).toBe(true);
    expect(harvested.lastAssistantFinished).toBe(false);
  }, 60_000);

  test("a placeholder turn is not finished, even with a finished bar, and the previous answer never counts", async () => {
    const harvested = await harvest("placeholder", 4_000);
    expect(harvested.lastAssistantFinished).toBe(false);
    expect(harvested.lastAssistantMarkdown ?? "").not.toContain("Completed handoff");
  }, 60_000);

  test("with nothing after this turn yet, the previous answer is not this turn's finished answer", async () => {
    const harvested = await harvest("none", 4_000);
    expect(harvested.assistantFollowsLatestUser).toBe(false);
    expect(harvested.lastAssistantFinished).toBe(false);
  }, 60_000);

  test("this turn's finished answer is proven and returned", async () => {
    const harvested = await harvest("finished", 15_000);
    expect(harvested.lastAssistantFinished).toBe(true);
    expect(harvested.lastAssistantText).toBe(CURRENT);
    // Copied from this turn's own button, after the proof.
    expect(harvested.lastAssistantMarkdown).toBe(CURRENT_MD);
  }, 60_000);

  test("when this turn shows no copy button, an earlier turn's Markdown never stands in for it", async () => {
    const harvested = await harvest("earlierCopy", 15_000);
    expect(harvested.lastAssistantFinished).toBe(true);
    expect(harvested.lastAssistantText).toBe(CURRENT);
    expect(harvested.lastAssistantMarkdown).toBe(CURRENT);
  }, 60_000);

  test("a copy button that mounts while the turn is being proven yields its Markdown", async () => {
    const harvested = await harvest("lateBar", 25_000);
    expect(harvested.lastAssistantFinished).toBe(true);
    expect(harvested.lastAssistantMarkdown).toBe(CURRENT_MD);
  }, 60_000);

  test("a streaming turn is read without waiting for a copy button", async () => {
    const startedAt = Date.now();
    const harvested = await harvest("streaming", 15_000);
    expect(harvested.stopExists).toBe(true);
    expect(harvested.lastAssistantFinished).toBe(false);
    // The copy wait alone is 10 s; reading the page takes well under a second.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 60_000);
});
