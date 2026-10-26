import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { createTurnResync } from "../../src/browser/turnResync.js";
import { waitForAssistantResponse } from "../../src/browser/actions/assistantResponse.js";
import {
  buildInterruptedBannerDiagnosticExpression,
  buildInterruptedBannerExpression,
  type InterruptedBannerDiagnostic,
  type InterruptedBannerDiagnosticPage,
} from "../../src/browser/interruptedBanner.js";

// Real-Chrome fixture of ChatGPT's "Connection interrupted. Waiting for the complete answer"
// banner (2026-10-26, ask-20261026-134247-ynwq: the work was done, the page sat on the banner with
// Stop shown, and only a reload cleared it). The conversation is served over HTTP so that
// Page.reload loads it again. Its real markup was never captured: the banner here is a status
// row below the turn. Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";
const ID = "6add23d8-aaaa-4bbb-8ccc-0000000000b1";
const BANNER_TEXT = "Connection interrupted. Waiting for the complete answer";
const FINAL = "The build passed and the report is committed.";
const PARTIAL = "The build passed";

const STOP =
  '<button type="button" data-testid="stop-button" aria-label="Stop streaming">■</button>';
const ACTIONS =
  '<div class="turn-action-controls"><button type="button" data-testid="copy-turn-action-button" aria-label="Copy">c</button></div>';
const BANNER = `<div class="flex justify-center py-2"><div role="status" class="interrupted-banner rounded-xl border px-3 py-2"><span>${BANNER_TEXT}</span></div></div>`;
// Text on the page that stays across reloads and must never count as the banner.
const SIDEBAR_TITLE = `<nav aria-label="Chat history"><a href="/c/other"><div class="truncate">Connection interrupted</div></a></nav>`;
const ACTIVITY_ROW = `<div class="activity-row">Searching for "Connection interrupted"</div>`;
// Round 8c (Astra r16): ChatGPT's activity captions are nested spans next to a disclosure.
const NESTED_ROW = `<div class="activity-row">Searching for "<span>Connection interrupted</span>"</div>`;
const DISCLOSURE = `<button type="button" aria-expanded="false"><span>Connection interrupted</span></button>`;
const APPROVAL_CARD = `<div class="rounded-3xl border" data-codex-approval-surface="true"><div role="alert"><div>Connection interrupted</div><div>Allow ChatGPT to use CODEXish?</div></div><form><button type="button">Allow once</button></form></div>`;

type Story = "banner-then-cleared" | "quoted" | "decoys" | "inside-markdown";

/**
 * The conversation on load `load`.
 * - "banner-then-cleared": the first load shows the turn with Stop and the banner below it; a
 *   reload shows the finished answer.
 * - "quoted": the user and the answer quote the banner's words, a screen-reader copy holds them
 *   too, and the turn keeps generating.
 * - "decoys": the words in a sidebar title, an activity row, a disclosure, an approval card, a
 *   role-less user turn and an older exchange; the turn keeps generating.
 * - "inside-markdown": the banner's words at the end of the answer's Markdown (where the real
 *   banner might render); a reload shows the finished answer.
 */
function conversation(load: number, story: Story): string {
  const finishes = story === "banner-then-cleared" || story === "inside-markdown";
  const finished = finishes && load > 1;
  const user =
    story === "quoted"
      ? `Why does ChatGPT say "${BANNER_TEXT}" sometimes?`
      : "Build it and commit the report.";
  const answer = finished
    ? `<p>${FINAL}</p>`
    : story === "quoted"
      ? `<p>When the stream drops, the page shows "${BANNER_TEXT}" until it reconnects.</p>`
      : story === "inside-markdown"
        ? `<p>${PARTIAL}</p><p>${BANNER_TEXT}</p>`
        : `<p>${PARTIAL}</p>`;
  const generating = !finished;
  const decoys = story === "decoys";
  // Today's user turn has no role attribute (appApprovals.ts USER).
  const userTurn = decoys
    ? `<div class="rich-text-user-turn group/user-message"><p>${user} Connection interrupted</p></div>`
    : `<div data-message-author-role="user"><div data-user-message-bubble="true">${user}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Build</title><style>
  body { margin: 0; font: 14px sans-serif; } main { padding: 16px 16px 140px; }
  #composer { position: fixed; left: 0; right: 0; bottom: 0; height: 90px; background: #fff; border-top: 1px solid #888; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
</style></head><body>
${decoys ? SIDEBAR_TITLE : ""}
<main>
  <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div>Earlier question</div></div></div>
  <div data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="m2"><div class="markdown"><p>Earlier answer that is never the answer.</p></div></div>${ACTIONS}${decoys ? BANNER : ""}</div>
  <div data-testid="conversation-turn-3">${userTurn}</div>
  <div data-testid="conversation-turn-4" id="turn">${decoys ? ACTIVITY_ROW + NESTED_ROW + DISCLOSURE : ""}<div data-message-author-role="assistant" data-message-id="m4"><div class="markdown">${answer}</div></div>${finished ? ACTIONS : ""}${decoys ? APPROVAL_CARD : ""}</div>
  ${story === "banner-then-cleared" && load === 1 ? BANNER : ""}
  ${story === "quoted" ? `<div class="sr-only" aria-live="polite">${BANNER_TEXT}</div>` : ""}
</main>
<form id="composer"><div contenteditable="true" role="textbox" class="ProseMirror"></div>${generating ? STOP : ""}</form>
</body></html>`;
}

