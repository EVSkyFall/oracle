import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import {
  startAppApprovalMonitor,
  type AppApprovalMonitorOptions,
} from "../../src/browser/actions/appApprovals.js";
import { saveAppApprovalDiagnostic } from "../../src/browser/appApprovalDiagnostics.js";
import type { BrowserAppApprovalRecord } from "../../src/browser/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

// Real-Chrome fixture of ChatGPT's 2026-10-26 conversation page: no turn attributes, the thread
// under main > workspace wrappers in its own scroll viewport, the composer (a form) docked over the
// bottom of the thread, and a "scroll to bottom" button above it. Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

const TURNS = Array.from(
  { length: 6 },
  (_, index) => `
  <div class="block-BQZwFn"><div class="group/user-message flex flex-col items-end gap-2"><div class="bg-user-message">
    <div class="MarkdownRoot-rZKhxa rich-text-user-turn"><p>Question ${index} for <span class="Mention-hIgCkC"><span class="Label-arpLwJ">CODEXish</span></span>.</p></div>
  </div></div></div>
  <div class="block-BQZwFn"><div class="MarkdownRoot-rZKhxa"><p>${"Answer text that keeps the thread long. ".repeat(40)}</p></div>
    <div class="flex gap-1"><button type="button" aria-label="Copy">c</button></div></div>`,
).join("");

function todayPage({ thread = "", docked = "", extra = "" } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; font: 14px sans-serif; }
  #root { display: flex; height: 100%; }
  nav { width: 180px; flex: none; }
  main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
  .WorkspaceContent-dnr6uY { position: relative; flex: 1; min-height: 0; display: flex; }
  .MainContentViewport-OinMfT { flex: 1; overflow-y: auto; }
  .MainContentFrame-sss8BP { padding: 0 24px 170px; }
  .block-BQZwFn { margin: 16px 0; }
  .composer { position: absolute; left: 24px; right: 24px; bottom: 12px; background: #fff; border: 1px solid #888; border-radius: 16px; }
  .ProseMirror { min-height: 56px; padding: 8px; }
  [role="alert"] { border: 1px solid #c80; border-radius: 12px; padding: 12px; margin: 12px 0; background: #fff8e8; }
  #scroll-down { position: absolute; left: 50%; bottom: 130px; width: 40px; height: 40px; border-radius: 20px; }
</style></head><body><div id="root">
<nav><button type="button">New chat</button></nav>
<main id="_R_trcuj8aqn75cched5hlb5_" class="outline-none MainContentSurface-EnuIYE MainContentLeftBorder-IFAvO_">
  <div class="WorkspaceContent-dnr6uY relative isolate flex min-h-0 flex-1">
    <div class="MainContentViewport-OinMfT" id="viewport"><div class="MainContentFrame-sss8BP">
      <div class="flex flex-col" id="thread">${TURNS}${thread}</div>
    </div></div>
    <button type="button" id="scroll-down" aria-label="Scroll to bottom">v</button>
    <div class="composer"><form class="relative flex flex-col gap-2"><div class="ComposerModeSurface-lVLm7j">
      ${docked}
      <div class="ComposerLayoutRoot-XCKS7O" role="presentation">
        <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Ask ChatGPT"><p><br class="ProseMirror-trailingBreak"></p></div>
        <button type="button" aria-label="Start voice">v</button>
      </div>
    </div></form></div>
  </div>
</main></div>${extra}
<script>
  window.picks = [];
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('button[data-pick]');
    if (!button) return;
    event.preventDefault();
    window.picks.push(button.dataset.pick + (event.isTrusted ? '' : ' (in-page)'));
    if (button.dataset.stays === undefined) button.closest('[data-card]')?.remove();
  }, true);
  const viewport = document.getElementById('viewport');
  viewport.scrollTop = viewport.scrollHeight;
