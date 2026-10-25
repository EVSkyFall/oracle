import { describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import {
  readModelPickerState,
  restoreModelPickerState,
} from "../../src/browser/actions/modelPickerState.js";

// Real-Chrome fixture: the picker reacts only to trusted pointer and key events, like ChatGPT's.
// Run with ORACLE_CHROME_FIXTURES=1 on a machine with Chrome installed.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

function fixture(
  keys: "horizontal" | "vertical",
  rtl: boolean,
  layered: boolean,
  sliderDelayMs = 0,
  variant: "default" | "localized-header" | "no-effort" = "default",
): string {
  // Layered mirrors chatgpt.com (2026-10-25): the model radios sit under the effort panel and
  // its "Select model" header brings them to the front.
  const layer = layered ? "position: absolute; inset: 0; background: #fff;" : "";
  return `<!doctype html><html dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; margin: 0; } #menu { position: absolute; top: 60px; left: 20px; border: 1px solid #888; width: 260px; height: ${layered ? "90px" : "auto"}; }
  #menu [role] { display: block; padding: 4px; } #slider { width: 200px; height: 12px; background: #ccc; }
  #models { ${layer} z-index: 1; } #effort { ${layer} z-index: 2; }
</style></head><body>
<form><div contenteditable="true" role="textbox">composer</div>
  <button type="button" id="picker" aria-label="Select ChatGPT model" aria-haspopup="menu" aria-controls="menu">Thinking effort Medium</button></form>
<div id="menu" role="menu" style="display:none">
  <div id="models">
    <div role="menuitemradio" data-model="GPT-6" aria-checked="true">GPT-6</div>
    <div role="menuitemradio" data-model="GPT-5.6 Sol" aria-checked="false">GPT-5.6 Sol</div>
  </div>
  <div id="effort">${
    variant === "no-effort"
      ? ""
      : variant === "localized-header"
        ? `<div role="menuitem" id="temp">임시 채팅</div>
    <div role="menuitem" id="tier" aria-label="모델 선택" aria-haspopup="menu">Medium</div>`
        : `<div role="menuitem" id="tier" aria-label="Select model">Medium</div>`
  }${
    variant === "no-effort"
      ? ""
      : `<div role="menuitem" aria-label="Power"><span id="slider" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1"></span></div>`
  }
  </div>
</div>
<div aria-live="polite" id="live"></div>
<script>
  const tiers = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
  const state = { open: false, model: 'GPT-6', value: 1, view: 'effort' };
  window.untrusted = 0;
  const $ = (id) => document.getElementById(id);
  const render = () => {
    $('picker').textContent = 'Thinking effort ' + tiers[state.value];
    $('picker').setAttribute('aria-expanded', String(state.open));
    $('menu').style.display = state.open ? 'block' : 'none';
    $('models').style.zIndex = state.view === 'models' ? '3' : '1';
    if ($('tier')) $('tier').textContent = tiers[state.value];
    $('slider')?.setAttribute('aria-valuenow', String(state.value));
    for (const radio of document.querySelectorAll('[role="menuitemradio"]')) radio.setAttribute('aria-checked', String(radio.dataset.model === state.model));
    // no-effort: the live region keeps an old announcement.
    if (${variant === "no-effort"} && $('live').textContent) return;
    $('live').textContent = tiers[state.value] + ', ' + (state.value + 1) + ' of 5.';
  };
  window.setPicker = (model, value) => { state.model = model; state.value = value; render(); };
  window.pickerState = () => ({ open: state.open, model: state.model, value: state.value });
  // The slider mounts a beat after the menu opens, as on chatgpt.com.
  const mountSlider = () => { if (!$('slider')) return; $('slider').style.display = 'none'; setTimeout(() => { $('slider').style.display = ''; }, ${sliderDelayMs}); };
  $('picker').addEventListener('pointerdown', (event) => { if (!event.isTrusted) { window.untrusted++; return; } state.open = !state.open; state.view = 'effort'; render(); if (state.open) mountSlider(); });
  $('tier')?.addEventListener('click', (event) => { if (!event.isTrusted) { window.untrusted++; return; } state.view = 'models'; render(); });
  for (const radio of document.querySelectorAll('[role="menuitemradio"]')) radio.addEventListener('click', (event) => {
    if (!event.isTrusted) { window.untrusted++; return; }
    state.model = radio.dataset.model; state.open = false; state.view = 'effort'; render();
  });
  const KEYS = ${JSON.stringify(keys)} === 'horizontal'
    ? { ArrowRight: ${rtl ? -1 : 1}, ArrowLeft: ${rtl ? 1 : -1} }
    : { ArrowUp: 1, ArrowDown: -1 };
  $('slider')?.addEventListener('keydown', (event) => {
    if (!event.isTrusted) { window.untrusted++; return; }
    if (state.view !== 'effort') return;
    const delta = KEYS[event.key];
    if (!delta) return;
    event.preventDefault();
    state.value = Math.max(0, Math.min(4, state.value + delta)); render();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && event.isTrusted) { state.open = false; state.view = 'effort'; render(); } });
  render();