const USER_TURN =
  '<div data-message-author-role="user"><div data-user-message-bubble="true">Build it.</div></div>';
/** A page whose thread holds the latest user turn, then `after` (and `before` it). */
const thread = (after: string, options: { before?: string; outside?: string } = {}) =>
  `${options.outside ?? ""}<main>${options.before ?? ""}${USER_TURN}${after}</main>`;

/** Placements of the banner's words: [name, body markup, counted as the banner]. */
const PLACEMENTS: Array<[string, string, boolean]> = [
  ["a status row below the latest turn", thread(BANNER), true],
  [
    "words split over elements",
    thread(
      '<div role="status"><span>Connection</span> <b>interrupted.</b> <span>Waiting for the</span> <span>complete answer</span></div>',
    ),
    true,
  ],
  [
    "inside the assistant message, outside its Markdown",
    thread(
      `<div data-message-author-role="assistant"><div class="markdown"><p>${PARTIAL}</p></div><div class="note">${BANNER_TEXT}</div></div>`,
    ),
    true,
  ],
  ["only the second sentence", thread("<div>Waiting for the complete answer</div>"), true],
  [
    "quoted in the answer's Markdown",
    thread(
      `<div data-message-author-role="assistant"><div class="markdown"><p>It said "${BANNER_TEXT}".</p></div></div>`,
    ),
    false,
  ],
  [
    "in the latest user message",
    `<main><div data-message-author-role="user"><div data-user-message-bubble="true">${BANNER_TEXT}</div></div></main>`,
    false,
  ],
  [
    "in a role-less user turn",
    `<main>${USER_TURN}<div class="rich-text-user-turn"><p>${BANNER_TEXT}</p></div></main>`,
    false,
  ],
  ["in a code block", thread(`<pre><code>${BANNER_TEXT}</code></pre>`), false],
  ["in a blockquote", thread(`<blockquote>${BANNER_TEXT}</blockquote>`), false],
  [
    "a screen-reader-only copy",
    thread(
      `<div style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">${BANNER_TEXT}</div>`,
    ),
    false,
  ],
  ["hidden", thread(`<div style="display:none">${BANNER_TEXT}</div>`), false],
  ["invisible", thread(`<div style="visibility:hidden">${BANNER_TEXT}</div>`), false],
  [
    "typed in the composer",
    thread(`<div contenteditable="true" role="textbox">${BANNER_TEXT}</div>`),
    false,
  ],
  [
    "inside a longer paragraph of page text",
    thread(`<p>${"Release notes. ".repeat(30)}${BANNER_TEXT}</p>`),
    false,
  ],
  ["a sidebar conversation title", thread("", { outside: SIDEBAR_TITLE }), false],
  ["a sidebar inside the thread area", thread(`<aside><div>${BANNER_TEXT}</div></aside>`), false],
  ["an activity row that quotes it", thread(ACTIVITY_ROW), false],
  ["an activity row with the words in a nested span", thread(NESTED_ROW), false],
  [
    "a quoted caption with the words in a nested span",
    thread('<div class="caption">“<span>Connection interrupted</span>”</div>'),
    false,
  ],
  [
    "an activity caption of spans in a flex row",
    thread(
      '<div style="display:flex;gap:4px"><span>Searching for</span><span>Connection interrupted</span></div>',
    ),
    false,
  ],
  [
    "the banner's sentences in their own spans in a status row",
    thread(
      '<div role="status"><span>Connection interrupted.</span> <span>Waiting for the complete answer</span></div>',
    ),
    true,
  ],
  [
    "the banner after a one-word label",
    thread('<div role="alert"><span>Warning:</span> <span>Connection interrupted.</span></div>'),
    true,
  ],
  [
    "the banner's status region next to other rows of the turn",
    thread(
      '<div class="turn"><div>Searching the web</div><div role="status"><span>Connection interrupted.</span> <span>Waiting for the complete answer</span></div></div>',
    ),
    true,
  ],
  ["an activity disclosure", thread(DISCLOSURE), false],
  [
    "a reasoning summary",
    thread(`<details open><summary>Connection interrupted</summary><p>steps</p></details>`),
    false,
  ],
  ["an approval card", thread(APPROVAL_CARD), false],
  ["a dialog", thread(`<div role="dialog"><p>${BANNER_TEXT}</p></div>`), false],
  ["an older exchange", thread("", { before: BANNER }), false],
  ["a page without a user turn", `<main>${BANNER}</main>`, false],
  [
    "outside the thread area",
    `<main>${USER_TURN}</main><div role="status">${BANNER_TEXT}</div>`,
    false,
  ],
];

