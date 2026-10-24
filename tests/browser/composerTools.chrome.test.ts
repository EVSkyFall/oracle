import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { guardedTrustedClick } from "../../src/browser/actions/composerTools.js";

// Real-Chrome fixture: trusted input, elementFromPoint and capture listeners cannot be faked.
// Run with ORACLE_CHROME_FIXTURES=1 on a machine with Chrome installed.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; margin: 0; }
  button { position: absolute; width: 160px; height: 40px; }
  #under { left: 20px; top: 20px; z-index: 1; } #menuitem { left: 20px; top: 20px; z-index: 2; }
  #plain { left: 20px; top: 120px; } #other { left: 220px; top: 120px; }
</style></head><body>
<button id="under">under</button><button id="menuitem">menu item</button>
<button id="plain">plain</button><button id="other">other</button>
<script>
  window.log = [];
  for (const id of ['under', 'menuitem', 'plain', 'other']) {
    document.getElementById(id).addEventListener('click', (event) => { if (event.isTrusted) window.log.push(id + ':click'); });
  }
  // Like a Radix menu item: acts on pointerdown and closes immediately.
  document.getElementById('menuitem').addEventListener('pointerdown', (event) => {
    if (!event.isTrusted) return;
    window.log.push('menuitem:act');
    event.currentTarget.remove();
  });
</script></body></html>`;

describe.runIf(enabled)("guarded trusted click in real Chrome", () => {
  let chrome: chromeLauncher.LaunchedChrome;
  let client: Awaited<ReturnType<typeof CDP>>;
  let userDataDir: string;

  beforeAll(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-click-fixture-"));
    chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=600,400", "--no-first-run"],
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

  async function load() {
    await client.Page.navigate({
      url: `data:text/html;base64,${Buffer.from(FIXTURE).toString("base64")}`,
    });
    await client.Page.loadEventFired();
  }
  const log = async () =>
    (await client.Runtime.evaluate({ expression: "window.log", returnByValue: true })).result
      .value as string[];
  const byId = (id: string) => `() => document.getElementById(${JSON.stringify(id)})`;

  test("a target that acts on press and closes counts as clicked, and the release cannot hit what is underneath", async () => {
    await load();
    const result = await guardedTrustedClick(client.Runtime, client.Input, {
      locate: byId("menuitem"),
      stage: "fixture",
      target: "menu item",
    });
    expect(result).toMatchObject({ status: "clicked" });
    expect(await log()).toEqual(["menuitem:act"]);
  }, 30_000);

  test("a dispatched click that never reached the target is not reported as clicked", async () => {
    await load();
    const silentInput = { dispatchMouseEvent: async () => ({}) } as unknown as typeof client.Input;
    const result = await guardedTrustedClick(client.Runtime, silentInput, {
      locate: byId("plain"),
      stage: "fixture",
      target: "plain button",
    });
    expect(result.status).toBe("unreached");
  }, 30_000);

  test("the guard removes itself page-side when Oracle's cleanup call fails", async () => {
    await load();
    const runtime = new Proxy(client.Runtime, {
      get(target, key, receiver) {
        if (key !== "evaluate") return Reflect.get(target, key, receiver);
        return (params: { expression: string }) =>
          params.expression.includes("guard.cleanup(); delete guards")
            ? Promise.reject(new Error("transport hiccup"))
            : target.evaluate(params);
      },
    });
    await guardedTrustedClick(runtime, client.Input, {
      locate: byId("plain"),
      stage: "fixture",
      target: "plain button",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A later click elsewhere in the tab must still work.
    const point = (
      await client.Runtime.evaluate({
        expression: `(() => { const r = document.getElementById('other').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
        returnByValue: true,
      })
    ).result.value as { x: number; y: number };
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await client.Input.dispatchMouseEvent({ type, ...point, button: "left", clickCount: 1 });
    }
    expect(await log()).toEqual(["plain:click", "other:click"]);
  }, 30_000);
});
