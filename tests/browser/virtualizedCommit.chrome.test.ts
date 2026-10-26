import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { chatgptDomProvider } from "../../src/browser/providers/chatgptDomProvider.js";

// Real-Chrome fixture of a follow-up in a long conversation (2026-10-26, session
// ask-20261026-152910-ixje): ChatGPT keeps only a window of four exchanges rendered, so the new
// exchange unmounts the oldest and the turn count stays at four. The send is proven by the new
// user turn's identity, and the answer that follows it is captured. Run with
// ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";
const PROMPT = "CODEXish Next round: W5sub2 fix round 2";
const ANSWER = "W5sub2 fix round 2: the fix and its checks.";

// Exchanges as probed on the real page: div[data-turn-key=<user message id>] holding a
// div[data-content-search-turn-key], with ":user" / ":assistant" units carrying
// data-chatgpt-search-message-ids. Without ids: conversation-turn containers and role attributes.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; margin: 0; }
  form { position: fixed; left: 20px; right: 20px; bottom: 20px; height: 80px; border: 1px solid #888; }
  [contenteditable] { position: absolute; left: 8px; top: 8px; right: 80px; bottom: 8px; }
  #slot button { position: absolute; right: 8px; bottom: 8px; width: 40px; height: 32px; }
</style></head><body>
<main id="thread"></main>
<form data-chatgpt-composer>
  <div contenteditable="true" role="textbox" id="prompt-textarea" class="ProseMirror"></div>
  <span id="slot"><button type="button" data-testid="send-button" aria-label="Send prompt">↑</button></span>
</form>
<script>
  const thread = document.getElementById('thread');
  const editor = document.getElementById('prompt-textarea');
  let counter = 0;
  let mode = { ids: true, windowed: true };
  const userUnit = (n, text) => mode.ids
    ? '<div data-chatgpt-search-unit-key="u' + n + ':user" data-chatgpt-search-message-ids="u' + n + '"><div data-user-message-bubble="true">' + text + '</div></div>'
    : '<div data-message-author-role="user"><div data-user-message-bubble="true">' + text + '</div></div>';
  const assistantUnit = (n, text) => (mode.ids
    ? '<div data-chatgpt-search-unit-key="a' + n + ':assistant" data-chatgpt-search-message-ids="a' + n + '">'
    : '<div data-message-author-role="assistant">') +
    '<div class="markdown"><p>' + text + '</p></div><div class="turn-action-controls"><button type="button" data-testid="copy-turn-action-button" aria-label="Copy">c</button></div></div>';
  const exchange = (user, answer) => {
    counter += 1;
    const node = document.createElement('div');
    if (mode.ids) node.setAttribute('data-turn-key', 'u' + counter);
    else node.setAttribute('data-testid', 'conversation-turn-' + counter);
    node.innerHTML = '<div data-content-search-turn-key="k' + counter + '">' + userUnit(counter, user) + (answer ? assistantUnit(counter, answer) : '') + '</div>';
    thread.append(node);
    return { node, n: counter };
  };
  window.setup = (ids, windowed) => {
    mode = { ids, windowed };
    for (let i = 1; i <= 4; i += 1) exchange('Earlier question ' + i, 'Earlier answer ' + i);
    return true;
  };
  document.querySelector('[data-testid="send-button"]').addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const sent = editor.innerText.trim();
    editor.textContent = '';
    const { node, n } = exchange(sent, null);
    // The window keeps four exchanges: the oldest unmounts for the new one.
    if (mode.windowed) thread.firstElementChild.remove();
    setTimeout(() => {
      node.firstElementChild.insertAdjacentHTML('beforeend', assistantUnit(n, ${JSON.stringify(ANSWER)}));
    }, 1500);
  });
</script></body></html>`;

describe.runIf(enabled)(
  "a send in a long conversation with a window of rendered turns (real Chrome)",
  () => {
    let chrome: chromeLauncher.LaunchedChrome;
    let client: Awaited<ReturnType<typeof CDP>>;
    let userDataDir: string;

    beforeAll(async () => {
      userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-virtualized-commit-"));
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

    /** The run's submission and answer wait through the ChatGPT provider (as index.ts drives it). */
    async function sendAndWait(ids: boolean, windowed: boolean) {
      await client.Page.navigate({
        url: `data:text/html;base64,${Buffer.from(FIXTURE).toString("base64")}`,
      });
      await client.Page.loadEventFired();
      await client.Runtime.evaluate({ expression: `window.setup(${ids}, ${windowed})` });
      const logger = Object.assign(vi.fn(), { verbose: false });
      const state: Record<string, unknown> = {
        runtime: client.Runtime,
        input: client.Input,
        logger,
        timeoutMs: 30_000,
        inputTimeoutMs: 1_000,
        // The run reads the count before the send: four rendered exchanges.
        baselineTurns: 4,
      };
      const ctx = { prompt: PROMPT, evaluate: async () => undefined, delay: async () => {}, state };
      const startedAt = Date.now();
      await chatgptDomProvider.submitPrompt(ctx as never);
      const submitMs = Date.now() - startedAt;
      const answer = await chatgptDomProvider.waitForResponse(ctx as never);
      return { state, answer, logger, submitMs };
    }

    test("with message ids, the new user turn proves the send at once, and its answer is captured", async () => {
      const { state, answer, submitMs } = await sendAndWait(true, true);
      expect(state.committedTurns).toBe(4);
      // The answer wait starts at the sent user turn, below the count before the send.
      expect(state.baselineTurns).toBe(3);
      expect(state.commitUnproven).toBeUndefined();
      expect(submitMs).toBeLessThan(20_000);
      expect(answer.text.trim()).toBe(ANSWER);
    }, 150_000);

    test("without ids, an unproven send that shows the prompt goes on to the answer", async () => {
      const { state, answer, logger } = await sendAndWait(false, true);
      expect(state.commitUnproven).toBe(true);
      expect(state.unprovenCommitTurn).toEqual({ index: 3, text: PROMPT, messageId: null });
      expect(state.baselineTurns).toBe(3);
      expect(logger).toHaveBeenCalledWith(
        expect.stringMatching(/^\[browser\] Prompt commit not proven \(.*\); treating it as sent/),
      );
      expect(answer.text.trim()).toBe(ANSWER);
    }, 150_000);

    test("without ids on a page whose turn count grows, the count still proves the send", async () => {
      const { state, answer, submitMs } = await sendAndWait(false, false);
      expect(state.committedTurns).toBe(5);
      expect(state.commitUnproven).toBeUndefined();
      expect(submitMs).toBeLessThan(20_000);
      expect(answer.text.trim()).toBe(ANSWER);
    }, 150_000);
  },
);
