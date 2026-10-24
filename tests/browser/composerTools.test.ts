import { describe, expect, test, vi } from "vitest";
import {
  COMPOSER_PLUS_SELECTORS,
  COMPOSER_TOKEN_SELECTOR,
  buildComposerPanelStateExpression,
  readComposerPromptText,
  composerRowTitleEquals,
  findComposerPlusButton,
  guardedTrustedClick,
  isDeepResearchMention,
  isWebSearchPill,
  readComposerRowLabels,
  readMentionNames,
} from "../../src/browser/actions/composerTools.js";
import { INPUT_SELECTORS } from "../../src/browser/constants.js";
import { FakeDocument, FakeElement } from "./domFixture.js";

const editor = () =>
  new FakeElement("div", { contenteditable: "true", role: "textbox", class: "ProseMirror" });

describe("composer + control lookup", () => {
  test("picks the plus that shares the editor's composer and ignores sidebar controls", () => {
    const sidebarPlus = new FakeElement("button", { "aria-label": "Add files to project" });
    const composerPlus = new FakeElement("button", {
      "aria-label": "Add files and more",
      "data-composer-navigation-target": "add-context",
    });
    const document = new FakeDocument([
      new FakeElement("nav", {}, [sidebarPlus]),
      new FakeElement("form", { "data-chatgpt-composer": "" }, [
        new FakeElement("div", {}, [editor()]),
        new FakeElement("div", {}, [composerPlus]),
      ]),
    ]);
    expect(
      findComposerPlusButton(
        document as unknown as Document,
        INPUT_SELECTORS,
        COMPOSER_PLUS_SELECTORS,
      ),
    ).toBe(composerPlus);
  });

  test("keeps the legacy id as a fallback and finds nothing without an editor", () => {
    const legacyPlus = new FakeElement("button", { id: "composer-plus-btn" });
    const withEditor = new FakeDocument([new FakeElement("div", {}, [editor(), legacyPlus])]);
    expect(
      findComposerPlusButton(
        withEditor as unknown as Document,
        INPUT_SELECTORS,
        COMPOSER_PLUS_SELECTORS,
      ),
    ).toBe(legacyPlus);
    const noEditor = new FakeDocument([
      new FakeElement("div", {}, [new FakeElement("button", { id: "composer-plus-btn" })]),
    ]);
    expect(
      findComposerPlusButton(
        noEditor as unknown as Document,
        INPUT_SELECTORS,
        COMPOSER_PLUS_SELECTORS,
      ),
    ).toBeNull();
  });

  test("the injected panel-state expression runs against a page document", () => {
    const plus = new FakeElement("button", {
      "data-composer-navigation-target": "add-context",
      "aria-expanded": "true",
      "data-state": "open",
    });
    const document = new FakeDocument([
      new FakeElement("form", { "data-chatgpt-composer": "" }, [editor(), plus]),
      new FakeElement("div", { "data-composer-overlay-floating-ui": "true" }, [
        new FakeElement("button", { "data-list-navigation-item": "true" }, [], "Web search"),
      ]),
    ]);
    const state = new Function("document", `return ${buildComposerPanelStateExpression()}`)(
      document,
    );
    expect(state).toEqual({ plus: true, expanded: true, rows: 1 });
  });
});

describe("composer panel row titles", () => {
  const row = (title: string, description: string) =>
    new FakeElement("button", { "data-list-navigation-item": "true" }, [
      new FakeElement("div", { "data-menu-row-content": "true" }, [
        new FakeElement("span", { "aria-hidden": "true" }),
        new FakeElement("span", {}, [
          new FakeElement("span", {}, [
            new FakeElement("span", {}, [], title),
            new FakeElement("span", {}, [], description),
          ]),
        ]),
      ]),
    ]);

  test("reads the title span even when rendered text has no line breaks", () => {
    const labels = readComposerRowLabels(
      row("Web search", "Find real-time news and info") as unknown as Element,
    );
    expect(labels.leaf).toBe("Web search");
    expect(labels.text).toBe("Web searchFind real-time news and info");
    expect(composerRowTitleEquals(labels, ["web search"])).toBe(true);
  });

  test("matches app names by title, never by description text", () => {
    const codexish = readComposerRowLabels(
      row("CODEXish", "Connects to the owner's PC") as unknown as Element,
    );
    const other = readComposerRowLabels(
      row("Code", "Works like CODEXish for snippets") as unknown as Element,
    );
    expect(composerRowTitleEquals(codexish, ["codexish"])).toBe(true);
    expect(composerRowTitleEquals(other, ["codexish"])).toBe(false);
  });

  test("uses the first rendered line when innerText separates title and description", () => {
    expect(
      composerRowTitleEquals(
        { title: "Deep research", leaf: "", text: "Deep research Get a detailed report", aria: "" },
        ["Deep research"],
      ),
    ).toBe(true);
  });
});

class TextNodeElement extends FakeElement {
  constructor(
    tag: string,
    readonly attrs: Record<string, string> = {},
    readonly nodes: Array<TextNodeElement | string> = [],
  ) {
    super(
      tag,
      attrs,
      nodes.filter((node): node is TextNodeElement => typeof node !== "string"),
    );
  }
  nodeType = 1;
  get nodeName() {
    return this.tagName;
  }
  get childNodes(): Array<
    TextNodeElement | { nodeType: number; nodeName: string; nodeValue: string }
  > {
    return this.nodes.map((node) =>
      typeof node === "string" ? { nodeType: 3, nodeName: "#text", nodeValue: node } : node,
    );
  }
  cloneNode(): TextNodeElement {
    return new TextNodeElement(
      this.tagName,
      { ...this.attrs },
      this.nodes.map((node) => (typeof node === "string" ? node : node.cloneNode())),
    );
  }
  override remove() {
    const parent = this.parentElement as TextNodeElement | null;
    super.remove();
    if (parent) parent.nodes.splice(parent.nodes.indexOf(this), 1);
  }
}

