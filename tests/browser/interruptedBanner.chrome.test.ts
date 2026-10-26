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
  buildInterruptedBannerExpression,
  type InterruptedBannerDiagnostic,
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

type Story = "banner-then-cleared" | "quoted";

/**
 * The conversation on load `load`. "banner-then-cleared": the first load shows the turn with Stop
 * and the banner, a reload shows the finished answer. "quoted": the user and the answer quote the
 * banner's words, a screen-reader copy holds them too, and the turn keeps generating.
 */
function conversation(load: number, story: Story): string {
  const interrupted = story === "banner-then-cleared" && load === 1;
  const finished = story === "banner-then-cleared" && load > 1;
  const user =
    story === "quoted"
      ? `Why does ChatGPT say "${BANNER_TEXT}" sometimes?`
      : "Build it and commit the report.";
  const answer = finished
    ? `<p>${FINAL}</p>`
    : story === "quoted"
      ? `<p>When the stream drops, the page shows "${BANNER_TEXT}" until it reconnects.</p>`
      : `<p>${PARTIAL}</p>`;
  const generating = !finished;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Build</title><style>
  body { margin: 0; font: 14px sans-serif; } main { padding: 16px 16px 140px; }
  #composer { position: fixed; left: 0; right: 0; bottom: 0; height: 90px; background: #fff; border-top: 1px solid #888; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
</style></head><body>
<main>
  <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div>Earlier question</div></div></div>
  <div data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="m2"><div class="markdown"><p>Earlier answer that is never the answer.</p></div></div>${ACTIONS}</div>
  <div data-testid="conversation-turn-3"><div data-message-author-role="user"><div data-user-message-bubble="true">${user}</div></div></div>
  <div data-testid="conversation-turn-4" id="turn"><div data-message-author-role="assistant" data-message-id="m4"><div class="markdown">${answer}</div></div>${finished ? ACTIONS : ""}</div>
  ${interrupted ? BANNER : ""}
  ${story === "quoted" ? `<div class="sr-only" aria-live="polite">${BANNER_TEXT}</div>` : ""}
</main>
<form id="composer"><div contenteditable="true" role="textbox" class="ProseMirror"></div>${generating ? STOP : ""}</form>
</body></html>`;
}

/** Banner placements for the detection checks: [name, markup, detected]. */
const PLACEMENTS: Array<[string, string, boolean]> = [
  ["a status row below the turn", BANNER, true],
  [
    "words split over elements",
    '<div role="status"><span>Connection</span> <b>interrupted.</b> <span>Waiting for the</span> <span>complete answer</span></div>',
    true,
  ],
  [
    "inside the assistant message, outside its Markdown",
    `<div data-message-author-role="assistant"><div class="markdown"><p>${PARTIAL}</p></div><div class="note">${BANNER_TEXT}</div></div>`,
    true,
  ],
  ["only the second sentence", "<div>Waiting for the complete answer</div>", true],
  [
    "quoted in the answer's Markdown",
    `<div data-message-author-role="assistant"><div class="markdown"><p>It said "${BANNER_TEXT}".</p></div></div>`,
    false,
  ],
  [
    "quoted in a user message",
    `<div data-message-author-role="user"><div data-user-message-bubble="true">${BANNER_TEXT}</div></div>`,
    false,
  ],
  ["in a code block", `<pre><code>${BANNER_TEXT}</code></pre>`, false],
  ["in a blockquote", `<blockquote>${BANNER_TEXT}</blockquote>`, false],
  [
    "a screen-reader-only copy",
    `<div style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">${BANNER_TEXT}</div>`,
    false,
  ],
  ["hidden", `<div style="display:none">${BANNER_TEXT}</div>`, false],
  ["invisible", `<div style="visibility:hidden">${BANNER_TEXT}</div>`, false],
  [
    "typed in the composer",
    `<div contenteditable="true" role="textbox">${BANNER_TEXT}</div>`,
    false,
  ],
  [
    "inside a longer paragraph of page text",
    `<p>${"Release notes. ".repeat(30)}${BANNER_TEXT}</p>`,
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

  test("the banner counts only where nobody wrote it and where it is seen", async () => {
    const client = await CDP({ port: chrome!.port });
    try {
      const { Page, Runtime } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await Page.navigate({ url: "about:blank" });
      await Page.loadEventFired();
      for (const [name, markup, detected] of PLACEMENTS) {
        await Runtime.evaluate({
          expression: `document.body.innerHTML = ${JSON.stringify(`<main>${markup}</main>`)}`,
        });
        const { result } = await Runtime.evaluate({
          expression: buildInterruptedBannerExpression(),
          returnByValue: true,
        });
        const value = result.value as { text?: string } | null;
        expect(Boolean(value?.text), name).toBe(detected);
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);

  async function waitOnTurn(waitMs: number) {
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
      // The run's stall time (8 minutes) is not shortened: only the banner may reload here.
      const resync = createTurnResync({
        Runtime,
        Page,
        logger,
        conversationUrl: () => url,
        pollMs: 500,
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
});
