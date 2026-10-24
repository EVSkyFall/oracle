import { describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/browser/utils.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  delay: vi.fn(() => Promise.resolve()),
}));

import {
  assertAppMentionsPresent,
  buildEditorMentionNamesExpression,
  insertAppMentions,
  mentionNamesInclude,
  parseAppMentionChipName,
} from "../../src/browser/actions/appMentions.js";
import { normalizeBrowserApps, resolveBrowserConfig } from "../../src/browser/config.js";
import { resolveBrowserAppMentions } from "../../src/cli/browserApps.js";
import { buildBrowserConfig } from "../../src/cli/browserConfig.js";
import { applyBrowserDefaultsFromConfig } from "../../src/cli/browserDefaults.js";
import { buildConsultBrowserConfig } from "../../src/mcp/tools/consult.js";
import { FakeDocument, FakeElement } from "./domFixture.js";

// Shape of a chip copied from the ChatGPT composer (plugin mention).
const PLUGIN_CHIP =
  '<p data-pm-slice="1 1 []"><span plugin-mention-name="dev-6ada617225f88191866ad63b2ca09a63" plugin-mention-display-name="CODEXish" plugin-mention-path="plugin://dev-6ada617225f88191866ad63b2ca09a63@openai-curated-remote" data-prompt-link-href="plugin://dev-6ada617225f88191866ad63b2ca09a63@openai-curated-remote" data-prompt-link-label="@dev-6ada617225f88191866ad63b2ca09a63" class="Mention-hIgCkC"><span class="Label-arpLwJ">CODEXish</span></span> </p>';

