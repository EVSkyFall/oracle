import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { chatgptDomProvider } from "../../src/browser/providers/chatgptDomProvider.js";
import { buildConversationTurnCountExpression } from "../../src/browser/conversationTurns.js";
import { readUserMessageIds } from "../../src/browser/promptFingerprint.js";
import { waitAtSentTurn } from "../../src/browser/sentTurnScope.js";
import { waitForAssistantResponse } from "../../src/browser/actions/assistantResponse.js";

// Real-Chrome fixture of sends in a long conversation (2026-10-26: session
// ask-20261026-152910-ixje, a --followup resume, and window-tall-build, in-run follow-up 4 of a
// conversation with tall answers): ChatGPT keeps only a window of exchanges rendered, so a new
// exchange unmounts the oldest and the turn count stays the same. The send is proven by the new
// user turn's identity, and the answer that follows that turn is captured. Driven through the
// ChatGPT provider as the run drives it (index.ts: the turn count and the user turn ids read
// before each send). Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";
const PROMPT = "CODEXish Next round: W5sub2 fix round 2, with the checks listed in the brief";
const answerTo = (prompt: string) => `Answer to: ${prompt}`;
// A round template longer than the 120 characters the text match compares.
const ROUND_TEMPLATE = `${PROMPT}. Run the full check list, report each failing case with its cause, and keep the notes short.`;

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
  let mode = {};
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
    // The window keeps the latest exchanges only: the oldest unmounts.
    while (mode.window && thread.children.length > mode.window) thread.firstElementChild.remove();
    return { node, n: counter };
  };
  // ids: message ids on the units; window: exchanges kept rendered (0: all); initial: the earlier
  // turns' prompts; lost: the click sends nothing; lateMs: the new exchange mounts this late.
  window.setup = (options) => {
    mode = options;
    for (const [i, text] of options.initial.entries()) exchange(text, 'Earlier answer ' + (i + 1));
    return true;
  };
  document.querySelector('[data-testid="send-button"]').addEventListener('click', (event) => {
    if (!event.isTrusted || mode.lost) return;
    const sent = editor.innerText.trim();
    editor.textContent = '';
    setTimeout(() => {
      const { node, n } = exchange(sent, null);
      setTimeout(() => {
        node.firstElementChild.insertAdjacentHTML('beforeend', assistantUnit(n, 'Answer to: ' + sent));
      }, 1500);
    }, mode.lateMs ?? 0);
  });