</script></body></html>`;
}

const pick = (id: string, html: string, attributes = "") =>
  `<button type="button" data-pick="${id}" ${attributes}>${html}</button>`;

const alertCard = (id: string, title: string, detail: string, buttons: string) =>
  `<div role="alert" data-card="${id}"><div class="flex gap-3"><div class="icon"></div><div><p>${title}</p><p>${detail}</p></div></div><div class="flex gap-2">${buttons}</div></div>`;

const KOREAN_CODEXISH = alertCard(
  "codexish",
  "ChatGPT가 CODEXish을(를) 사용하도록 허용할까요?",
  "ChatGPT가 CODEXish의 Host Capabilities 도구를 호출합니다.",
  `${pick("deny", "거부<kbd>Esc</kbd>")}${pick("once", "한 번만 허용")}${pick("always", "항상 허용")}`,
);

describe.runIf(enabled)("app approvals on today's ChatGPT layout (real Chrome)", () => {
  let chrome: chromeLauncher.LaunchedChrome | undefined;
  let userDataDir = "";

  beforeAll(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-approval-today-"));
    chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=1280,900", "--no-first-run"],
      userDataDir,
    });
  }, 60_000);

  afterAll(async () => {
    chrome?.kill();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  /**
   * Loads the page, runs the monitor until `done` holds (or `watchMs` passes when `done` is
   * omitted), and returns what the page saw.
   */
  async function run(
    html: string,
    options: {
      done?: (records: BrowserAppApprovalRecord[]) => boolean;
      watchMs?: number;
      monitor?: Partial<AppApprovalMonitorOptions>;
      /** Expression evaluated before the monitor starts; its value is returned as `setup`. */
      setup?: string;
    } = {},
  ) {
    const client = await CDP({ port: chrome!.port });
    try {
      const { Page, Runtime, Input } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await Page.navigate({ url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
      await Page.loadEventFired();
      const setup = options.setup
        ? (await Runtime.evaluate({ expression: options.setup, returnByValue: true })).result.value
        : undefined;
      const records: BrowserAppApprovalRecord[] = [];
      const logger = Object.assign(vi.fn(), { verbose: false });
      const stop = startAppApprovalMonitor(Runtime, Input, {
        allowApps: ["CODEXish"],
        logger,
        intervalMs: 300,
        onApproval: (record) => {
          records.push(record);
        },
        ...options.monitor,
      });
      try {
        if (options.done) {
          const done = options.done;
          await vi.waitFor(() => expect(done(records)).toBe(true), {
            timeout: 30_000,
            interval: 200,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, options.watchMs ?? 0));
      } finally {
        await stop();
      }
      const { result } = await Runtime.evaluate({
        expression: "window.picks",
        returnByValue: true,
      });
      const lines = logger.mock.calls.map(([line]) => String(line));
      return { picks: result.value as string[], records, lines, setup };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // Whether the centre of the [data-pick="<id>"] button is covered by something else.
  const covered = (id: string) => `(() => {
    const button = document.querySelector('[data-pick="${id}"]');
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit) && hit !== button && !button.contains(hit);
  })()`;

  test("(a) an alert card at the bottom of the thread, under the docked composer, is approved", async () => {
    const { picks, records, setup } = await run(todayPage({ thread: KOREAN_CODEXISH }), {
      // Scrolled up a little, as after the user read back: the card sits under the composer.
      setup: `(() => {
        const viewport = document.getElementById('viewport');
        viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - 150;
        return ${covered("always")};
      })()`,
      done: (list) => list.length === 1,
      watchMs: 1_000,
    });
    expect(setup).toBe(true);
    expect(picks).toEqual(["always"]);
    expect(records[0]).toMatchObject({ app: "CODEXish", button: "항상 허용" });
  }, 60_000);

  test("(b) the same card docked inside the composer form is approved", async () => {
    const { picks, records } = await run(todayPage({ docked: KOREAN_CODEXISH }), {
      done: (list) => list.length === 1,
      watchMs: 1_000,
    });
    expect(picks).toEqual(["always"]);
    expect(records[0]).toMatchObject({ app: "CODEXish", button: "항상 허용" });
  }, 60_000);

  test("(c) labels with a shortcut hint or an icon are approved", async () => {
    const card = alertCard(
      "codexish",
      "Allow CODEXish to use Fs Read?",
      "ChatGPT will call CODEXish's Fs Read tool.",
      [
        pick("deny", "Deny<kbd>Esc</kbd>"),
        pick("once", 'Allow once <span aria-hidden="true">⏎</span>'),
        pick(
          "always",
          '<svg aria-hidden="true" width="12" height="12"><title>check</title><path d="M0 0h12v12H0z"/></svg>Always allow<kbd>⌘⇧⏎</kbd>',
        ),
      ].join(""),
    );
    const { picks, records } = await run(todayPage({ thread: card }), {
      done: (list) => list.length === 1,
      watchMs: 1_000,
    });
    expect(picks).toEqual(["always"]);
    expect(records.map((record) => [record.app, record.button])).toEqual([
      ["CODEXish", "Always allow"],
    ]);
  }, 60_000);

  test("(d) Korean labels are approved with 항상 허용", async () => {
    const { picks, records } = await run(todayPage({ thread: KOREAN_CODEXISH }), {
      done: (list) => list.length === 1,
      watchMs: 1_000,
    });
    expect(picks).toEqual(["always"]);
    expect(records[0]).toMatchObject({ app: "CODEXish", button: "항상 허용" });
  }, 60_000);

  test('(e) an English "Allow for this chat" alone is approved at rank 2', async () => {
    const card = alertCard(
      "codexish",
      "Allow CODEXish to use Host Capabilities?",
      "ChatGPT will call a CODEXish tool.",
      `${pick("deny", "Deny")}${pick("chat", "Allow for this chat")}`,
    );
    const { picks, records } = await run(todayPage({ thread: card }), {
      done: (list) => list.length === 1,
      watchMs: 1_000,
    });
    expect(picks).toEqual(["chat"]);
    expect(records[0]).toMatchObject({ app: "CODEXish", button: "Allow for this chat" });
  }, 60_000);

  test("(f) another app's alert card next to it is left for the user and logged once", async () => {
    const gmail = alertCard(
      "gmail",
      "Allow Gmail to send an email?",
      "to: me@example.com body: CODEXish says hi",
      `${pick("gmail-deny", "Deny", "data-stays")}${pick("gmail-always", "Always allow", "data-stays")}`,
    );
    const { picks, records, lines } = await run(
      todayPage({ thread: `${gmail}${KOREAN_CODEXISH}` }),
      { done: (list) => list.length === 1, watchMs: 2_000 },
    );
    expect(picks).toEqual(["always"]);
    expect(records).toHaveLength(1);
    expect(lines.filter((line) => line.includes("Allow Gmail to send an email?"))).toEqual([
      '[browser] App approval for "Allow Gmail to send an email?" left for the user (its title names no app in --browser-allow-app).',
    ]);
  }, 60_000);

  test('(g) an unknown label such as "Continue" is not clicked, logged once, and diagnosed', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-approval-diag-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const card = alertCard(
        "codexish",
        "Allow CODEXish to use Fs Read?",
        "ChatGPT will call CODEXish's Fs Read tool.",
        `${pick("cancel", "Cancel", "data-stays")}${pick("continue", "Continue", "data-stays")}`,
      );
      const { picks, records, lines } = await run(todayPage({ thread: card }), {
        watchMs: 3_000,
        monitor: {
          saveDiagnostic: (diagnostic) => saveAppApprovalDiagnostic("fixture", diagnostic),
        },
      });
      expect(picks).toEqual([]);
      expect(records).toEqual([]);
      expect(lines.filter((line) => line.includes('"Continue"'))).toEqual([
        '[browser] App approval left for the user: no known allow label among "Cancel", "Continue" in "Allow CODEXish to use Fs Read?".',
      ]);
      const dir = path.join(home, "sessions", "fixture", "artifacts");
      expect(await fs.readdir(dir)).toEqual(["app-approval-diag-1.html"]);
      const html = await fs.readFile(path.join(dir, "app-approval-diag-1.html"), "utf8");
      expect(html).toContain('&lt;div role="alert" data-card="codexish"&gt;');
      expect(html).toContain('"label": "Continue"');
      expect(html).toContain(
        'main#_R_trcuj8aqn75cched5hlb5_ class="outline-none MainContentSurface-EnuIYE',
      );
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  test("(i) deny and don't-allow buttons are never clicked", async () => {
    const denyOnly = alertCard(
      "deny-only",
      "Allow CODEXish to use Fs Write?",
      "ChatGPT will call a CODEXish tool.",
      [
        pick("dont", "Don’t allow", "data-stays"),
        pick("dont-ask", "Allow, don't ask again", "data-stays"),
        pick("ko-dont", "허용 안 함", "data-stays"),
        pick("ko-not", "허용하지 않음", "data-stays"),
        pick("not-now", "Not now", "data-stays"),
        pick("cancel", "Cancel", "data-stays"),
      ].join(""),
    );
    const mixed = alertCard(
      "mixed",
      "Allow CODEXish to use Fs Read?",
      "ChatGPT will call a CODEXish tool.",
      `${pick("dont-2", "Don't allow")}${pick("once", "Allow once")}`,
    );
    const { picks } = await run(todayPage({ thread: `${denyOnly}${mixed}` }), {
      done: (list) => list.length === 1,
      watchMs: 3_000,
    });
    expect(picks).toEqual(["once"]);
  }, 60_000);
});