describe.runIf(enabled)('"Connection interrupted" banner (real Chrome)', () => {
  let chrome: chromeLauncher.LaunchedChrome | undefined;
  let userDataDir = "";
  let server: http.Server | undefined;
  let base = "";
  let story: Story = "banner-then-cleared";
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
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-interrupted-banner-"));
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

  async function onBlankPage<T>(
    run: (
      show: (body: string) => Promise<void>,
      read: (expression: string) => Promise<unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    const client = await CDP({ port: chrome!.port });
    try {
      const { Page, Runtime } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await Page.navigate({ url: "about:blank" });
      await Page.loadEventFired();
      const show = async (body: string) => {
        await Runtime.evaluate({ expression: `document.body.innerHTML = ${JSON.stringify(body)}` });
      };
      const read = async (expression: string) =>
        (await Runtime.evaluate({ expression, returnByValue: true })).result.value;
      return await run(show, read);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  test("the banner counts only in the thread, below the latest user turn, where nobody wrote it and where it is seen", async () => {
    await onBlankPage(async (show, read) => {
      // Every placement is read, so a failure names all of them.
      const seen: Array<[string, boolean]> = [];
      for (const [name, body] of PLACEMENTS) {
        await show(body);
        const value = (await read(buildInterruptedBannerExpression())) as { text?: string } | null;
        seen.push([name, Boolean(value?.text)]);
      }
      expect(seen).toEqual(PLACEMENTS.map(([name, , detected]) => [name, detected]));
    });
  }, 60_000);

  test("the diagnostic records the words wherever they are shown, message text withheld, with the run's stop check", async () => {
    await onBlankPage(async (show, read) => {
      const diagnostic = async (body: string) => {
        await show(body);
        return (await read(
          buildInterruptedBannerDiagnosticExpression(),
        )) as InterruptedBannerDiagnosticPage | null;
      };
      // The banner, with today's composer stop button (not the legacy test id).
      const banner = await diagnostic(
        `${thread(BANNER)}<form><button data-testid="composer-stop-button" aria-label="Stop">■</button></form>`,
      );
      expect(banner).toMatchObject({
        detected: true,
        insideMessageBody: false,
        withheld: false,
        stopVisible: true,
      });
      // A stop button that keeps its box but is not visible is not shown.
      const hiddenStop = await diagnostic(
        `${thread(BANNER)}<form>${STOP.replace("<button", '<button style="visibility:hidden"')}</form>`,
      );
      expect(hiddenStop?.stopVisible).toBe(false);
      // Inside the answer's Markdown: recorded, never counted; only the phrase is kept.
      const markdown = await diagnostic(
        thread(
          `<div data-message-author-role="assistant"><div class="markdown"><p>Private findings. ${BANNER_TEXT}</p></div></div>`,
        ),
      );
      expect(markdown).toMatchObject({
        detected: false,
        insideMessageBody: true,
        withheld: true,
        text: "connection interrupted",
        bannerHtml: "",
        html: "",
      });
      expect(JSON.stringify(markdown)).not.toContain("Private findings");
      expect(markdown?.ancestors.map((node) => node.className)).toContain("markdown");
      // A sidebar title: recorded alone, without the list around it.
      const sidebar = await diagnostic(thread("", { outside: SIDEBAR_TITLE }));
      expect(sidebar).toMatchObject({ detected: false, insideMessageBody: false, html: "" });
      expect(sidebar?.bannerHtml).toBe('<div class="truncate">Connection interrupted</div>');
      expect(await diagnostic(thread("<p>Nothing to see.</p>"))).toBeNull();
    });
  }, 60_000);

  async function waitOnTurn(waitMs: number, stallMs?: number) {
    loads = 0;
    const client = await CDP({ port: chrome!.port });
    try {
      const { Page, Runtime } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      const url = `${base}/c/${ID}`;
      await Page.navigate({ url });
      await Page.loadEventFired();
      const logger = Object.assign(vi.fn(), { verbose: false });
      const diagnostics: InterruptedBannerDiagnostic[] = [];
      // Without stallMs the run's stall time (8 minutes) holds: only the banner may reload.
      const resync = createTurnResync({
        Runtime,
        Page,
        logger,
        conversationUrl: () => url,
        pollMs: 500,
        ...(stallMs ? { stallMs } : {}),
        saveInterruptedBannerDiagnostic: async (diagnostic) => {
          diagnostics.push(diagnostic);
          return "artifacts/interrupted-banner-diag-1.html";
        },
      });
      const startedAt = Date.now();
      const outcome = await resync
        .run(
          (attempt) =>
            // Two turns were there before the prompt; the conversation id is the run's.
            waitForAssistantResponse(
              Runtime,
              attempt.remainingMs(waitMs),
              logger,
              2,
              ID,
              attempt.signal,
            ),
          { timeoutMs: waitMs },
        )
        .then(
          (answer) => ({ answer }),
          (error: unknown) => ({ error }),
        );
      const lines = logger.mock.calls.map(([line]) => String(line));
      return { outcome, lines, diagnostics, ms: Date.now() - startedAt };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  test("the banner on a generating turn reloads the conversation at once, and the sent turn's answer is captured", async () => {
    story = "banner-then-cleared";
    const { outcome, lines, diagnostics, ms } = await waitOnTurn(90_000);
    expect(outcome).toMatchObject({ answer: { text: FINAL, meta: { messageId: "m4" } } });
    expect(loads).toBe(2);
    // Two reads half a second apart, the reload and its settle: seconds, not the 8-minute stall.
    expect(ms).toBeLessThan(45_000);
    expect(lines).toContain(
      '[browser] ChatGPT shows "Connection interrupted"; reloading the conversation now',
    );
    expect(lines.filter((line) => line.includes("Turn looks stalled"))).toEqual([]);
    expect(lines).toContain(
      '[browser] "Connection interrupted" diagnostic saved: artifacts/interrupted-banner-diag-1.html',
    );
    expect(diagnostics).toHaveLength(1);
    const page = diagnostics[0]!.page!;
    expect(page.text).toContain("connection interrupted");
    expect(page.detected).toBe(true);
    expect(page.withheld).toBe(false);
    // The element holding the words, and around it up to the thread: the status row.
    expect(page.bannerHtml).toBe(`<span>${BANNER_TEXT}</span>`);
    expect(page.html).toContain('role="status"');
    expect(page.html).toContain("interrupted-banner");
    expect(page.stopVisible).toBe(true);
    expect(page.ancestors[0]).toMatchObject({ tag: "span" });
  }, 120_000);

  test("the banner's words quoted by the user and the answer, or read out to a screen reader, never reload", async () => {
    story = "quoted";
    const { outcome, lines, diagnostics } = await waitOnTurn(8_000);
    // The turn keeps generating until the wait's own time ends; the page was loaded once.
    expect(outcome).toHaveProperty("error");
    expect(loads).toBe(1);
    expect(lines.filter((line) => line.includes("Connection interrupted"))).toEqual([]);
    expect(diagnostics).toEqual([]);
  }, 60_000);

  test("the words in a sidebar title, activity rows, an approval card, a role-less user turn or an older exchange never reload", async () => {
    story = "decoys";
    const { outcome, lines, diagnostics } = await waitOnTurn(8_000);
    expect(outcome).toHaveProperty("error");
    expect(loads).toBe(1);
    expect(lines.filter((line) => line.includes("Connection interrupted"))).toEqual([]);
    expect(diagnostics).toEqual([]);
  }, 60_000);

  test("words inside the answer's Markdown never reload; a stall reload records them first and the answer is captured", async () => {
    story = "inside-markdown";
    const { outcome, lines, diagnostics } = await waitOnTurn(60_000, 3_000);
    expect(outcome).toMatchObject({ answer: { text: FINAL, meta: { messageId: "m4" } } });
    expect(loads).toBe(2);
    expect(lines.filter((line) => line.includes('shows "Connection interrupted"'))).toEqual([]);
    expect(lines).toContain(
      "[browser] Turn looks stalled (no change for 3s); reloading the conversation to resync",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      reason: "Before a stall reload (no change for 3s)",
      page: {
        detected: false,
        insideMessageBody: true,
        withheld: true,
        text: "connection interrupted",
        stopVisible: true,
      },
    });
    expect(JSON.stringify(diagnostics[0])).not.toContain(PARTIAL);
  }, 90_000);
});
