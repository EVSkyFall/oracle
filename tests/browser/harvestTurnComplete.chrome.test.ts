import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { harvestChatGptTab } from "../../src/browser/liveTabs.js";

// Real-Chrome fixture of a harvest reading a follow-up's turn: the earlier turn is complete, and
// this turn shows a preamble without the stop button, a placeholder, nothing yet, or its finished
// answer. Only the normal capture's terminal proof makes a turn finished.
// Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";
const ID = "6add23d8-bbbb-4ccc-8ddd-000000000003";
const PREVIOUS = "Completed handoff. Final commit 9490aaa.";
const PREAMBLE = "Let me look at the fix and its checks first.";
const CURRENT = "W5sub2 fix round 2: the fix and its checks.";

const ACTIONS =
  '<div class="turn-action-controls"><button type="button" data-testid="copy-turn-action-button" aria-label="Copy">c</button></div>';

const TURNS: Record<string, string> = {
  preamble: `<div data-testid="conversation-turn-4"><div data-message-author-role="assistant" data-message-id="m4"><div class="markdown"><p>${PREAMBLE}</p></div></div></div>`,
  placeholder: `<div data-testid="conversation-turn-4"><div data-message-author-role="assistant" data-message-id="m4"><div>Pro thinking</div><button type="button">Answer now</button></div>${ACTIONS}</div>`,
  none: "",
  finished: `<div data-testid="conversation-turn-4"><div data-message-author-role="assistant" data-message-id="m4"><div class="markdown"><p>${CURRENT}</p></div></div>${ACTIONS}</div>`,
};

function conversation(turn: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Follow-up</title></head><body>
<main id="thread">
  <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div>Write the handoff</div></div></div>
  <div data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="m2"><div class="markdown"><p>${PREVIOUS}</p></div></div>${ACTIONS}</div>
  <div data-testid="conversation-turn-3"><div data-message-author-role="user" data-message-id="u3"><div>CODEXish Next round: W5sub2 fix round 2</div></div></div>
  ${turn}
</main>
<form id="composer"><div contenteditable="true" role="textbox" class="ProseMirror"></div></form>
</body></html>`;
}

describe.runIf(enabled)("harvest's finished-turn proof (real Chrome)", () => {
  let chrome: chromeLauncher.LaunchedChrome | undefined;
  let userDataDir = "";
  let server: http.Server | undefined;
  let base = "";

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const match = String(request.url).match(new RegExp(`^/c/${ID}\\?turn=(\\w+)$`));
      const turn = match ? TURNS[match[1]] : undefined;
      if (turn === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(conversation(turn));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-harvest-proof-"));
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

  async function harvest(turn: keyof typeof TURNS, timeoutMs: number) {
    const url = `${base}/c/${ID}?turn=${turn}`;
    const target = await CDP.New({ host: "127.0.0.1", port: chrome!.port, url });
    try {
      const client = await CDP({ host: "127.0.0.1", port: chrome!.port, target: target.id });
      try {
        await client.Runtime.enable();
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const { result } = await client.Runtime.evaluate({
            expression: "document.readyState",
            returnByValue: true,
          });
          if (result.value === "complete") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        await client.close().catch(() => undefined);
      }
      return await harvestChatGptTab({
        host: "127.0.0.1",
        port: chrome!.port,
        target: { targetId: target.id, url, title: "Follow-up", type: "page" },
        confirmTurnComplete: { timeoutMs },
      });
    } finally {
      await CDP.Close({ host: "127.0.0.1", port: chrome!.port, id: target.id }).catch(
        () => undefined,
      );
    }
  }

  test("a preamble without the stop button and without a finished bar is not finished", async () => {
    const harvested = await harvest("preamble", 4_000);
    expect(harvested.stopExists).toBe(false);
    expect(harvested.assistantFollowsLatestUser).toBe(true);
    expect(harvested.lastAssistantFinished).toBe(false);
  }, 60_000);

  test("a placeholder turn is not finished, even with a finished bar, and the previous answer never counts", async () => {
    const harvested = await harvest("placeholder", 4_000);
    expect(harvested.lastAssistantFinished).toBe(false);
    expect(harvested.lastAssistantMarkdown ?? "").not.toContain("Completed handoff");
  }, 60_000);

  test("with nothing after this turn yet, the previous answer is not this turn's finished answer", async () => {
    const harvested = await harvest("none", 4_000);
    expect(harvested.assistantFollowsLatestUser).toBe(false);
    expect(harvested.lastAssistantFinished).toBe(false);
  }, 60_000);

  test("this turn's finished answer is proven and returned", async () => {
    const harvested = await harvest("finished", 15_000);
    expect(harvested.lastAssistantFinished).toBe(true);
    expect(harvested.lastAssistantText).toBe(CURRENT);
    expect((harvested.lastAssistantMarkdown ?? "").trim()).toContain(CURRENT);
  }, 60_000);
});
