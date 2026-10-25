import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { submitPrompt } from "../../src/browser/actions/promptComposer.js";

// Real-Chrome fixture of the composer right after a reply (the in-run --browser-follow-up case):
// the prompt is typed, but for a moment the send button is disabled, or the stop button of the
// finishing reply shows instead of it, and Enter does nothing. A trusted click on the send button
// posts the user turn. Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; margin: 0; }
  form { position: fixed; left: 20px; right: 20px; bottom: 20px; height: 80px; border: 1px solid #888; }
  [contenteditable] { position: absolute; left: 8px; top: 8px; right: 80px; bottom: 8px; }
  #slot button { position: absolute; right: 8px; bottom: 8px; width: 40px; height: 32px; }
</style></head><body>
<main><article data-testid="conversation-turn-1" data-message-author-role="assistant">ready</article></main>
<form data-chatgpt-composer>
  <div contenteditable="true" role="textbox" id="prompt-textarea" class="ProseMirror"></div>
  <span id="slot"></span>
</form>
<script>
  window.log = [];
  const editor = document.getElementById('prompt-textarea');
  const slot = document.getElementById('slot');
  // While the reply finishes, Enter in the editor sends nothing.
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.isTrusted) return;
    window.log.push('enter');
    event.preventDefault();
  });
  const sendButton = (disabled) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.testid = 'send-button';
    button.setAttribute('aria-label', 'Send prompt');
    button.textContent = '↑';
    if (disabled) button.disabled = true;
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      window.log.push('click');
      const turn = document.createElement('article');
      turn.dataset.testid = 'conversation-turn-2';
      turn.dataset.messageAuthorRole = 'user';
      turn.textContent = editor.innerText;
      document.querySelector('main').append(turn);
      editor.textContent = '';
    });
    return button;
  };
  // mode: 'disabled' = the send button is mounted disabled and enabled after delayMs;
  // 'stop' = the reply's stop button shows and is replaced by the send button after delayMs;
  // 'hidden-home' = the home page's composer stays in the page, hidden and first, with its old
  // draft (as after the in-page move into the conversation), and the conversation's composer
  // shows its send button only while its editor holds text.
  window.setup = (mode, delayMs) => {
    slot.textContent = '';
    if (mode === 'hidden-home') {
      const home = document.createElement('div');
      home.style.display = 'none';
      home.innerHTML = '<form data-chatgpt-composer><div contenteditable="true" role="textbox" id="prompt-textarea" class="ProseMirror">old home draft</div><button type="button" data-testid="send-button" aria-label="Send prompt">↑</button></form>';
      home.querySelector('button').addEventListener('click', () => window.log.push('hidden-click'));
      document.body.prepend(home);
      editor.removeAttribute('id');
      const sync = () => {
        const hasText = Boolean(editor.innerText.trim());
        const button = slot.querySelector('button');
        if (hasText && !button) slot.append(sendButton(false));
        if (!hasText && button) button.remove();
      };
      editor.addEventListener('input', sync);
      new MutationObserver(sync).observe(editor, { childList: true, characterData: true, subtree: true });
      return true;
    }
    if (mode === 'disabled') {
      const button = sendButton(true);
      slot.append(button);
      setTimeout(() => { button.disabled = false; }, delayMs);
    } else {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.dataset.testid = 'stop-button';
      stop.setAttribute('aria-label', 'Stop streaming');
      stop.textContent = '■';
      slot.append(stop);
      setTimeout(() => { stop.remove(); slot.append(sendButton(false)); }, delayMs);
    }
    return true;
  };
</script></body></html>`;

describe.runIf(enabled)("send button after a reply in real Chrome", () => {
  let chrome: chromeLauncher.LaunchedChrome;
  let client: Awaited<ReturnType<typeof CDP>>;
  let userDataDir: string;

  beforeAll(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-send-fixture-"));
    chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=900,700", "--no-first-run"],
      userDataDir,
    });
    client = await CDP({ port: chrome.port });
    await Promise.all([client.Page.enable(), client.Runtime.enable()]);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    chrome?.kill();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test.each([
    ["disabled", "a send button mounted disabled and enabled later"],
    ["stop", "the finishing reply's stop button, then the send button"],
  ])(
    "the prompt is sent by its button once it is ready, never by an ignored Enter (%s: %s)",
    async (mode) => {
      await client.Page.navigate({
        url: `data:text/html;base64,${Buffer.from(FIXTURE).toString("base64")}`,
      });
      await client.Page.loadEventFired();
      await client.Runtime.evaluate({ expression: `window.setup(${JSON.stringify(mode)}, 1500)` });
      const logger = Object.assign(vi.fn(), { verbose: false });
      await expect(
        submitPrompt(
          { runtime: client.Runtime, input: client.Input, baselineTurns: 1 },
          "Reply with exactly one word: steady",
          logger as never,
        ),
      ).resolves.toBe(2);
      const { result } = await client.Runtime.evaluate({
        expression: "window.log",
        returnByValue: true,
      });
      expect(result.value).toEqual(["click"]);
      expect(logger).toHaveBeenCalledWith("Activated send button");
      expect(logger).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^Send button ready after \\d+\\.\\ds \\(the composer showed: ${mode}\\)$`),
        ),
      );
    },
    120_000,
  );

  test("after an in-page move the prompt goes into the visible composer, not the hidden home one", async () => {
    await client.Page.navigate({
      url: `data:text/html;base64,${Buffer.from(FIXTURE).toString("base64")}`,
    });
    await client.Page.loadEventFired();
    await client.Runtime.evaluate({ expression: "window.setup('hidden-home', 0)" });
    const logger = Object.assign(vi.fn(), { verbose: false });
    await expect(
      submitPrompt(
        { runtime: client.Runtime, input: client.Input, baselineTurns: 1 },
        "Reply with exactly one word: steady",
        logger as never,
      ),
    ).resolves.toBe(2);
    const { result } = await client.Runtime.evaluate({
      expression:
        "({ log: window.log, turn: document.querySelector('[data-testid=\"conversation-turn-2\"]')?.textContent })",
      returnByValue: true,
    });
    expect(result.value).toEqual({ log: ["click"], turn: "Reply with exactly one word: steady" });
    expect(logger).toHaveBeenCalledWith("Activated send button");
  }, 120_000);

  test("a multi-line prompt after an in-page move is pasted into the visible composer", async () => {
    await client.Page.navigate({
      url: `data:text/html;base64,${Buffer.from(FIXTURE).toString("base64")}`,
    });
    await client.Page.loadEventFired();
    await client.Runtime.evaluate({ expression: "window.setup('hidden-home', 0)" });
    // The fixture editor has no paste handler; insert the pasted text like ProseMirror does.
    await client.Runtime.evaluate({
      expression: `document.addEventListener('paste', (event) => {
        const target = event.target.closest('[contenteditable]');
        if (!target) return;
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        for (const line of text.split('\\n')) { const p = document.createElement('p'); p.textContent = line; target.append(p); }
        target.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, true); true`,
    });
    const logger = Object.assign(vi.fn(), { verbose: false });
    await expect(
      submitPrompt(
        { runtime: client.Runtime, input: client.Input, baselineTurns: 1 },
        "First line\nSecond line",
        logger as never,
      ),
    ).resolves.toBe(2);
    const { result } = await client.Runtime.evaluate({
      expression: "window.log",
      returnByValue: true,
    });
    expect(result.value).toEqual(["click"]);
  }, 120_000);
});
