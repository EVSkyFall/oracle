import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { createTurnResync } from "../../src/browser/turnResync.js";
import { withAppApprovalMonitor } from "../../src/browser/actions/appApprovals.js";
import { waitForAssistantResponse } from "../../src/browser/actions/assistantResponse.js";
import type { BrowserAppApprovalRecord } from "../../src/browser/types.js";

// Real-Chrome fixture of a stalled turn, served over HTTP so that Page.reload loads it again: the
// first load shows the turn running with its CODEXish prompt hidden in a collapsed box, a reload
// shows what ChatGPT showed after the 2026-10-26 restart. Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";
const ID = "6add23d8-aaaa-4bbb-8ccc-000000000001";
const FINAL = "The check passed: CODEXish read the file and found 42 lines.";

const card = `
  <div class="flex flex-col overflow-hidden rounded-3xl border @container/approval-card" data-codex-approval-surface="true">
    <div class="flex flex-col gap-2 px-4 pt-4 pb-3"><div class="flex items-start gap-2">
      <div class="min-w-0 flex-1" aria-atomic="true" role="alert"><div class="flex flex-col gap-2">
        <div class="flex items-center gap-2"><span class="min-w-0">CODEXish</span></div>
        <div class="min-w-0 font-medium">Allow ChatGPT to use CODEXish?</div>
        <div>ChatGPT will call CODEXish's Fs Read tool.</div>
      </div></div>
    </div></div>
    <form class="flex shrink-0 items-center gap-2 px-4 pt-2 pb-4">
      <button type="button" data-pick="always"><span class="truncate">Always allow</span></button>
      <button type="button" data-pick="deny">Deny<span><kbd aria-hidden="true">Esc</kbd></span></button>
      <button type="button" data-pick="once"><span class="truncate">Allow once</span></button>
    </form>
  </div>`;

const STOP =
  '<button type="button" data-testid="stop-button" aria-label="Stop streaming">■</button>';
const ACTIONS =
  '<div class="turn-action-controls"><button type="button" data-testid="copy-turn-action-button" aria-label="Copy">c</button></div>';

/**
 * The conversation page on load `load`. `story` "hidden-prompt": first load stalled with the
 * prompt collapsed away, later loads show the partial turn (no stop button, no action bar) and
 * the prompt, whose Always allow streams the answer. `story` "finished-meanwhile": later loads
 * show the finished answer.
 */
function conversation(load: number, story: "hidden-prompt" | "finished-meanwhile"): string {
  const stalled = load === 1;
  const finished = !stalled && story === "finished-meanwhile";
  const answer = finished
    ? `<p>${FINAL}</p>`
    : "<p>Used CODEXish integration</p><p>Running command</p>";
  const prompt =
    story === "hidden-prompt" && !finished
      ? `<div id="card-slot"${stalled ? ' style="height:0;overflow:hidden"' : ""}>${card}</div>`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Check</title><style>
  body { margin: 0; font: 14px sans-serif; } main { padding: 16px 16px 140px; }
  #composer { position: fixed; left: 0; right: 0; bottom: 0; height: 90px; background: #fff; border-top: 1px solid #888; }
</style></head><body>
<main>
  <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div>Earlier question</div></div></div>
  <div data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="m2"><div class="markdown"><p>Earlier answer that is never the answer.</p></div></div>${ACTIONS}</div>
  <div data-testid="conversation-turn-3"><div data-message-author-role="user"><div>Run the check with CODEXish.</div></div></div>
  <div data-testid="conversation-turn-4" id="turn"><div data-message-author-role="assistant" data-message-id="m4"><div class="markdown" id="answer">${answer}</div></div>${prompt}${finished ? ACTIONS : ""}</div>
</main>
<form id="composer"><div contenteditable="true" role="textbox" class="ProseMirror"></div>${stalled ? STOP : ""}</form>
<script>
  window.picks = [];
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('button[data-pick]');
    if (!button) return;
    event.preventDefault();
    window.picks.push(button.dataset.pick + (event.isTrusted ? '' : ' (in-page)'));
    if (button.dataset.pick !== 'always') return;
    document.getElementById('card-slot').remove();
    const form = document.getElementById('composer');
    form.insertAdjacentHTML('beforeend', ${JSON.stringify(STOP)});
    const answer = document.getElementById('answer');
    setTimeout(() => { answer.innerHTML = '<p>The check passed: CODEXish read</p>'; }, 500);
    setTimeout(() => { answer.innerHTML = ${JSON.stringify(`<p>${FINAL}</p>`)}; }, 1500);
    setTimeout(() => {
      form.querySelector('[data-testid="stop-button"]').remove();
      document.getElementById('turn').insertAdjacentHTML('beforeend', ${JSON.stringify(ACTIONS)});
    }, 2500);
  }, true);