</script></body></html>`;
}

describe.runIf(enabled)("model picker snapshot and restore in real Chrome", () => {
  test.each([
    ["horizontal", false, true, 0],
    ["horizontal", true, true, 0],
    ["vertical", false, false, 0],
    ["horizontal", false, true, 800],
  ] as const)(
    "reads the picker and restores model and effort (%s keys, rtl=%s, layered=%s, slider mounts after %s ms)",
    async (keys, rtl, layered, sliderDelayMs) => {
      const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-picker-fixture-"));
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
          url: `data:text/html;base64,${Buffer.from(fixture(keys, rtl, layered, sliderDelayMs)).toString("base64")}`,
        });
        await Page.loadEventFired();
        const logger = Object.assign(vi.fn(), { verbose: false });

        const before = await readModelPickerState(Runtime, Input);
        expect(before).toMatchObject({
          modelLabel: "GPT-6",
          tierLabel: "Medium",
          sliderValue: 1,
          sliderMin: 0,
          sliderMax: 4,
          announcement: "Medium, 2 of 5.",
        });
        // A check selected GPT-5.6 Sol at Pro.
        await Runtime.evaluate({ expression: "window.setPicker('GPT-5.6 Sol', 4)" });

        const restore = await restoreModelPickerState(Runtime, Input, before!, logger);
        expect(restore).toMatchObject({
          restored: true,
          state: { modelLabel: "GPT-6", tierLabel: "Medium", sliderValue: 1 },
        });
        const { result } = await Runtime.evaluate({
          expression: "({ ...window.pickerState(), untrusted: window.untrusted })",
          returnByValue: true,
        });
        expect(result.value).toEqual({ open: false, model: "GPT-6", value: 1, untrusted: 0 });
      } finally {
        await client?.close().catch(() => undefined);
        chrome.kill();
        await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    60_000,
  );

  async function withPicker(
    html: string,
    run: (client: Awaited<ReturnType<typeof CDP>>) => Promise<void>,
  ): Promise<void> {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-picker-fixture-"));
    const chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=900,700", "--no-first-run"],
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
      await run(client);
    } finally {
      await client?.close().catch(() => undefined);
      chrome.kill();
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const pickerState = async (client: Awaited<ReturnType<typeof CDP>>) =>
    (
      await client.Runtime.evaluate({
        expression: "({ ...window.pickerState(), untrusted: window.untrusted })",
        returnByValue: true,
      })
    ).result.value as { open: boolean; model: string; value: number; untrusted: number };
  const labelOnly = (tierLabel: string) => ({
    pickerLabel: null,
    modelLabel: "GPT-6",
    modelOptions: [],
    tierLabel,
    sliderValue: null,
    sliderMin: null,
    sliderMax: null,
    announcement: null,
    tierSource: "header" as const,
  });

  test("a snapshot known only by its tier label is restored to that tier (from Pro)", async () => {
    await withPicker(fixture("horizontal", false, true), async (client) => {
      await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 4)" });
      const restore = await restoreModelPickerState(
        client.Runtime,
        client.Input,
        labelOnly("Medium"),
        Object.assign(vi.fn(), { verbose: false }),
      );
      expect(restore).toMatchObject({
        restored: true,
        state: { tierLabel: "Medium", sliderValue: 1 },
      });
      expect(await pickerState(client)).toEqual({
        open: false,
        model: "GPT-6",
        value: 1,
        untrusted: 0,
      });
    });
  }, 60_000);

  test("a stale announcement never counts as the restored tier", async () => {
    await withPicker(fixture("horizontal", false, false, 0, "no-effort"), async (client) => {
      // The live region still says "Medium, 2 of 5." while the account is on Pro.
      await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 4)" });
      const restore = await restoreModelPickerState(
        client.Runtime,
        client.Input,
        labelOnly("Medium"),
        Object.assign(vi.fn(), { verbose: false }),
      );
      expect(restore.restored).toBe(false);
      expect((await pickerState(client)).value).toBe(4);
    });
  }, 60_000);

  test("a localized model-list header is found by structure", async () => {
    await withPicker(fixture("horizontal", false, true, 0, "localized-header"), async (client) => {
      const before = await readModelPickerState(client.Runtime, client.Input);
      await client.Runtime.evaluate({ expression: "window.setPicker('GPT-5.6 Sol', 4)" });
      const restore = await restoreModelPickerState(
        client.Runtime,
        client.Input,
        before!,
        Object.assign(vi.fn(), { verbose: false }),
      );
      expect(restore.restored).toBe(true);
      expect(await pickerState(client)).toEqual({
        open: false,
        model: "GPT-6",
        value: 1,
        untrusted: 0,
      });
    });
  }, 60_000);

  test("a restore target without its effort is never reported as restored", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-picker-fixture-"));
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
        url: `data:text/html;base64,${Buffer.from(fixture("horizontal", false, true)).toString("base64")}`,
      });
      await Page.loadEventFired();
      await Runtime.evaluate({ expression: "window.setPicker('GPT-6', 4)" });
      const restore = await restoreModelPickerState(
        Runtime,
        Input,
        {
          pickerLabel: null,
          modelLabel: "GPT-6",
          modelOptions: [],
          tierLabel: null,
          sliderValue: null,
          sliderMin: null,
          sliderMax: null,
          announcement: null,
        },
        Object.assign(vi.fn(), { verbose: false }),
      );
      expect(restore.restored).toBe(false);
    } finally {
      await client?.close().catch(() => undefined);
      chrome.kill();
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);
});
