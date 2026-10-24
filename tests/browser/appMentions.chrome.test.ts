import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { insertAppMentions } from "../../src/browser/actions/appMentions.js";

// Real-Chrome fixture of the composer "@" picker. Enter in the editor while the picker is
// closed "sends" the prompt, as it does in ChatGPT. Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

const CHIP =
  '<span plugin-mention-name="dev-1" plugin-mention-display-name="CODEXish" plugin-mention-path="plugin://dev-1@curated" contenteditable="false">CODEXish</span>';

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; margin: 0; } form { position: absolute; top: 200px; left: 20px; width: 500px; }
  [role="textbox"] { border: 1px solid #888; min-height: 40px; padding: 4px; }
  #picker { position: absolute; top: 20px; left: 20px; width: 300px; background: #fff; border: 1px solid #888; }
  #picker button { display: block; width: 100%; height: 32px; }
</style></head><body>
<div id="picker" data-composer-overlay-floating-ui hidden></div>
<form data-chatgpt-composer><div id="editor" contenteditable="true" role="textbox"></div></form>
<script>
  const mode = new URLSearchParams(location.search).get('mode');
  window.sent = []; window.pastes = 0;
  const editor = document.getElementById('editor'); const picker = document.getElementById('picker');
  const rows = mode === 'no-row' ? ['OpenAI Platform'] : ['CODEXish', 'Code'];
  const render = (open) => {
    picker.hidden = !open;
    picker.innerHTML = open ? rows.map((title, i) => '<button type="button" data-list-navigation-item ' + (i === 0 ? 'aria-current="true"' : '') + '><span>' + title + '</span></button>').join('') : '';
    for (const button of picker.querySelectorAll('button')) {
      button.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        render(false);
        editor.focus();
        if (mode === 'broken') return; // the picker closes without inserting anything
        editor.innerHTML = editor.innerHTML.replace(/@[A-Za-z]*$/, '') + ${JSON.stringify(CHIP)} + '&nbsp;';
      });
    }
  };
  editor.addEventListener('input', () => render(/@[A-Za-z]*$/.test(editor.textContent)));
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.isTrusted) return;
    event.preventDefault();
    if (picker.hidden) { window.sent.push(editor.textContent); editor.innerHTML = ''; }
  });
  editor.addEventListener('paste', (event) => {
    const html = event.clipboardData.getData('text/html');
    window.pastes += 1;
    if (html.includes('mention-display-name')) { event.preventDefault(); editor.insertAdjacentHTML('beforeend', html); }
  });
</script></body></html>`;

describe.runIf(enabled)("app mentions in real Chrome", () => {
  let chrome: chromeLauncher.LaunchedChrome;
  let client: Awaited<ReturnType<typeof CDP>>;
  let server: http.Server;
  let base = "";
  let userDataDir: string;

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(FIXTURE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-mention-fixture-"));
    chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=800,600", "--no-first-run"],
      userDataDir,
    });
    client = await CDP({ port: chrome.port });
    await Promise.all([client.Page.enable(), client.Runtime.enable()]);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    chrome?.kill();
    server?.close();
    await fs
      .rm(userDataDir, { recursive: true, force: true, maxRetries: 5 })
      .catch(() => undefined);
  });

  async function load(mode: string) {
    await client.Page.navigate({ url: `${base}?mode=${mode}` });
    await client.Page.loadEventFired();
  }
  const pageState = async () =>
    (
      await client.Runtime.evaluate({
        expression:
          "({ sent: window.sent, pastes: window.pastes, text: document.getElementById('editor').textContent.trim(), mentions: document.querySelectorAll('#editor [plugin-mention-display-name]').length })",
        returnByValue: true,
      })
    ).result.value as { sent: string[]; pastes: number; text: string; mentions: number };

  test("a picker row that does not become a mention never leads to Enter, and the query is removed", async () => {
    await load("broken");
    const logger = Object.assign(vi.fn(), { verbose: false });
    await expect(
      insertAppMentions(client.Runtime, client.Input, [{ name: "CODEXish" }], logger),
    ).rejects.toMatchObject({ details: { code: "app-mention-unverified" } });
    expect(await pageState()).toMatchObject({ sent: [], text: "", mentions: 0 });
  }, 60_000);

  test("the @ picker is tried before a supplied chip", async () => {
    await load("works");
    const logger = Object.assign(vi.fn(), { verbose: false });
    await insertAppMentions(
      client.Runtime,
      client.Input,
      [{ name: "CODEXish", chipHtml: CHIP }],
      logger,
    );
    expect(await pageState()).toMatchObject({ sent: [], pastes: 0, mentions: 1 });
    expect(logger).toHaveBeenCalledWith("[browser] App mention CODEXish: attached (@ picker).");
  }, 60_000);

  test("the chip is the fallback when the picker has no such app", async () => {
    await load("no-row");
    const logger = Object.assign(vi.fn(), { verbose: false });
    await insertAppMentions(
      client.Runtime,
      client.Input,
      [{ name: "CODEXish", chipHtml: CHIP }],
      logger,
    );
    expect(await pageState()).toMatchObject({ sent: [], pastes: 1, mentions: 1, text: "CODEXish" });
  }, 60_000);
});