describe("app mention configuration", () => {
  test("reads the app name from copied chip HTML", () => {
    expect(parseAppMentionChipName(PLUGIN_CHIP)).toBe("CODEXish");
    expect(
      parseAppMentionChipName("<span app-mention-display-name='Tom &amp; Jerry'>x</span>"),
    ).toBe("Tom & Jerry");
    expect(parseAppMentionChipName("<p>no mention here</p>")).toBeNull();
  });

  test("normalizes names and records, merging duplicates case-insensitively", () => {
    expect(
      normalizeBrowserApps([
        " CODEXish ",
        { name: "codexish", chipHtml: PLUGIN_CHIP },
        "",
        { name: 42 },
        { name: "Slack", extra: true },
      ]),
    ).toEqual([{ name: "CODEXish", chipHtml: PLUGIN_CHIP }, { name: "Slack" }]);
    expect(normalizeBrowserApps(undefined)).toEqual([]);
    expect(resolveBrowserConfig({}).apps).toEqual([]);
  });

  test("resolves --browser-app names and --browser-app-chip files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-app-chip-"));
    try {
      const chip = path.join(dir, "codexish.html");
      await fs.writeFile(chip, PLUGIN_CHIP, "utf8");
      await expect(resolveBrowserAppMentions(["codexish"], [chip], dir)).resolves.toEqual([
        { name: "codexish", chipHtml: PLUGIN_CHIP },
      ]);
      const bad = path.join(dir, "bad.html");
      await fs.writeFile(bad, "<p>plain text</p>", "utf8");
      await expect(resolveBrowserAppMentions([], [bad], dir)).rejects.toThrow(
        /no app-mention-display-name/,
      );
      await expect(resolveBrowserAppMentions([], [], dir)).resolves.toBeUndefined();
      const config = await buildBrowserConfig({
        model: "gpt-6-astra",
        browserApp: ["CODEXish"],
      } as never);
      expect(config.apps).toEqual([{ name: "CODEXish" }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("applies configured apps only when the CLI did not set them", () => {
    const options: { browserApp?: string[]; browserAppChip?: string[] } = { browserApp: [] };
    applyBrowserDefaultsFromConfig(
      options,
      { browser: { apps: ["CODEXish"], appChipFiles: ["C:/chips/codexish.html"] } },
      () => "default",
    );
    expect(options).toEqual({
      browserApp: ["CODEXish"],
      browserAppChip: ["C:/chips/codexish.html"],
    });
    const cli = { browserApp: ["Slack"] };
    applyBrowserDefaultsFromConfig(cli, { browser: { apps: ["CODEXish"] } }, (key) =>
      key === "browserApp" ? "cli" : "default",
    );
    expect(cli.browserApp).toEqual(["Slack"]);
  });

  test("MCP consult keeps chip file paths out of the session config", () => {
    const config = buildConsultBrowserConfig({
      userConfig: { browser: { apps: ["CODEXish"], appChipFiles: ["C:/chips/codexish.html"] } },
      env: {},
      runModel: "gpt-6-astra",
    });
    expect(config.apps).toEqual([{ name: "CODEXish" }]);
    expect(config).not.toHaveProperty("appChipFiles");
  });
});

describe("editor mention detection", () => {
  test("lists app and plugin mention display names in the editor", () => {
    const editor = new FakeElement("div", { contenteditable: "true", role: "textbox" }, [
      new FakeElement("p", {}, [
        new FakeElement("span", { "plugin-mention-display-name": "CODEXish" }, [], "CODEXish"),
        new FakeElement("span", { "app-mention-display-name": "Deep research" }, [], "x"),
      ]),
    ]);
    const names = new Function("document", `return ${buildEditorMentionNamesExpression()}`)(
      new FakeDocument([editor]),
    ) as string[];
    expect(names).toEqual(expect.arrayContaining(["CODEXish", "Deep research"]));
    expect(mentionNamesInclude(names, "codexish")).toBe(true);
    expect(mentionNamesInclude(names, "Code")).toBe(false);
  });

  test("finds a mention that has only a name attribute or only its label", () => {
    const editor = new FakeElement("div", { contenteditable: "true", role: "textbox" }, [
      new FakeElement("p", {}, [
        new FakeElement("span", { "app-mention-name": "codexish" }, [], "CODEXish"),
        new FakeElement("span", { "plugin-mention-path": "plugin://dev-1@curated" }, [
          new FakeElement("span", { class: "Label" }, [], "Slack"),
        ]),
      ]),
    ]);
    const names = new Function("document", `return ${buildEditorMentionNamesExpression()}`)(
      new FakeDocument([editor]),
    ) as string[];
    expect(mentionNamesInclude(names, "CODEXish")).toBe(true);
    expect(mentionNamesInclude(names, "Slack")).toBe(true);
  });
});

describe("inserting app mentions", () => {
  const logger = Object.assign(vi.fn(), { verbose: false });

  test("tries the @ picker first and pastes a supplied chip only after it failed", async () => {
    const events: string[] = [];
    let editorText = "";
    let pasted = false;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") return { result: { value: "https://chatgpt.com/" } };
        if (expression.includes("new ClipboardEvent('paste'")) {
          events.push("paste");
          pasted = true;
          return { result: { value: true } };
        }
        if (expression.includes("const mentions = Array.from(editor.querySelectorAll(")) {
          return { result: { value: pasted ? ["CODEXish"] : [] } };
        }
        if (expression.includes("window.__oracleComposerRows = {"))
          return { result: { value: [] } };
        if (expression.includes("return { plus: Boolean(plus), expanded")) {
          return { result: { value: { plus: true, expanded: false, rows: 0 } } };
        }
        return { result: { value: { focused: true, text: editorText } } };
      }),
    };
    const input = {
      insertText: vi.fn(),
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(async (event: { type: string; text?: string; key: string }) => {
        if (event.type !== "keyDown") return;
        events.push(`key:${event.key}`);
        if (event.key === "Backspace") editorText = editorText.slice(0, -1);
        else if (event.text) editorText += event.text;
      }),
    };
    await insertAppMentions(
      runtime as never,
      input as never,
      [{ name: "CODEXish", chipHtml: PLUGIN_CHIP }],
      logger,
    );
    expect(events[0]).toBe("key:@");
    expect(events.at(-1)).toBe("paste");
    expect(events).not.toContain("key:Enter");
    expect(editorText).toBe("");
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("[browser] App mention CODEXish: attached (pasted chip;"),
    );
  }, 20_000);

  test("stops before submit and removes the typed query when the picker has no such app", async () => {
    let editorText = "";
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") return { result: { value: "https://chatgpt.com/" } };
        if (
          expression.includes("plugin-mention-display-name") &&
          expression.includes(".map(node")
        ) {
          return { result: { value: [] } };
        }
        if (expression.includes("window.__oracleComposerRows = {")) {
          return {
            result: {
              value: [
                {
                  index: 0,
                  title: "OpenAI Platform",
                  leaf: "OpenAI Platform",
                  aria: "",
                  text: "OpenAI Platform",
                  impression: null,
                  current: true,
                },
              ],
            },
          };
        }
        if (expression.includes("return { plus: Boolean(plus), expanded")) {
          return { result: { value: { plus: true, expanded: false, rows: 0 } } };
        }
        return { result: { value: { focused: true, text: editorText } } };
      }),
    };
    const input = {
      insertText: vi.fn(),
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(async (event: { type: string; text?: string; key: string }) => {
        if (event.type !== "keyDown") return;
        if (event.key === "Backspace") editorText = editorText.slice(0, -1);
        else if (event.text) editorText += event.text;
      }),
    };
    await expect(
      insertAppMentions(runtime as never, input as never, [{ name: "CODEXish" }], logger),
    ).rejects.toMatchObject({
      details: { code: "app-mention-unverified", app: "CODEXish", available: ["OpenAI Platform"] },
    });
    expect(editorText).toBe("");
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter" }),
    );
  }, 20_000);

  test("fails before submit when staging dropped a mention", async () => {
    const runtime = { evaluate: vi.fn(async () => ({ result: { value: ["Slack"] } })) };
    await expect(
      assertAppMentionsPresent(runtime as never, [{ name: "CODEXish" }]),
    ).rejects.toMatchObject({ details: { code: "app-mention-lost", missing: ["CODEXish"] } });
    await expect(assertAppMentionsPresent(runtime as never, [{ name: "slack" }])).resolves.toBe(
      undefined,
    );
  });
});
