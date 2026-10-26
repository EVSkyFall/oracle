import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { waitForAssistantResponse } from "../../src/browser/actions/assistantResponse.js";

// Real-Chrome fixture of a follow-up: earlier turns are complete, the follow-up's turn is still
// being generated with no assistant message yet (a Pro turn thinking). The normal capture scopes
// to the turns after the follow-up's baseline, so the previous answer is never taken.
// Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";
const ID = "6add23d8-bbbb-4ccc-8ddd-000000000002";
const PREVIOUS = "Completed handoff. Final commit 9490aaa.";
const CURRENT = "W5sub2 fix round 2: the fix and its checks.";

const STOP =
  '<button type="button" data-testid="stop-button" aria-label="Stop streaming">■</button>';
const ACTIONS =
  '<div class="turn-action-controls"><button type="button" data-testid="copy-turn-action-button" aria-label="Copy">c</button></div>';

/**
 * `answerAfterMs`: when this turn's answer appears (null: not during the test). `stop`: whether
 * the stop button shows (false: the moment between the submission and the turn starting).
 */
function conversation(answerAfterMs: number | null, stop: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Follow-up</title></head><body>
<main id="thread">
  <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div>Write the handoff</div></div></div>
  <div data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="m2"><div class="markdown"><p>${PREVIOUS}</p></div></div>${ACTIONS}</div>
  <div data-testid="conversation-turn-3"><div data-message-author-role="user"><div>CODEXish Next round: W5sub2 fix round 2</div></div></div>
</main>
<form id="composer"><div contenteditable="true" role="textbox" class="ProseMirror"></div>${stop ? STOP : ""}</form>
<script>
  const after = ${JSON.stringify(answerAfterMs)};
  if (after !== null) {
    setTimeout(() => {
      document.getElementById('thread').insertAdjacentHTML('beforeend',
        '<div data-testid="conversation-turn-4" id="turn"><div data-message-author-role="assistant" data-message-id="m4"><div class="markdown"><p>${CURRENT}</p></div></div></div>');
    }, after);
    setTimeout(() => {
      document.querySelector('[data-testid="stop-button"]')?.remove();
      document.getElementById('turn').insertAdjacentHTML('beforeend', ${JSON.stringify(ACTIONS)});
    }, after + 1000);
  }
</script></body></html>`;
}

describe.runIf(enabled)("follow-up capture on a page with earlier answers (real Chrome)", () => {
  let chrome: chromeLauncher.LaunchedChrome | undefined;
  let userDataDir = "";
  let server: http.Server | undefined;
  let base = "";
  let answerAfterMs: number | null = null;
  let stop = true;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (!String(request.url).startsWith(`/c/${ID}`)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(conversation(answerAfterMs, stop));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-follow-up-"));
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

  async function waitOnFollowUp(timeoutMs: number) {
    const client = await CDP({ port: chrome!.port });
    try {
      const { Page, Runtime } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await Page.navigate({ url: `${base}/c/${ID}` });
      await Page.loadEventFired();
      const logger = Object.assign(vi.fn(), { verbose: false });
      // Two turns were on the page before the follow-up was submitted.
      return await waitForAssistantResponse(Runtime, timeoutMs, logger, 2, ID).then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error }),
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  test.each([
    ["generating (stop shown)", true],
    ["not started yet (no stop button)", false],
  ])(
    "while the follow-up's turn has no answer yet (%s), the previous answer is never returned",
    async (_label, stopShown) => {
      answerAfterMs = null;
      stop = stopShown;
      const outcome = await waitOnFollowUp(6_000);
      expect("answer" in outcome ? outcome.answer.text : "").not.toContain("Completed handoff");
      expect("error" in outcome).toBe(true);
    },
    60_000,
  );

  test("once the follow-up's answer arrives, that answer is returned", async () => {
    answerAfterMs = 3_000;
    stop = true;
    const outcome = await waitOnFollowUp(30_000);
    expect("answer" in outcome && outcome.answer.text.trim()).toBe(CURRENT);
  }, 60_000);
});