describe("staged prompt text", () => {
  test("drops mentions and keeps paragraph breaks", () => {
    const mention = new TextNodeElement(
      "span",
      { "app-mention-name": "codexish", "data-prompt-link-href": "app://asdk_app_example" },
      ["CODEXish"],
    );
    const editor = new TextNodeElement("div", {}, [
      new TextNodeElement("p", {}, [mention, " First line"]),
      new TextNodeElement("p", {}, ["Second line"]),
    ]);
    expect(readComposerPromptText(editor as unknown as Element, COMPOSER_TOKEN_SELECTOR)).toEqual({
      text: " First line\nSecond line",
      tokens: 1,
    });
  });

  test.each<Record<string, string>>([
    { "app-mention-display-name": "CODEXish" },
    { "app-mention-path": "app://asdk_app_example" },
    { "plugin-mention-display-name": "CODEXish" },
    { "plugin-mention-path": "plugin://dev-example@openai-curated-remote" },
    { "data-prompt-link-label": "$codexish" },
    { "data-system-hint-type": "search" },
  ])("treats a token carrying only %o as a token, not prompt text", (attributes) => {
    const token = new TextNodeElement("span", attributes, ["CODEXish"]);
    const editor = new TextNodeElement("div", {}, [
      new TextNodeElement("p", {}, [token, " Prompt"]),
    ]);
    expect(readComposerPromptText(editor as unknown as Element, COMPOSER_TOKEN_SELECTOR)).toEqual({
      text: " Prompt",
      tokens: 1,
    });
  });
});

describe("shared token matchers", () => {
  const span = (attributes: Record<string, string>, text = "") =>
    new FakeElement("span", attributes, [], text) as unknown as Element;

  test("mention names fall back from display names to names to the visible label", () => {
    expect(
      readMentionNames(span({ "plugin-mention-display-name": "CODEXish" }, "CODEXish")),
    ).toEqual(["CODEXish", "CODEXish"]);
    expect(readMentionNames(span({ "app-mention-name": "codexish" }, "@CODEXish"))).toEqual([
      "codexish",
      "CODEXish",
    ]);
    expect(readMentionNames(span({ "app-mention-path": "app://x" }, "$Slack"))).toEqual(["Slack"]);
  });

  test("Web search and Deep research tokens are recognised by any of their markers", () => {
    expect(isWebSearchPill(span({ "data-system-hint-type": "search" }))).toBe(true);
    expect(isWebSearchPill(span({ "data-prompt-link-href": "chatgpt-system-hint://search" }))).toBe(
      true,
    );
    expect(isWebSearchPill(span({ "data-id": "search" }))).toBe(true);
    expect(isWebSearchPill(span({ "data-system-hint-type": "image", "data-id": "search" }))).toBe(
      false,
    );
    const deepResearch: Array<Record<string, string>> = [
      { "app-mention-name": "deep-research" },
      { "plugin-mention-path": "app://connector_openai_deep_research" },
      { "data-prompt-link-label": "$deep-research" },
      { "app-mention-display-name": "Deep research" },
    ];
    for (const attributes of deepResearch) {
      expect(isDeepResearchMention(span(attributes))).toBe(true);
    }
    expect(isDeepResearchMention(span({}, "Deep research"))).toBe(true);
    expect(isDeepResearchMention(span({ "app-mention-name": "codexish" }, "CODEXish"))).toBe(false);
  });
});

describe("guarded trusted click", () => {
  test("does not click a target covered by another element", async () => {
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: { value: { status: "obscured", detail: "div" } },
      })),
    };
    const input = { dispatchMouseEvent: vi.fn() };
    await expect(
      guardedTrustedClick(runtime as never, input as never, {
        locate: "() => null",
        stage: "web-search-activate",
        target: "Web search row",
        settleTimeoutMs: 0,
      }),
    ).resolves.toEqual({ status: "obscured", detail: "div" });
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test("stops before the click when the ChatGPT context changed", async () => {
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: {
            status: "context-changed",
            navigation: { currentUrl: "https://chatgpt.com/c/WEB:task", workSelected: false },
          },
        },
      })),
    };
    const input = { dispatchMouseEvent: vi.fn() };
    await expect(
      guardedTrustedClick(runtime as never, input as never, {
        locate: "() => null",
        navigationUrl: "https://chatgpt.com/",
        stage: "deep-research-activate",
        target: "Deep research row",
      }),
    ).rejects.toMatchObject({
      details: {
        code: "attachment-control-unexpected-navigation",
        stage: "deep-research-activate",
      },
    });
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test("reports a click the page guard cancelled at delivery", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("__oracleTrustedClickGuards ??=")) {
          return { result: { value: { ready: true, contextMatches: true } } };
        }
        if (expression.includes("const summary = { reached")) {
          return {
            result: { value: { reached: false, blocked: { ready: false, contextMatches: true } } },
          };
        }
        return { result: { value: { status: "ready", x: 10, y: 20 } } };
      }),
    };
    const input = { dispatchMouseEvent: vi.fn() };
    await expect(
      guardedTrustedClick(runtime as never, input as never, {
        locate: "() => null",
        stage: "app-approval",
        target: "The approval button",
      }),
    ).rejects.toMatchObject({ details: { code: "trusted-click-cancelled" } });
    expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
  });
});
