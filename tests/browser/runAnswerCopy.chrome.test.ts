import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import {
  captureRunAnswerMarkdown,
  waitForAssistantResponse,
} from "../../src/browser/actions/assistantResponse.js";

// Real-Chrome fixture of a run's own capture on follow-up markup: the run waits for its answer
// turn, then copies its Markdown and saves `copy ?? text`, as index.ts does for local and remote
// runs. When this turn's copy button has not rendered, the button lookup falls back to an earlier
// turn's button; that Markdown must never be saved as this turn's.
// Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";
const ID = "6add23d8-bbbb-4ccc-8ddd-000000000004";
const PREVIOUS = "Completed handoff. Final commit 9490aaa.";
const CURRENT = "W5sub2 fix round 2: the fix and its checks.";
const PREVIOUS_MD = "**Completed handoff.** Final commit 9490aaa.";
const CURRENT_MD = "**W5sub2 fix round 2:** the fix and its checks.";

const copyBar = (markdown: string) =>
  `<div class="turn-action-controls"><button type="button" data-testid="copy-turn-action-button" aria-label="Copy" data-md="${markdown}">c</button></div>`;
// A finished bar whose copy button has not rendered.
const RATE_ONLY =
  '<div class="turn-action-controls"><button type="button" aria-label="Rate response">r</button></div>';

function conversation(currentBar: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Follow-up</title></head><body>
<main id="thread">
  <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div>Write the handoff</div></div></div>
  <div data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="m2"><div class="markdown"><p>${PREVIOUS}</p></div></div>${copyBar(PREVIOUS_MD)}</div>
  <div data-testid="conversation-turn-3"><div data-message-author-role="user"><div>CODEXish Next round: W5sub2 fix round 2</div></div></div>
  <div data-testid="conversation-turn-4"><div data-message-author-role="assistant" data-message-id="m4"><div class="markdown"><p>${CURRENT}</p></div></div>${currentBar}</div>
</main>
<form id="composer"><div contenteditable="true" role="textbox" class="ProseMirror"></div></form>
<script>
  // Like ChatGPT's copy button: the turn's Markdown goes to the clipboard.
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-md]');
    if (button) navigator.clipboard.writeText(button.dataset.md);
  }, true);
</script>
</body></html>`;
}

describe.runIf(enabled)("a run's own Markdown capture on follow-up markup (real Chrome)", () => {
  let chrome: chromeLauncher.LaunchedChrome | undefined;
  let userDataDir = "";
  let server: http.Server | undefined;
  let base = "";

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const match = String(request.url).match(new RegExp(`^/c/${ID}\\?bar=(\\w+)$`));
      if (!match) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(conversation(match[1] === "copy" ? copyBar(CURRENT_MD) : RATE_ONLY));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-run-copy-"));
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

  /** The run's capture: its answer turn, then `copy ?? text` (index.ts, local and remote). */
  async function runCapture(bar: "copy" | "rate") {
    const target = await CDP.New({ host: "127.0.0.1", port: chrome!.port });
    const client = await CDP({ host: "127.0.0.1", port: chrome!.port, target: target.id });
    try {
      const { Page, Runtime } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await Page.navigate({ url: `${base}/c/${ID}?bar=${bar}` });
      await Page.loadEventFired();
      const logger = Object.assign(vi.fn(), { verbose: false });
      // Two turns were on the page before the follow-up was submitted.
      const answer = await waitForAssistantResponse(Runtime, 30_000, logger, 2, ID);
      const copied = await captureRunAnswerMarkdown(Runtime, answer.meta, logger).catch(() => null);
      return { answer, saved: copied ?? answer.text };
    } finally {
      await client.close().catch(() => undefined);
      await CDP.Close({ host: "127.0.0.1", port: chrome!.port, id: target.id }).catch(
        () => undefined,
      );
    }
  }

  test("when this turn's copy button has not rendered, the earlier turn's Markdown is never saved; this turn's text is", async () => {
    const { answer, saved } = await runCapture("rate");
    expect(answer.text.trim()).toBe(CURRENT);
    expect(saved.trim()).toBe(CURRENT);
  }, 90_000);

  test("this turn's own copy is kept", async () => {
    const { saved } = await runCapture("copy");
    expect(saved).toBe(CURRENT_MD);
  }, 90_000);
});