</script></body></html>`;
}

describe.runIf(enabled)("stalled-turn resync on a reloaded page (real Chrome)", () => {
  let chrome: chromeLauncher.LaunchedChrome | undefined;
  let userDataDir = "";
  let server: http.Server | undefined;
  let base = "";
  let story: "hidden-prompt" | "finished-meanwhile" = "hidden-prompt";
  let loads = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (!String(request.url).startsWith(`/c/${ID}`)) {
        response.writeHead(404).end();
        return;
      }
      loads += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(conversation(loads, story));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-turn-resync-"));
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

  async function waitOnStalledTurn(options: { stallMs?: number }) {
    loads = 0;
    const client = await CDP({ port: chrome!.port });
    try {
      const { Page, Runtime, Input } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      const url = `${base}/c/${ID}`;
      await Page.navigate({ url });
      await Page.loadEventFired();
      const logger = Object.assign(vi.fn(), { verbose: false });
      const records: BrowserAppApprovalRecord[] = [];
      const resync = createTurnResync({
        Runtime,
        Page,
        logger,
        conversationUrl: () => url,
        pollMs: 300,
        hiddenQuietMs: 1_000,
        ...(options.stallMs ? { stallMs: options.stallMs } : {}),
      });
      const answer = await withAppApprovalMonitor(
        Runtime,
        Input,
        {
          allowApps: ["CODEXish"],
          logger,
          intervalMs: 300,
          hiddenSettleMs: 500,
          onApproval: (record) => {
            records.push(record);
          },
          onHiddenSurface: (surface) => resync.reportHiddenApproval(surface),
        },
        () =>
          resync.run((attempt) =>
            // Two turns were there before the prompt; the conversation id is the run's.
            waitForAssistantResponse(
              Runtime,
              attempt.remainingMs(90_000),
              logger,
              2,
              ID,
              attempt.signal,
            ),
          ),
      );
      const { result } = await Runtime.evaluate({
        expression: "window.picks",
        returnByValue: true,
      });
      const lines = logger.mock.calls.map(([line]) => String(line));
      return { answer, records, picks: result.value as string[], lines };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  test("(d) a hidden prompt reloads the turn; the shown prompt is approved and the same turn's final answer is returned", async () => {
    story = "hidden-prompt";
    const { answer, records, picks, lines } = await waitOnStalledTurn({});
    expect(answer.text.trim()).toBe(FINAL);
    expect(answer.meta.messageId).toBe("m4");
    expect(loads).toBe(2);
    expect(picks).toEqual(["always"]);
    expect(records).toEqual([expect.objectContaining({ app: "CODEXish", button: "Always allow" })]);
    expect(lines.filter((line) => line.includes("is in the page but hidden"))).toHaveLength(1);
    expect(
      lines.filter((line) =>
        /^\[browser\] Turn looks stalled \(no change for \d+s; CODEXish's approval prompt is hidden in the page\); reloading the conversation to resync$/.test(
          line,
        ),
      ),
    ).toHaveLength(1);
    expect(lines).toContain(
      "[browser] Conversation reloaded (4 turns on the page); waiting for the turn again.",
    );
  }, 90_000);

  test("(d) a turn that finished while its stream stalled is returned after the reload", async () => {
    story = "finished-meanwhile";
    const { answer, picks, lines } = await waitOnStalledTurn({ stallMs: 3_000 });
    expect(answer.text.trim()).toBe(FINAL);
    expect(loads).toBe(2);
    expect(picks).toEqual([]);
    expect(lines).toContain(
      "[browser] Turn looks stalled (no change for 3s); reloading the conversation to resync",
    );
  }, 90_000);
});
