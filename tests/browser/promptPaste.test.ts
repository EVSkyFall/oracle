import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import {
  buildMultilinePasteExpression,
  splitPasteChunks,
} from "../../src/browser/actions/promptComposer.js";

// Round-1 item 12, run live on chatgpt.com on 2026-10-25: a multi-line prompt over 4,000
// characters whose 4,000-character chunk boundaries fall inside lines pasted complete, in one
// paragraph. These tests keep that case.
function longMultilinePrompt(): string {
  const lines: string[] = [];
  for (let n = 0; lines.join("\n").length < 9_000; n += 1) {
    lines.push(
      n === 40
        ? ""
        : `line ${String(n).padStart(3, "0")}: the quick brown fox jumps over the lazy dog ${n}`,
    );
  }
  return lines.join("\n");
}

describe("multi-line paste chunks", () => {
  test("chunks of a long multi-line prompt join back to it, with boundaries inside lines", () => {
    const prompt = longMultilinePrompt();
    expect(prompt.length).toBeGreaterThan(8_000);
    // The boundaries the live check used fall in the middle of lines.
    expect(prompt[3_999]).not.toBe("\n");
    expect(prompt[4_000]).not.toBe("\n");
    const chunks = splitPasteChunks(prompt, 4_000);
    expect(chunks.length).toBe(Math.ceil(prompt.length / 4_000));
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks.join("")).toBe(prompt);
    expect(chunks[0]!.endsWith("\n")).toBe(false);
  });

  test("never splits a surrogate pair or a CRLF, and normalises line endings", () => {
    const emoji = `${"a".repeat(3)}😀b`;
    expect(splitPasteChunks(emoji, 4)).toEqual(["aaa", "😀b"]);
    expect(splitPasteChunks("ab\r\ncd", 3)).toEqual(["ab", "\nc", "d"]);
    expect(splitPasteChunks("ab\r\ncd", 3).join("")).toBe("ab\ncd");
    expect(splitPasteChunks("a\rb\r\nc", 100)).toEqual(["a\nb\nc"]);
  });
});

// Real-Chrome fixture of the paste itself. The editor merges a pasted paragraph into the current
// one, as ChatGPT's ProseMirror did live, so chunk boundaries inside lines leave no break.
// Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true" role="textbox"><p><br></p></div></form>
<script>
  const editor = document.getElementById('prompt-textarea');
  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    const template = document.createElement('template');
    template.innerHTML = event.clipboardData.getData('text/html');
    const pasted = template.content.querySelector('p');
    let target = editor.lastElementChild;
    if (window.__pasteMode === 'split' || !target) { target = document.createElement('p'); editor.append(target); }
    if (target.childNodes.length === 1 && target.firstChild.nodeName === 'BR') target.firstChild.remove();
    target.append(...Array.from(pasted.childNodes));
  });
</script></body></html>`;

describe.runIf(enabled)("multi-line paste in real Chrome", () => {
  let chrome: chromeLauncher.LaunchedChrome;
  let client: Awaited<ReturnType<typeof CDP>>;
  let userDataDir: string;

  beforeAll(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-paste-fixture-"));
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
    await fs
      .rm(userDataDir, { recursive: true, force: true, maxRetries: 5 })
      .catch(() => undefined);
  });

  async function paste(mode: string) {
    await client.Page.navigate({
      url: `data:text/html;base64,${Buffer.from(FIXTURE).toString("base64")}`,
    });
    await client.Page.loadEventFired();
    await client.Runtime.evaluate({ expression: `window.__pasteMode = ${JSON.stringify(mode)}` });
    const { result } = await client.Runtime.evaluate({
      expression: buildMultilinePasteExpression(longMultilinePrompt()),
      returnByValue: true,
    });
    return result.value as { used: boolean; complete: boolean; length: number; expected: number };
  }

  test("a long multi-line prompt with chunk boundaries inside lines lands complete", async () => {
    await expect(paste("merge")).resolves.toMatchObject({ used: true, complete: true });
  }, 60_000);

  test("an editor that breaks the line at a chunk boundary is reported incomplete", async () => {
    const result = await paste("split");
    expect(result).toMatchObject({ used: true, complete: false });
  }, 60_000);
});
