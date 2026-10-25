import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { buildDeepResearchFrameStatusExpressionForTest } from "../../src/browser/actions/deepResearch.js";

// The Deep Research frame status on real HTML: what is a finished report and what is still
// progress. The finished shape follows chatgpt.com (2026-10-25): a "root" frame with the banner
// line and the report's paragraphs, no headings or http links. Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

const REPORT = `<p>Node.js 24 "Krypton" is the Active LTS line; its LTS phase began on 2025-10-28.</p>
<p>It moves to maintenance in October 2026 and reaches end-of-life on 2028-04-30.</p>
<p>Node.js 22 stays in maintenance until 2027-04-30, so new projects should start on 24.</p>`;

type FrameStatus = {
  completed: boolean;
  structuralComplete?: boolean;
  progressActive?: boolean;
  text?: string;
  candidateText?: string;
};

describe.runIf(enabled)("Deep Research frame status in real Chrome", () => {
  let chrome: chromeLauncher.LaunchedChrome;
  let client: Awaited<ReturnType<typeof CDP>>;
  let userDataDir: string;

  beforeAll(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-dr-frame-fixture-"));
    chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=900,900", "--no-first-run"],
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

  async function status(body: string): Promise<FrameStatus> {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
    await client.Page.navigate({
      url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
    });
    await client.Page.loadEventFired();
    const { result } = await client.Runtime.evaluate({
      expression: buildDeepResearchFrameStatusExpressionForTest(),
      returnByValue: true,
    });
    return result.value as FrameStatus;
  }

  test("a finished report completes on its banner, or structurally on an unknown one", async () => {
    await expect(status(`<div>리서치 완료 · 2분</div>${REPORT}`)).resolves.toMatchObject({
      completed: true,
      progressActive: false,
    });
    const unknownBanner = await status(`<div>Araştırma 2 dakikada tamamlandı</div>${REPORT}`);
    expect(unknownBanner).toMatchObject({ completed: false, structuralComplete: true });
    expect(unknownBanner.candidateText).toContain("end-of-life on 2028-04-30");
  }, 60_000);

  test("one progress sentence with a heading and a source link is not a report", async () => {
    await expect(
      status(`<h3>Searching the web</h3>
        <p>Looking at the Node.js release schedule and the official changelog pages now.</p>
        <a href="https://nodejs.org/en/about/previous-releases">nodejs.org</a>`),
    ).resolves.toMatchObject({ completed: false, structuralComplete: false });
  }, 60_000);

  test("active progress overrides a completion phrase and report-shaped text", async () => {
    await expect(
      status(`<p class="loading-shimmer">Research completed for 3 of 5 steps</p>${REPORT}`),
    ).resolves.toMatchObject({ completed: false, structuralComplete: false, progressActive: true });
    await expect(
      status(`<button aria-label="Arrêter la recherche">■</button>${REPORT}`),
    ).resolves.toMatchObject({ structuralComplete: false, progressActive: true });
  }, 60_000);

  test("progress and status regions are not part of the report", async () => {
    await expect(
      status(`<div role="status"><p>Reading 12 sources about Node.js releases and support dates.</p>
        <p>Comparing the LTS schedule with the maintenance windows of older lines.</p>
        <p>Checking the end-of-life dates against the official release table.</p></div>`),
    ).resolves.toMatchObject({ structuralComplete: false });
  }, 60_000);
});
