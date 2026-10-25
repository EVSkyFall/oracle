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
import { pickerFixture as fixture } from "./pickerFixture.js";

// Real-Chrome fixture (pickerFixture.ts): the picker reacts only to trusted input, like ChatGPT's.
// Run with ORACLE_CHROME_FIXTURES=1 on a machine with Chrome installed.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

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
