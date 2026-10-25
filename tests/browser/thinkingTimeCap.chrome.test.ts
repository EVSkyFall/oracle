import { describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import {
  browserThinkingCapSteps,
  enforceThinkingTimeCap,
} from "../../src/browser/actions/thinkingTimeCap.js";
import {
  lowerModelPickerTier,
  readModelPickerEvidence,
} from "../../src/browser/actions/modelPickerState.js";
import { pickerFixture } from "./pickerFixture.js";

// Real-Chrome fixture (pickerFixture.ts): the cap runs its real steps, the regular thinking-time
// selection and then trusted slider keys. Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

type Client = Awaited<ReturnType<typeof CDP>>;

async function withPage(html: string, run: (client: Client) => Promise<void>): Promise<void> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-cap-fixture-"));
  const chrome = await chromeLauncher.launch({
    chromeFlags: ["--headless=new", "--window-size=900,700", "--no-first-run"],
    userDataDir,
  });
  let client: Client | undefined;
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

const pickerState = async (client: Client) =>
  (await client.Runtime.evaluate({ expression: "window.pickerState()", returnByValue: true }))
    .result.value as { open: boolean; model: string; value: number };

const quietLogger = () => Object.assign(vi.fn(), { verbose: false });

describe.runIf(enabled)("thinking-time cap in real Chrome", () => {
  test.each([
    ["left-to-right", false],
    ["right-to-left", true],
  ] as const)(
    "Pro is lowered to Extra High and read back (%s)",
    async (_layout, rtl) => {
      await withPage(pickerFixture("horizontal", rtl, true), async (client) => {
        await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 4)" });
        const logger = quietLogger();
        const check = await enforceThinkingTimeCap(
          "extra-high",
          browserThinkingCapSteps(client.Runtime, client.Input, logger),
          logger,
        );
        expect(check).toMatchObject({
          status: "lowered",
          before: { modelLabel: "GPT-6", tierLabel: "Pro", sliderValue: 4 },
          after: { modelLabel: "GPT-6", tierLabel: "Extra High", sliderValue: 3 },
        });
        expect(await pickerState(client)).toEqual({ open: false, model: "GPT-6", value: 3 });
      });
    },
    90_000,
  );

  test("a cap with no exact step lands on the highest tier below it", async () => {
    await withPage(pickerFixture("horizontal", false, true), async (client) => {
      await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 4)" });
      const logger = quietLogger();
      await expect(
        enforceThinkingTimeCap(
          "heavy",
          browserThinkingCapSteps(client.Runtime, client.Input, logger),
          logger,
        ),
      ).resolves.toMatchObject({ status: "lowered", after: { tierLabel: "Extra High" } });
      expect((await pickerState(client)).value).toBe(3);
    });
  }, 90_000);

  test("a tier within the cap is read and left as it is", async () => {
    await withPage(pickerFixture("horizontal", false, true), async (client) => {
      await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 3)" });
      const logger = quietLogger();
      await expect(
        enforceThinkingTimeCap(
          "extra-high",
          browserThinkingCapSteps(client.Runtime, client.Input, logger),
          logger,
        ),
      ).resolves.toMatchObject({ status: "within", before: { sliderValue: 3 } });
      expect(await pickerState(client)).toEqual({ open: false, model: "GPT-6", value: 3 });
    });
  }, 60_000);

  test("a picker that cannot be lowered stops the submission", async () => {
    await withPage(pickerFixture("horizontal", false, true, 0, "stuck-slider"), async (client) => {
      await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 4)" });
      const logger = quietLogger();
      await expect(
        enforceThinkingTimeCap(
          "extra-high",
          browserThinkingCapSteps(client.Runtime, client.Input, logger),
          logger,
        ),
      ).rejects.toMatchObject({
        details: { code: "thinking-time-above-max", after: { tierLabel: "Pro" } },
      });
      expect((await pickerState(client)).value).toBe(4);
    });
  }, 90_000);

  test("a header that trails the slider never hides Pro: the slider text wins and is lowered", async () => {
    await withPage(
      pickerFixture("horizontal", false, true, 0, "default", { valueText: true }),
      async (client) => {
        await client.Runtime.evaluate({
          expression:
            "window.setPicker('GPT-6', 3); window.freezeHeader = true; window.setPicker('GPT-6', 4)",
        });
        const logger = quietLogger();
        const check = await enforceThinkingTimeCap(
          "extra-high",
          browserThinkingCapSteps(client.Runtime, client.Input, logger),
          logger,
        );
        expect(check).toMatchObject({
          status: "lowered",
          before: {
            tierLabel: "Extra High",
            sliderValue: 4,
            tierReadings: [
              { label: "Extra High", source: "header" },
              { label: "Pro", source: "valuetext" },
            ],
          },
          after: { sliderValue: 3 },
        });
        expect((await pickerState(client)).value).toBe(3);
      },
    );
  }, 90_000);

  test("a header that keeps naming Pro for 3 s while the slider text follows the steps ends on Extra High", async () => {
    const html = pickerFixture("horizontal", false, true, 0, "default", { valueText: true });
    const lagging = "window.setPicker('GPT-6', 4); window.headerLagMs = 3000";
    await withPage(html, async (client) => {
      await client.Runtime.evaluate({ expression: lagging });
      await expect(
        lowerModelPickerTier(client.Runtime, client.Input, "extra-high", quietLogger()),
      ).resolves.toEqual({ lowered: true });
      expect((await pickerState(client)).value).toBe(3);
    });
    // The whole cap: lowered by slider steps, then the verdict once the sources agree.
    await withPage(html, async (client) => {
      await client.Runtime.evaluate({ expression: lagging });
      const logger = quietLogger();
      await expect(
        enforceThinkingTimeCap(
          "extra-high",
          browserThinkingCapSteps(client.Runtime, client.Input, logger),
          logger,
        ),
      ).resolves.toMatchObject({
        status: "lowered",
        after: { tierLabel: "Extra High", sliderValue: 3 },
      });
      expect((await pickerState(client)).value).toBe(3);
    });
  }, 120_000);

  test("a localized tier header on Pro is found by structure and lowered, not read as unreadable", async () => {
    await withPage(
      pickerFixture("horizontal", false, true, 0, "localized-header"),
      async (client) => {
        await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 4)" });
        const logger = quietLogger();
        await expect(
          enforceThinkingTimeCap(
            "extra-high",
            browserThinkingCapSteps(client.Runtime, client.Input, logger),
            logger,
          ),
        ).resolves.toMatchObject({
          status: "lowered",
          before: { tierLabel: "Pro" },
          after: { tierLabel: "Extra High", sliderValue: 3 },
        });
        expect((await pickerState(client)).value).toBe(3);
      },
    );
  }, 90_000);

  test("a localized header that names no tier leaves the tier to the slider text", async () => {
    await withPage(
      pickerFixture("horizontal", false, true, 0, "localized-header", {
        valueText: true,
        headerLabel: "모델",
      }),
      async (client) => {
        await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 2)" });
        const logger = quietLogger();
        await expect(
          readModelPickerEvidence(client.Runtime, client.Input, logger),
        ).resolves.toMatchObject({
          tierReadings: [{ label: "High", source: "valuetext" }],
          sliderValue: 2,
        });
      },
    );
  }, 60_000);

  test("a page without a readable picker is sent with a warning", async () => {
    await withPage(
      `<!doctype html><html><body><form><div contenteditable="true" role="textbox"></div></form></body></html>`,
      async (client) => {
        const logger = quietLogger();
        await expect(
          enforceThinkingTimeCap(
            "extra-high",
            browserThinkingCapSteps(client.Runtime, client.Input, logger),
            logger,
          ),
        ).resolves.toMatchObject({ status: "unreadable", before: { readable: false } });
        expect(logger.mock.calls.map((call) => call[0]).join("\n")).toMatch(
          /warning: the picker tier could not be read/,
        );
      },
    );
  }, 60_000);

  test("picker evidence records the model, tier and slider the picker shows, in one line", async () => {
    await withPage(pickerFixture("horizontal", false, true), async (client) => {
      await client.Runtime.evaluate({ expression: "window.setPicker('GPT-6', 3)" });
      const logger = quietLogger();
      await expect(
        readModelPickerEvidence(client.Runtime, client.Input, logger),
      ).resolves.toMatchObject({
        modelLabel: "GPT-6",
        tierLabel: "Extra High",
        sliderValue: 3,
        sliderMin: 0,
        sliderMax: 4,
        readable: true,
        source: "chatgpt-model-picker",
      });
      expect(logger.mock.calls.map((call) => call[0])).toEqual([
        '[browser] Model picker evidence: model "GPT-6", tier "Extra High", slider 3 (0-4).',
      ]);
      expect((await pickerState(client)).open).toBe(false);
    });
  }, 60_000);
});