</script></body></html>`;

const earlier = (count: number) =>
  Array.from({ length: count }, (_, i) => `Earlier question ${i + 1}`);

describe.runIf(enabled)(
  "sends in a long conversation with a window of rendered turns (real Chrome)",
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

    async function open(options: Record<string, unknown>) {
      await client.Page.navigate({
        url: `data:text/html;base64,${Buffer.from(FIXTURE).toString("base64")}`,
      });
      await client.Page.loadEventFired();
      await client.Runtime.evaluate({ expression: `window.setup(${JSON.stringify(options)})` });
    }

    /** One send as the run makes it: the count and the user turn ids before, then the provider. */
    async function send(prompt: string) {
      const { result } = await client.Runtime.evaluate({
        expression: buildConversationTurnCountExpression(),
        returnByValue: true,
      });
      const previousUserMessageIds = await readUserMessageIds(client.Runtime, 1_000);
      const logger = Object.assign(vi.fn(), { verbose: false });
      const state: Record<string, unknown> = {
        runtime: client.Runtime,
        input: client.Input,
        logger,
        timeoutMs: 30_000,
        inputTimeoutMs: 1_000,
        baselineTurns: result.value,
        previousUserMessageIds,
      };
      const ctx = { prompt, evaluate: async () => undefined, delay: async () => {}, state };
      const startedAt = Date.now();
      const outcome = await chatgptDomProvider.submitPrompt(ctx as never).then(
        () => ({ sent: true as const }),
        (error: unknown) => ({ error: error as Error }),
      );
      return {
        ctx,
        state,
        logger,
        outcome,
        previousUserMessageIds,
        submitMs: Date.now() - startedAt,
      };
    }
    const answerOf = async (ctx: unknown) =>
      (await chatgptDomProvider.waitForResponse(ctx as never)).text.trim();

    test("with message ids, the new user turn proves the send at once, and its answer is captured", async () => {
      await open({ ids: true, window: 4, initial: earlier(4) });
      const { ctx, state, submitMs } = await send(PROMPT);
      expect(state.committedTurns).toBe(4);
      // The answer wait starts at the sent user turn, below the count before the send.
      expect(state.baselineTurns).toBe(3);
      expect(state.commitUnproven).toBeUndefined();
      expect(submitMs).toBeLessThan(20_000);
      expect(await answerOf(ctx)).toBe(answerTo(PROMPT));
    }, 150_000);

    test("in-run follow-ups on a growing conversation stay proven when the window starts unmounting turns", async () => {
      // window-tall-build: the 5th turn (follow-up 4) was the first whose send unmounted turn 1.
      await open({ ids: true, window: 4, initial: earlier(1) });
      for (let followUp = 1; followUp <= 4; followUp += 1) {
        const prompt = `Follow-up ${followUp}: print 1..150, one per line`;
        const { ctx, state, submitMs } = await send(prompt);
        expect(state.commitUnproven, `follow-up ${followUp}`).toBeUndefined();
        expect(submitMs).toBeLessThan(20_000);
        expect(await answerOf(ctx), `follow-up ${followUp}`).toBe(answerTo(prompt));
      }
    }, 300_000);

    test("a lost click is not sent, even when an older user turn shares the prompt's first 120 characters", async () => {
      await open({
        ids: true,
        window: 4,
        initial: [...earlier(3), `${ROUND_TEMPLATE} Previous round.`],
        lost: true,
      });
      const { outcome, state } = await send(`${ROUND_TEMPLATE} This round.`);
      expect("error" in outcome && outcome.error.message).toMatch(
        /Prompt did not appear in conversation before timeout/,
      );
      expect(state.commitUnproven).toBeUndefined();
    }, 150_000);

    test("an exchange that mounts after the commit window: the answer wait finds the sent turn by id", async () => {
      await open({ ids: true, window: 4, initial: earlier(4), lateMs: 65_000 });
      const { state, logger, previousUserMessageIds } = await send(PROMPT);
      // Unproven: no new turn by id within the window, and no older turn stands in for it.
      expect(state.commitUnproven).toBe(true);
      expect(state.unprovenCommitTurn).toBeNull();
      expect(state.baselineTurns).toBe(4);
      expect(logger).toHaveBeenCalledWith(
        expect.stringMatching(/^\[browser\] Prompt commit not proven \(.*\); treating it as sent/),
      );
      // The run's answer-wait attempt (index.ts scopedToSentTurn): it starts at once at the old
      // scope (4), and is restarted at the sent turn when the exchange mounts at 3.
      const moves: number[] = [];
      const scopes: number[] = [];
      const answer = await waitAtSentTurn(
        client.Runtime,
        {
          previousUserMessageIds: previousUserMessageIds!,
          current: () => state.baselineTurns as number,
          moveTo: (index) => {
            moves.push(index);
            state.baselineTurns = index;
          },
        },
        { signal: new AbortController().signal, remainingMs: (total) => total },
        60_000,
        (inner) => {
          scopes.push(state.baselineTurns as number);
          return waitForAssistantResponse(
            client.Runtime,
            inner.remainingMs(60_000),
            logger,
            state.baselineTurns as number,
            undefined,
            inner.signal,
          );
        },
      );
      expect(scopes).toEqual([4, 3]);
      expect(moves).toEqual([3]);
      expect(answer.text.trim()).toBe(answerTo(PROMPT));
    }, 180_000);

    test("without ids, an unproven windowed send goes on but never lowers the scope onto an older turn", async () => {
      await open({ ids: false, window: 4, initial: earlier(4) });
      const { state, outcome, logger } = await send(PROMPT);
      expect(outcome).toEqual({ sent: true });
      expect(state.commitUnproven).toBe(true);
      // With the count unchanged, the latest user turn could be an older one: no stand-in.
      expect(state.unprovenCommitTurn).toBeNull();
      expect(state.baselineTurns).toBe(4);
      expect(logger).toHaveBeenCalledWith(
        expect.stringMatching(/^\[browser\] Prompt commit not proven \(.*\); treating it as sent/),
      );
    }, 150_000);

    test("without ids on a page whose turn count grows, the count still proves the send", async () => {
      await open({ ids: false, window: 0, initial: earlier(4) });
      const { ctx, state, submitMs } = await send(PROMPT);
      expect(state.committedTurns).toBe(5);
      expect(state.commitUnproven).toBeUndefined();
      expect(submitMs).toBeLessThan(20_000);
      expect(await answerOf(ctx)).toBe(answerTo(PROMPT));
    }, 150_000);
  },
);
