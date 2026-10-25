import { describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import {
  buildAppApprovalScanExpression,
  startAppApprovalMonitor,
} from "../../src/browser/actions/appApprovals.js";
import type { BrowserAppApprovalRecord } from "../../src/browser/types.js";

// Real-Chrome fixture: trusted clicks, elementFromPoint and scrolling cannot be faked.
// Run with ORACLE_CHROME_FIXTURES=1 on a machine with Chrome installed.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; margin: 0; }
  .card { border: 1px solid #888; margin: 12px; padding: 8px; }
  #cover { position: fixed; left: 0; right: 0; bottom: 0; height: 140px; background: #eee; }
</style></head><body><main>
  <div data-message-author-role="user"><div class="markdown">Please use CODEXish to run echo.</div></div>
  <article data-turn="assistant">
    <div class="markdown">I will call CODEXish now.</div>
    <div class="card" id="codexish"><p>ChatGPT가 CODEXish을(를) 사용하도록 허용할까요?</p><code>shell: echo hi</code>
      <div><button data-pick="deny">거부</button><button data-pick="once">1회 허용</button><button data-pick="always">항상 허용</button></div></div>
    <div class="card" id="gmail"><p>Allow Gmail to send an email?</p>
      <div><button data-pick="gmail-allow">Allow</button><button data-pick="gmail-deny">Deny</button></div></div>
  </article>
  <div style="height: 2400px"></div>
  <div class="card" id="late" role="dialog"><p>CODEXish wants to read README.md</p>
    <button data-pick="late-once">Allow once</button><button data-pick="late-cancel">Cancel</button></div>
  <div style="height: 200px"></div>
</main><div id="cover">composer</div>
<script>
  window.picks = [];
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-pick]');
    if (!button || !event.isTrusted) return;
    window.picks.push(button.dataset.pick);
    if (!button.dataset.pick.startsWith('gmail')) button.closest('.card').remove();
  });
</script></body></html>`;

describe.runIf(enabled)("app approval monitor in real Chrome", () => {
  test("clicks only allowed cards' strongest allow button, scrolling covered ones into view", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-approval-fixture-"));
    const chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=900,700", "--no-first-run"],
      userDataDir,
    });
    let client: Awaited<ReturnType<typeof CDP>> | undefined;
    try {
      client = await CDP({ port: chrome.port });
      const { Page, Runtime, Input } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await Page.navigate({
        url: `data:text/html;base64,${Buffer.from(FIXTURE).toString("base64")}`,
      });
      await Page.loadEventFired();
      const records: BrowserAppApprovalRecord[] = [];
      const logger = Object.assign(vi.fn(), { verbose: false });
      const stop = startAppApprovalMonitor(Runtime, Input, {
        allowApps: ["CODEXish"],
        logger,
        intervalMs: 300,
        onApproval: (record) => {
          records.push(record);
        },
      });
      try {
        await vi.waitFor(() => expect(records).toHaveLength(2), { timeout: 20_000, interval: 200 });
      } finally {
        await stop();
      }
      const { result } = await Runtime.evaluate({
        expression: "window.picks",
        returnByValue: true,
      });
      expect(result.value).toEqual(["always", "late-once"]);
      expect(records.map((record) => [record.app, record.button])).toEqual([
        ["CODEXish", "항상 허용"],
        ["CODEXish", "Allow once"],
      ]);
      expect(
        logger.mock.calls.some(([line]) => String(line).includes("Allow Gmail to send an email?")),
      ).toBe(true);
    } finally {
      await client?.close().catch(() => undefined);
      chrome.kill();
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  test("a title line ends at <br>, and hidden text is never part of it", async () => {
    const card = (id: string, title: string) =>
      `<div role="dialog" id="${id}"><p>${title}</p><button>Allow</button></div>`;
    const html = `<!doctype html><html><body>
      ${card("br", "Allow Gmail?<br>message: CODEXish")}
      ${card("none", '<span style="display:none">CODEXish </span>Allow Gmail?')}
      ${card("visibility", '<span style="visibility:hidden">CODEXish </span>Allow Gmail?')}
      ${card("aria", '<span aria-hidden="true">CODEXish </span>Allow Gmail?')}
      ${card("zero", '<span style="display:inline-block;width:0;height:0;overflow:hidden">CODEXish </span>Allow Gmail?')}
      ${card("control", "Allow CODEXish?<br>message: run echo")}
    </body></html>`;
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-approval-fixture-"));
    const chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=900,900", "--no-first-run"],
      userDataDir,
    });
    let client: Awaited<ReturnType<typeof CDP>> | undefined;
    try {
      client = await CDP({ port: chrome.port });
      await Promise.all([client.Page.enable(), client.Runtime.enable()]);
      await client.Page.navigate({
        url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
      });
      await client.Page.loadEventFired();
      const { result } = await client.Runtime.evaluate({
        expression: buildAppApprovalScanExpression(["CODEXish"], "fixture"),
        returnByValue: true,
      });
      const cards = result.value as Array<{ app: string | null; title: string }>;
      expect(cards.map((entry) => [entry.title, entry.app])).toEqual([
        ["Allow Gmail?", null],
        ["Allow Gmail?", null],
        ["Allow Gmail?", null],
        ["Allow Gmail?", null],
        ["Allow Gmail?", null],
        ["Allow CODEXish?", "CODEXish"],
      ]);
    } finally {
      await client?.close().catch(() => undefined);
      chrome.kill();
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);
});
