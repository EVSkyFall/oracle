import { describe, expect, test, vi } from "vitest";
import {
  APP_APPROVAL_VOCABULARY,
  buildAppApprovalInPageClickExpression,
  buildAppApprovalLocate,
  describeAppApprovalSkip,
  scanAppApprovalCards,
  startAppApprovalMonitor,
} from "../../src/browser/actions/appApprovals.js";
import { DomNode, FakeDocument } from "./domFixture.js";

const button = (label: string) => new DomNode("button", {}, [label]);
// The composer form always holds its editor; a form without one is not the composer.
const composerEditor = () => new DomNode("div", { contenteditable: "true", role: "textbox" });
const scan = (children: DomNode[], allowApps = ["CODEXish"]) =>
  scanAppApprovalCards(
    new FakeDocument(children) as unknown as Document,
    allowApps,
    APP_APPROVAL_VOCABULARY,
  ).cards;

describe("app approval button labels", () => {
  const cardWith = (...buttons: DomNode[]) => [
    new DomNode("div", { role: "dialog" }, [
      new DomNode("p", {}, ["Allow CODEXish to run echo?"]),
      new DomNode("div", {}, buttons),
    ]),
  ];
  const chosen = (...buttons: DomNode[]) => scan(cardWith(...buttons))[0]?.button ?? null;

  test("shortcut hints, icons and hidden parts are not part of the label", () => {
    expect(
      chosen(new DomNode("button", {}, ["항상 허용", new DomNode("kbd", {}, ["⌘⏎"])])),
    ).toMatchObject({ label: "항상 허용", rank: 0 });
    expect(
      chosen(
        new DomNode("button", {}, [
          new DomNode("svg", {}, [new DomNode("title", {}, ["check"])]),
          "Always allow",
        ]),
      ),
    ).toMatchObject({ label: "Always allow", rank: 0 });
    expect(
      chosen(
        new DomNode("button", {}, [
          new DomNode("span", { "aria-hidden": "true" }, ["✓ "]),
          "Allow once",
          new DomNode("span", { hidden: "" }, [" (Enter)"]),
        ]),
      ),
    ).toMatchObject({ label: "Allow once", rank: 1 });
  });

  test.each([
    ["Allow once ⌘↵", "Allow once", 1],
    ["Always allow Ctrl+Enter", "Always allow", 0],
    ["한 번만 허용 Enter", "한 번만 허용", 1],
    ["Allow ⌘1", "Allow", 2],
    ["Allow for this chat", "Allow for this chat", 2],
    ["Always allow for this chat", "Always allow for this chat", 0],
    ["허용 (이 채팅)", "허용 (이 채팅)", 2],
    ["  ALWAYS   ALLOW ", "ALWAYS ALLOW", 0],
  ])("accepts %j as %j at rank %i", (text, label, rank) => {
    expect(chosen(button(text))).toEqual({ label, rank, index: 0 });
  });

  test("an icon-only button is named by its aria-label", () => {
    expect(
      chosen(new DomNode("button", { "aria-label": "Always allow" }, [new DomNode("svg")])),
    ).toMatchObject({ label: "Always allow", rank: 0 });
  });

  test.each([
    "Allowed",
    "Allowance",
    "허용됨",
    "Don't allow",
    "Don’t allow",
    "Do not allow",
    "Allow, don't ask again",
    "Deny",
    "Not now",
    "Cancel",
    "거부 Esc",
    "허용 안 함",
    "허용하지 않음",
    "취소",
    "Approve",
    "Continue",
  ])("never accepts %j", (text) => {
    expect(chosen(button(text))).toBeNull();
  });

  test("a deny aria-label wins over an allow-looking text", () => {
    expect(chosen(new DomNode("button", { "aria-label": "Don't allow" }, ["Allow"]))).toBeNull();
  });

  test("keeps the strongest acceptable button of the card", () => {
    expect(
      chosen(
        button("Deny"),
        button("Allow for this chat"),
        new DomNode("button", {}, ["Allow once", new DomNode("kbd", {}, ["⏎"])]),
      ),
    ).toMatchObject({ label: "Allow once", rank: 1 });
  });
});

describe("app approval cards", () => {
  test("approves a Korean CODEXish prompt with its strongest allow button", () => {
    const cards = scan([
      new DomNode("main", {}, [
        new DomNode("div", { class: "card" }, [
          new DomNode("p", {}, ["ChatGPT가 CODEXish을(를) 사용하도록 허용할까요?"]),
          new DomNode("div", {}, [button("거부"), button("1회 허용"), button("항상 허용")]),
        ]),
      ]),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      app: "CODEXish",
      toolText: "ChatGPT가 CODEXish을(를) 사용하도록 허용할까요?",
      button: { label: "항상 허용", rank: 0 },
    });
  });

  test("prefers Allow once over Allow, and Always allow over both", () => {
    const [once] = scan([
      new DomNode("div", { role: "dialog" }, [
        new DomNode("p", {}, ["CODEXish wants to run shell: echo hi"]),
        button("Allow"),
        button("Allow once"),
        button("Deny"),
      ]),
    ]);
    expect(once?.button).toMatchObject({ label: "Allow once", rank: 1 });
    const [always] = scan([
      new DomNode("main", {}, [
        new DomNode("div", {}, [
          new DomNode("span", {}, ["Use CODEXish?"]),
          button("Allow"),
          button(" Always  allow "),
        ]),
      ]),
    ]);
    expect(always?.button).toMatchObject({ label: "Always allow", rank: 0 });
  });

  test("leaves another app's card alone even when the turn's prose and prompt name the allowed app", () => {
    const cards = scan([
      new DomNode("main", {}, [
        new DomNode("div", { "data-message-author-role": "user" }, [
          new DomNode("div", { class: "markdown" }, ["Please use CODEXish for this."]),
        ]),
        new DomNode("article", { "data-turn": "assistant" }, [
          new DomNode("div", { class: "markdown prose" }, ["I will call CODEXish first."]),
          new DomNode("div", { class: "card" }, [
            new DomNode("p", {}, ["Allow Gmail to send an email?"]),
            new DomNode("div", {}, [button("Allow"), button("Deny")]),
          ]),
        ]),
      ]),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.app).toBeNull();
  });

  test("ignores deny-only prompts, buttons without a card, and look-alike app names", () => {
    expect(
      scan([
        new DomNode("div", {}, [
          new DomNode("p", {}, ["CODEXish?"]),
          button("Deny"),
          button("Cancel"),
        ]),
      ]),
    ).toEqual([]);
    expect(scan([new DomNode("article", {}, [button("Allow")])])).toEqual([]);
    const [lookAlike] = scan([
      new DomNode("main", {}, [
        new DomNode("div", {}, [
          new DomNode("p", {}, ["Allow CODEXishPro to run?"]),
          button("Allow"),
        ]),
      ]),
    ]);
    expect(lookAlike?.app).toBeNull();
    const [allowed] = scan(
      [
        new DomNode("main", {}, [
          new DomNode("div", {}, [
            new DomNode("p", {}, ["Allow codexish to run?"]),
            button("Allow"),
          ]),
        ]),
      ],
      ["CODEXish"],
    );
    expect(allowed?.app).toBe("CODEXish");
  });
});

describe("app approval scope", () => {
  const allowCard = (text: string) =>
    new DomNode("div", {}, [new DomNode("p", {}, [text]), button("Allow")]);

  test.each([
    ["the sidebar", (card: DomNode) => new DomNode("nav", {}, [card])],
    ["an aside", (card: DomNode) => new DomNode("aside", {}, [card])],
    [
      "the page header",
      (card: DomNode) => new DomNode("main", {}, [new DomNode("header", {}, [card])]),
    ],
    [
      "the composer",
      (card: DomNode) =>
        new DomNode("main", {}, [
          new DomNode("form", { "data-chatgpt-composer": "" }, [card, composerEditor()]),
        ]),
    ],
    [
      "assistant prose",
      (card: DomNode) =>
        new DomNode("article", { "data-turn": "assistant" }, [
          new DomNode("div", { class: "markdown prose" }, [card]),
        ]),
    ],
    [
      "a user message",
      (card: DomNode) =>
        new DomNode("main", {}, [
          new DomNode("div", { "data-message-author-role": "user" }, [card]),
        ]),
    ],
    // An article (a turn boundary) inside an excluded region must not end the check.
    [
      "an article inside assistant prose",
      (card: DomNode) =>
        new DomNode("main", {}, [
          new DomNode("div", { class: "markdown prose" }, [
            new DomNode("article", { "data-turn": "assistant" }, [card]),
          ]),
        ]),
    ],
    [
      "an article inside a user message",
      (card: DomNode) =>
        new DomNode("main", {}, [
          new DomNode("div", { "data-message-author-role": "user" }, [
            new DomNode("article", {}, [card]),
          ]),
        ]),
    ],
  ])("never treats an Allow button in %s as an approval card", (_where, wrap) => {
    expect(scan([wrap(allowCard("Allow CODEXish to run echo?"))])).toEqual([]);
  });

  const turn = (...children: DomNode[]) =>
    new DomNode("main", {}, [new DomNode("article", { "data-turn": "assistant" }, children)]);

  test("the title is one rendered line: what follows it never names the app", () => {
    const [withBreak] = scan([
      turn(
        new DomNode("div", {}, [
          new DomNode("p", {}, ["Allow Gmail?", new DomNode("br"), "message: CODEXish"]),
          button("Allow"),
        ]),
      ),
    ]);
    expect(withBreak).toMatchObject({ app: null, title: "Allow Gmail?" });
    const [withNewline] = scan([
      turn(
        new DomNode("div", {}, [
          new DomNode("p", {}, ["Allow Gmail?\nmessage: CODEXish"]),
          button("Allow"),
        ]),
      ),
    ]);
    expect(withNewline).toMatchObject({ app: null, title: "Allow Gmail?" });
  });

  test("inline pieces of the first line form one title", () => {
    const [card] = scan([
      turn(
        new DomNode("div", {}, [
          new DomNode("div", {}, [
            new DomNode("span", {}, ["Allow "]),
            new DomNode("strong", {}, ["CODEXish"]),
            new DomNode("span", {}, [" to run bash?"]),
          ]),
          new DomNode("p", {}, ["shell: echo ready"]),
          button("Allow once"),
        ]),
      ),
    ]);
    expect(card).toMatchObject({ app: "CODEXish", title: "Allow CODEXish to run bash?" });
  });

  test("a generic title is left for the user even when a later line names the app", () => {
    const [card] = scan([
      turn(
        new DomNode("div", {}, [
          new DomNode("h2", {}, ["Permission request"]),
          new DomNode("p", {}, ["ChatGPT wants to use CODEXish"]),
          button("Allow"),
        ]),
      ),
    ]);
    expect(card).toMatchObject({ app: null, title: "Permission request" });
  });

  test("tool arguments that name the allowed app do not approve another app's card", () => {
    const cards = scan([
      new DomNode("article", { "data-turn": "assistant" }, [
        new DomNode("div", { class: "card" }, [
          new DomNode("p", {}, ["Allow Gmail to send an email?"]),
          new DomNode("pre", {}, ["to: me@example.com\nbody: CODEXish says hi"]),
          new DomNode("div", {}, [button("Always allow"), button("Deny")]),
        ]),
      ]),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ app: null, title: "Allow Gmail to send an email?" });
  });

  test("the title comes from a heading or the dialog's label before the first line", () => {
    const [byHeading] = scan([
      new DomNode("div", { role: "dialog" }, [
        new DomNode("p", {}, ["Gmail would like to read your inbox"]),
        new DomNode("h2", {}, ["Allow CODEXish?"]),
        button("Allow once"),
      ]),
    ]);
    expect(byHeading).toMatchObject({ app: "CODEXish", title: "Allow CODEXish?" });
    const [byLabel] = scan([
      new DomNode("span", { id: "title-1" }, ["Allow Slack to post?"]),
      new DomNode("div", { role: "alertdialog", "aria-labelledby": "title-1" }, [
        new DomNode("p", {}, ["CODEXish context: shell echo"]),
        button("Allow"),
      ]),
    ]);
    expect(byLabel).toMatchObject({ app: null, title: "Allow Slack to post?" });
  });

  test("the in-page click clicks only a button the fresh scan verifies", () => {
    const allow = Object.assign(button("Always allow"), { click: vi.fn() });
    const title = new DomNode("p", {}, ["Allow CODEXish to run echo?"]);
    const document = new FakeDocument([
      new DomNode("div", { role: "alert" }, [title, new DomNode("div", {}, [allow])]),
    ]);
    const window = { __oracleApprovalButtons: { token: "t", nodes: [allow] } };
    const card = { app: "CODEXish", button: { label: "Always allow", rank: 0, index: 0 } };
    const clickInPage = () =>
      new Function(
        "document",
        "window",
        `return ${buildAppApprovalInPageClickExpression(["CODEXish"], "t", card)}`,
      )(document, window);
    title.nodes.splice(0, 1, "Allow Gmail to run echo?");
    expect(clickInPage()).toEqual({ status: "missing" });
    expect(allow.click).not.toHaveBeenCalled();
    title.nodes.splice(0, 1, "Allow CODEXish to run echo?");
    expect(clickInPage()).toEqual({ status: "clicked" });
    expect(allow.click).toHaveBeenCalledTimes(1);
  });

  test("the click target is re-checked at delivery", () => {
    const allow = button("Always allow");
    const title = new DomNode("p", {}, ["Allow CODEXish to run echo?"]);
    const document = new FakeDocument([
      new DomNode("div", { role: "dialog" }, [title, new DomNode("div", {}, [allow])]),
    ]);
    const window = { __oracleApprovalButtons: { token: "t", nodes: [allow] } };
    const card = { app: "CODEXish", button: { label: "Always allow", rank: 0, index: 0 } };
    const locate = () =>
      new Function(
        "document",
        "window",
        `return (${buildAppApprovalLocate(["CODEXish"], "t", card)})()`,
      )(document, window);
    expect(locate()).toBe(allow);
    title.nodes.splice(0, 1, "Allow Gmail to run echo?");
    expect(locate()).toBeNull();
    title.nodes.splice(0, 1, "Allow CODEXish to run echo?");
    allow.nodes.splice(0, 1, "Deny");
    expect(locate()).toBeNull();
  });
});

describe("ChatGPT's approval card as captured on 2026-10-26", () => {
  // Structure of the live card: a text-only role="alert" and, beside it, the buttons in the
  // card's own small form; the card marks itself as an approval surface.
  const capturedCard = (marked: boolean) =>
    new DomNode(
      "div",
      marked
        ? { class: "flex flex-col @container/approval-card", "data-codex-approval-surface": "true" }
        : { class: "flex flex-col @container/approval-card" },
      [
        new DomNode("div", { class: "flex min-h-0 flex-col gap-2" }, [
          new DomNode("div", { class: "flex items-start gap-2" }, [
            new DomNode("div", { class: "min-w-0 flex-1", "aria-atomic": "true", role: "alert" }, [
              new DomNode("div", { class: "flex min-w-0 flex-col gap-2" }, [
                new DomNode("div", { class: "flex items-center gap-2" }, [
                  new DomNode("svg", {}, [new DomNode("path")]),
                  new DomNode("span", {}, ["CODEXish"]),
                ]),
                new DomNode("div", { class: "flex min-w-0 flex-col gap-0.5" }, [
                  new DomNode("div", {}, ["Allow ChatGPT to use CODEXish?"]),
                  new DomNode("div", {}, [
                    "ChatGPT will call CODEXish's Host Capabilities tool. ",
                    new DomNode("button", { type: "button" }, ["See details"]),
                  ]),
                ]),
              ]),
            ]),
          ]),
        ]),
        new DomNode("form", { class: "flex shrink-0 items-center gap-2" }, [
          new DomNode("button", { type: "button" }, [new DomNode("span", {}, ["Always allow"])]),
          new DomNode("div", { class: "ms-auto flex" }, [
            new DomNode("button", { type: "button" }, [
              "Deny",
              new DomNode("span", {}, [new DomNode("kbd", { "aria-hidden": "true" }, ["Esc"])]),
            ]),
            new DomNode("div", { class: "inline-flex" }, [
              new DomNode("button", { type: "button" }, [
                new DomNode("span", {}, ["Allow once"]),
                new DomNode("span", {}, [new DomNode("kbd", { "aria-hidden": "true" }, ["⏎"])]),
              ]),
              new DomNode("button", { type: "button", "aria-label": "Approval options" }, [
                new DomNode("svg"),
              ]),
            ]),
          ]),
        ]),
      ],
    );

  test.each([
    ["marked as an approval surface", true],
    ["without the marker", false],
  ])("is approved with Always allow when %s, and nothing else is reported", (_how, marked) => {
    const { cards, skipped } = scanAppApprovalCards(
      new FakeDocument([
        new DomNode("main", {}, [
          new DomNode("div", { class: "block-BQZwFn" }, [
            new DomNode("div", {}, [capturedCard(marked)]),
          ]),
          new DomNode("form", { class: "relative flex flex-col gap-2" }, [composerEditor()]),
        ]),
      ]) as unknown as Document,
      ["CODEXish"],
      APP_APPROVAL_VOCABULARY,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      app: "CODEXish",
      title: "CODEXish",
      button: { label: "Always allow", rank: 0 },
    });
    expect(cards[0]!.toolText).toContain("Allow ChatGPT to use CODEXish?");
    expect(skipped).toEqual([]);
  });
});

describe("app approval role cards", () => {
  const alert = (title: string, ...buttons: DomNode[]) =>
    new DomNode("div", { role: "alert" }, [
      new DomNode("div", {}, [new DomNode("p", {}, [title])]),
      new DomNode("div", {}, buttons),
    ]);
  const codexish = () => alert("Allow CODEXish to use Fs Read?", button("Always allow"));

  test.each([
    [
      "the composer form",
      (card: DomNode) =>
        new DomNode("main", {}, [
          new DomNode("form", { class: "relative flex flex-col gap-2" }, [
            new DomNode("div", { class: "ComposerModeSurface-lVLm7j" }, [
              card,
              new DomNode("div", { contenteditable: "true", role: "textbox" }),
            ]),
          ]),
        ]),
    ],
    [
      "a floating layer",
      (card: DomNode) =>
        new DomNode("div", { "data-composer-overlay-floating-ui": "" }, [
          new DomNode("div", { "data-testid": "composer-popover" }, [card]),
        ]),
    ],
    ["the page header", (card: DomNode) => new DomNode("header", {}, [card])],
    [
      "assistant prose",
      (card: DomNode) =>
        new DomNode("main", {}, [new DomNode("div", { class: "markdown prose" }, [card])]),
    ],
  ])("an alert card is approved in %s", (_where, wrap) => {
    const cards = scan([wrap(codexish())]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      app: "CODEXish",
      title: "Allow CODEXish to use Fs Read?",
      button: { label: "Always allow", rank: 0 },
    });
  });

  test.each([
    [
      "a user message (role attribute)",
      (card: DomNode) =>
        new DomNode("main", {}, [
          new DomNode("div", { "data-message-author-role": "user" }, [card]),
        ]),
    ],
    [
      "today's user message (group class)",
      (card: DomNode) =>
        new DomNode("main", {}, [
          new DomNode("div", { class: "group/user-message flex flex-col items-end gap-2" }, [card]),
        ]),
    ],
    [
      "today's user markdown root",
      (card: DomNode) =>
        new DomNode("main", {}, [
          new DomNode("div", { class: "MarkdownRoot-rZKhxa rich-text-user-turn" }, [card]),
        ]),
    ],
    [
      "an editable area",
      (card: DomNode) =>
        new DomNode("main", {}, [new DomNode("div", { contenteditable: "true" }, [card])]),
    ],
    [
      "a textbox",
      (card: DomNode) => new DomNode("main", {}, [new DomNode("div", { role: "textbox" }, [card])]),
    ],
  ])("an alert card inside %s is never approved", (_where, wrap) => {
    expect(scan([wrap(codexish())])).toEqual([]);
  });

  test("the alert element is the card: its heading names the app above an inner block", () => {
    const [card] = scan([
      new DomNode("main", {}, [
        new DomNode("div", { role: "alert" }, [
          new DomNode("h3", {}, ["CODEXish"]),
          new DomNode("div", {}, [
            new DomNode("p", {}, ["Use Host Capabilities?"]),
            new DomNode("div", {}, [button("항상 허용"), button("거부")]),
          ]),
        ]),
      ]),
    ]);
    expect(card).toMatchObject({ app: "CODEXish", title: "CODEXish" });
  });

  test("a chat frame dialog (it holds an editor) never lends its label as a card title", () => {
    const cards = scan([
      new DomNode("section", { role: "dialog", "aria-label": "CODEXish smoke test" }, [
        new DomNode("div", {}, [
          new DomNode("div", { class: "card" }, [
            new DomNode("p", {}, ["Allow Gmail to send an email?"]),
            new DomNode("div", {}, [button("Always allow")]),
          ]),
        ]),
        new DomNode("form", {}, [new DomNode("div", { contenteditable: "true" })]),
      ]),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ app: null, title: "Allow Gmail to send an email?" });
  });

  test.each([
    [
      "today's user turn",
      () =>
        new DomNode("div", { class: "group/user-message flex" }, [
          new DomNode("div", { class: "MarkdownRoot-rZKhxa rich-text-user-turn" }, ["Use it"]),
        ]),
    ],
    [
      "an assistant turn",
      () => new DomNode("div", { "data-message-author-role": "assistant" }, ["Sure."]),
    ],
    ["an article", () => new DomNode("article", {}, ["Sure."])],
  ])("a chat frame without an editor but with %s is never a card", (_what, turn) => {
    const cards = scan([
      new DomNode("section", { role: "dialog", "aria-label": "CODEXish smoke test" }, [
        turn(),
        new DomNode("div", { class: "card" }, [
          new DomNode("p", {}, ["Allow Gmail to send an email?"]),
          new DomNode("div", {}, [button("Always allow")]),
        ]),
      ]),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ app: null, title: "Allow Gmail to send an email?" });
  });

  test("an alert holding several prompts gives each prompt its own card", () => {
    const cards = scan([
      new DomNode("main", {}, [
        new DomNode("div", { role: "alert", "aria-label": "CODEXish" }, [
          new DomNode("div", {}, [
            new DomNode("p", {}, ["Allow CODEXish to use Fs Read?"]),
            button("Allow once"),
          ]),
          new DomNode("div", {}, [
            new DomNode("p", {}, ["Allow Gmail to send an email?"]),
            button("Always allow"),
          ]),
        ]),
      ]),
    ]);
    expect(cards.map((card) => [card.title, card.app, card.button.label])).toEqual([
      ["Allow CODEXish to use Fs Read?", "CODEXish", "Allow once"],
      ["Allow Gmail to send an email?", null, "Always allow"],
    ]);
  });
});

describe("app approval skips", () => {
  const skippedOf = (children: DomNode[]) =>
    scanAppApprovalCards(
      new FakeDocument(children) as unknown as Document,
      ["CODEXish"],
      APP_APPROVAL_VOCABULARY,
    );

  test("an allowed app's alert with unknown buttons is reported with its labels", () => {
    const { cards, skipped } = skippedOf([
      new DomNode("main", {}, [
        new DomNode("div", { role: "alert" }, [
          new DomNode("p", {}, ["Allow CODEXish to use Fs Read?"]),
          new DomNode("div", {}, [button("Cancel"), button("Continue")]),
        ]),
      ]),
    ]);
    expect(cards).toEqual([]);
    expect(skipped).toEqual([
      expect.objectContaining({
        reason: "label",
        labels: ["Cancel", "Continue"],
        title: "Allow CODEXish to use Fs Read?",
        app: "CODEXish",
      }),
    ]);
  });

  test("an allowed app's alert with no enabled button is reported, another app's is not", () => {
    const { cards, skipped } = skippedOf([
      new DomNode("main", {}, [
        new DomNode("div", { role: "alert" }, [
          new DomNode("p", {}, ["Allow CODEXish to use Fs Read?"]),
          new DomNode("a", { href: "#" }, ["Always allow"]),
          new DomNode("button", { disabled: "" }, ["Allow once"]),
        ]),
        new DomNode("div", { role: "alert" }, [new DomNode("p", {}, ["Gmail is offline"])]),
      ]),
    ]);
    expect(cards).toEqual([]);
    expect(skipped).toEqual([
      expect.objectContaining({ reason: "label", labels: [], app: "CODEXish" }),
    ]);
    expect(describeAppApprovalSkip(skipped[0]!)).toBe(
      '[browser] App approval left for the user: "Allow CODEXish to use Fs Read?" shows no enabled button Oracle can click.',
    );
  });

  test("another app's alert without allow-looking buttons is not reported", () => {
    const { skipped } = skippedOf([
      new DomNode("main", {}, [
        new DomNode("div", { role: "alert" }, [
          new DomNode("p", {}, ["Gmail could not connect"]),
          button("Retry"),
        ]),
      ]),
    ]);
    expect(skipped).toEqual([]);
  });

  test("an allow-looking label outside the list is reported, in role cards and other cards", () => {
    const { cards, skipped } = skippedOf([
      new DomNode("main", {}, [
        new DomNode("div", { class: "card" }, [
          new DomNode("p", {}, ["Allow CODEXish to run echo?"]),
          button("Approve"),
        ]),
        new DomNode("div", { role: "alertdialog" }, [
          new DomNode("p", {}, ["Allow Gmail to send?"]),
          button("Allowed"),
        ]),
      ]),
    ]);
    expect(cards).toEqual([]);
    expect(skipped.map((skip) => [skip.reason, skip.labels, skip.app])).toEqual([
      ["label", ["Allowed"], null],
      ["label", ["Approve"], "CODEXish"],
    ]);
  });

  test("an allow button in an excluded place is reported with that place", () => {
    const card = () =>
      new DomNode("div", {}, [new DomNode("p", {}, ["Allow CODEXish?"]), button("Always allow")]);
    const { cards, skipped } = skippedOf([
      new DomNode("nav", {}, [card()]),
      new DomNode("main", {}, [
        new DomNode("form", { class: "relative flex flex-col gap-2 extra" }, [
          card(),
          composerEditor(),
        ]),
      ]),
    ]);
    expect(cards).toEqual([]);
    expect(skipped.map((skip) => [skip.reason, skip.labels, skip.detail])).toEqual([
      ["excluded", ["Always allow"], "nav"],
      ["excluded", ["Always allow"], "form.relative.flex.flex-col.gap-2"],
    ]);
  });

  test("a diagnostic subject never climbs past the excluding ancestor", () => {
    const subjectOfSkip = (children: DomNode[]) => {
      const result = skippedOf(children);
      expect(result.skipped).toHaveLength(1);
      return result.subjects[result.skipped[0]!.subject] as unknown as DomNode;
    };
    // A form holding only the button, next to conversation text: the button's parent, not main.
    const row = new DomNode("div", { class: "row" }, [button("Always allow")]);
    expect(
      subjectOfSkip([
        new DomNode("main", {}, [
          new DomNode("p", {}, ["Conversation text"]),
          new DomNode("form", { class: "relative flex" }, [row, composerEditor()]),
        ]),
      ]),
    ).toBe(row);
    // The sidebar's chat list stays out of it.
    const navRow = new DomNode("div", {}, [button("Allow")]);
    expect(
      subjectOfSkip([
        new DomNode("nav", {}, [
          new DomNode("ul", {}, [new DomNode("li", {}, ["Chat A"]), new DomNode("li", {}, ["B"])]),
          navRow,
        ]),
      ]),
    ).toBe(navRow);
    // A text card below the excluding ancestor is the subject.
    const card = new DomNode("div", { class: "card" }, [
      new DomNode("p", {}, ["Allow CODEXish?"]),
      button("Always allow"),
    ]);
    expect(
      subjectOfSkip([new DomNode("main", {}, [new DomNode("form", {}, [card, composerEditor()])])]),
    ).toBe(card);
  });

  test("a card that holds a rendered message is narrowed to its button", () => {
    const allow = button("Always allow");
    const { cards, subjects } = skippedOf([
      new DomNode("main", {}, [
        new DomNode("div", { class: "message" }, [
          new DomNode("div", { class: "markdown prose" }, ["A long answer from the model."]),
          new DomNode("p", {}, ["Allow Gmail to send an email?"]),
          allow,
        ]),
      ]),
    ]);
    expect(cards).toHaveLength(1);
    expect(subjects[cards[0]!.subject!]).toBe(allow);
  });

  test("an allow button with nothing around it is reported as having no card", () => {
    const { skipped } = skippedOf([
      new DomNode("main", {}, [new DomNode("div", {}, [button("Allow")])]),
    ]);
    expect(skipped).toEqual([expect.objectContaining({ reason: "no-card", labels: ["Allow"] })]);
  });

  test("deny buttons and the other buttons of a taken card are not reported", () => {
    const { cards, skipped } = skippedOf([
      new DomNode("main", {}, [
        new DomNode("div", {}, [
          new DomNode("p", {}, ["Allow CODEXish to run echo?"]),
          button("Approve all"),
          button("Always allow"),
          button("Don't allow"),
        ]),
        new DomNode("div", { role: "alert" }, [
          new DomNode("p", {}, ["Allow CODEXish to read?"]),
          button("Allow once"),
          button("Approve later"),
        ]),
      ]),
    ]);
    expect(cards).toHaveLength(2);
    expect(skipped).toEqual([]);
  });
});

describe("app approval prompts split inside a role card", () => {
  const scanAll = (children: DomNode[]) =>
    scanAppApprovalCards(
      new FakeDocument([new DomNode("main", {}, children)]) as unknown as Document,
      ["CODEXish"],
      APP_APPROVAL_VOCABULARY,
    );
  const block = (text: string, ...buttons: DomNode[]) =>
    new DomNode("div", {}, [new DomNode("p", {}, [text]), ...buttons]);

  test("blocks without an app name keep the role card's title and form one card", () => {
    const { cards } = scanAll([
      new DomNode("div", { role: "alert" }, [
        new DomNode("h3", {}, ["CODEXish"]),
        block("Use Fs Read?", button("Allow once")),
        block("Use Host Capabilities?", button("Always allow")),
      ]),
    ]);
    expect(cards.map((card) => [card.app, card.title, card.button.label])).toEqual([
      ["CODEXish", "CODEXish", "Always allow"],
    ]);
  });

  test("buttons with helper text of their own stay one CODEXish card", () => {
    const { cards } = scanAll([
      new DomNode("div", { role: "alert" }, [
        new DomNode("h3", {}, ["CODEXish"]),
        new DomNode("div", {}, [new DomNode("span", {}, ["Only this time"]), button("Allow once")]),
        new DomNode("div", {}, [new DomNode("span", {}, ["Every chat"]), button("Always allow")]),
        new DomNode("div", {}, [button("Deny")]),
      ]),
    ]);
    expect(cards.map((card) => [card.app, card.title, card.button.label])).toEqual([
      ["CODEXish", "CODEXish", "Always allow"],
    ]);
  });

  test.each([
    ["Allow Gmail to send an email?"],
    ["Gmail wants to read your inbox"],
    ["ChatGPT가 Gmail을(를) 사용하도록 허용할까요?"],
  ])("a block whose title names another app (%j) stays that app's card", (title) => {
    const { cards } = scanAll([
      new DomNode("div", { role: "alert" }, [
        new DomNode("h3", {}, ["CODEXish"]),
        block("Use Fs Read?", button("Allow once")),
        block(title, button("Always allow")),
      ]),
    ]);
    expect(cards.map((card) => [card.app, card.title, card.button.label])).toEqual([
      ["CODEXish", "CODEXish", "Allow once"],
      [null, title, "Always allow"],
    ]);
  });

  test("a container's first line that belongs to one prompt never titles the others", () => {
    const { cards } = scanAll([
      new DomNode("div", { role: "alert" }, [
        block("Use Fs Read?", button("Allow once")),
        block("Use Host Capabilities?", button("Always allow")),
      ]),
    ]);
    // Nothing outside the blocks names the app, so nothing is approved.
    expect(cards.map((card) => [card.app, card.button.label])).toEqual([[null, "Always allow"]]);
  });
});

describe("app approval unknown buttons on every path", () => {
  const scanAll = (children: DomNode[]) =>
    scanAppApprovalCards(
      new FakeDocument([new DomNode("main", {}, children)]) as unknown as Document,
      ["CODEXish"],
      APP_APPROVAL_VOCABULARY,
    );

  test.each([[["Continue", "Cancel"]], [["Continue"]], [["OK"]]])(
    "an allowed app's prompt without a role whose buttons are %j is reported once",
    (labels) => {
      const { cards, skipped } = scanAll([
        new DomNode("div", { class: "card" }, [
          new DomNode("p", {}, ["Allow CODEXish to run echo?"]),
          new DomNode(
            "div",
            {},
            labels.map((text) => button(text)),
          ),
        ]),
      ]);
      expect(cards).toEqual([]);
      expect(skipped).toEqual([
        expect.objectContaining({
          reason: "label",
          labels,
          title: "Allow CODEXish to run echo?",
          app: "CODEXish",
        }),
      ]);
    },
  );

  test("prompt-like buttons of a card that names no allowed app, and message actions, are not reported", () => {
    const { skipped } = scanAll([
      new DomNode("div", { class: "card" }, [
        new DomNode("p", {}, ["Delete this chat?"]),
        button("Cancel"),
        button("Continue"),
      ]),
      new DomNode("div", { class: "turn" }, [
        new DomNode("p", {}, ["I ran CODEXish for you."]),
        new DomNode("div", {}, [button("Copy"), button("Good response")]),
      ]),
    ]);
    expect(skipped).toEqual([]);
  });

  test("an unknown button of a prompt next to a taken one in the same alert is reported", () => {
    const { cards, skipped } = scanAll([
      new DomNode("div", { role: "alert" }, [
        new DomNode("div", {}, [
          new DomNode("p", {}, ["Allow CODEXish to use Fs Read?"]),
          button("Always allow"),
        ]),
        new DomNode("div", {}, [
          new DomNode("p", {}, ["Allow CODEXish to use Fs Write?"]),
          button("Approve"),
        ]),
      ]),
    ]);
    expect(cards.map((card) => [card.title, card.button.label])).toEqual([
      ["Allow CODEXish to use Fs Read?", "Always allow"],
    ]);
    expect(skipped).toEqual([
      expect.objectContaining({
        reason: "label",
        labels: ["Approve"],
        title: "Allow CODEXish to use Fs Write?",
        app: "CODEXish",
      }),
    ]);
  });

  test("several unknown buttons of one card, or allow buttons in one excluded row, give one report", () => {
    const { skipped } = scanAll([
      new DomNode("div", { class: "card" }, [
        new DomNode("p", {}, ["Allow CODEXish to run echo?"]),
        button("Approve once"),
        button("Approve always"),
      ]),
      new DomNode("form", { class: "composer" }, [
        new DomNode("div", {}, [button("Allow"), button("Always allow")]),
        composerEditor(),
      ]),
    ]);
    expect(skipped.map((skip) => [skip.reason, skip.labels])).toEqual([
      ["excluded", ["Allow", "Always allow"]],
      ["label", ["Approve once", "Approve always"]],
    ]);
  });
});

describe("app approval monitor reporting", () => {
  const codexishCard = {
    key: "codexish",
    app: "CODEXish",
    title: "Allow CODEXish?",
    toolText: "CODEXish wants to run echo",
    button: { label: "Always allow", rank: 0, index: 0 },
    subject: 0,
  };
  const page = {
    url: "https://chatgpt.com/c/x",
    html: "<div role=alert>…</div>",
    htmlLength: 24,
    ancestors: [{ tag: "div", id: "", className: "", role: "alert", testId: "" }],
    buttons: [{ label: "Continue", text: "Continue", ariaLabel: null, disabled: false }],
  };

  test("reports each skip and each card for another app once, with one diagnostic per card", async () => {
    const scanResult = {
      cards: [
        {
          key: "gmail",
          app: null,
          title: "Allow Gmail?",
          toolText: "Allow Gmail?",
          button: { label: "Allow", rank: 2, index: 0 },
          subject: 0,
        },
      ],
      skipped: [
        {
          reason: "label",
          labels: ["Continue"],
          title: "Allow CODEXish?",
          app: "CODEXish",
          detail: "",
          subject: 1,
        },
        {
          reason: "excluded",
          labels: ["Allow"],
          title: "",
          app: null,
          detail: "form.relative",
          subject: 2,
        },
      ],
    };
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("window.__oracleApprovalButtons = {")) {
          return { result: { value: scanResult } };
        }
        if (expression.includes("store.subjects")) return { result: { value: page } };
        return { result: { value: null } };
      }),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });
    const saveDiagnostic = vi.fn(async () => "C:/sessions/s/artifacts/app-approval-diag-1.html");
    const stop = startAppApprovalMonitor(runtime as never, undefined, {
      allowApps: ["CODEXish"],
      logger,
      intervalMs: 250,
      saveDiagnostic,
    });
    await vi.waitFor(
      () =>
        expect(
          runtime.evaluate.mock.calls.filter(([call]) =>
            call.expression.includes("window.__oracleApprovalButtons = {"),
          ).length,
        ).toBeGreaterThanOrEqual(4),
      { timeout: 5_000 },
    );
    await stop();
    const lines = logger.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes('no known allow label among "Continue"'))).toEqual([
      '[browser] App approval left for the user: no known allow label among "Continue" in "Allow CODEXish?".',
    ]);
    expect(lines.filter((line) => line.includes("sits inside form.relative"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('"Allow Gmail?" left for the user'))).toHaveLength(
      1,
    );
    expect(saveDiagnostic).toHaveBeenCalledTimes(3);
    expect(saveDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('no known allow label among "Continue"'),
        page,
      }),
    );
    expect(lines.filter((line) => line.includes("diagnostic saved"))).toHaveLength(3);
  });

  // A mock page whose guard arms on demand: `arm()` says whether the button is still in place
  // when the click is armed, `reached` whether the trusted click reaches it, `inPage` what the
  // in-page click finds.
  const clickPage = (state: { arm: () => boolean; reached?: boolean; inPage?: string }) => {
    const order: string[] = [];
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("window.__oracleApprovalButtons = {")) {
          return { result: { value: { cards: [codexishCard], skipped: [] } } };
        }
        if (expression.includes("scrollIntoView({ block: 'end'")) {
          order.push("scroll-end");
          return { result: { value: true } };
        }
        if (expression.includes("target.click()")) {
          order.push("in-page");
          return { result: { value: { status: state.inPage ?? "missing" } } };
        }
        if (expression.includes("store.subjects")) return { result: { value: page } };
        if (expression.includes("__oracleTrustedClickGuards ??=")) {
          order.push("arm");
          return {
            result: {
              value: state.arm() ? { ready: true, contextMatches: true } : { ready: false },
            },
          };
        }
        if (expression.includes("const summary = { reached")) {
          return { result: { value: { reached: state.reached ?? false, blocked: null } } };
        }
        if (expression.includes("'settling'")) {
          return { result: { value: { status: "ready", x: 50, y: 60 } } };
        }
        return { result: { value: null } };
      }),
    };
    return { runtime, order };
  };

  test("a click that does not happen is logged with its status, when it changes and every 10 attempts", async () => {
    let reachable = false;
    const { runtime } = clickPage({ arm: () => reachable });
    const logger = Object.assign(vi.fn(), { verbose: false });
    const lines = () => logger.mock.calls.map(([line]) => String(line));
    const saveDiagnostic = vi.fn(async () => undefined);
    const onApproval = vi.fn();
    const stop = startAppApprovalMonitor(
      runtime as never,
      { dispatchMouseEvent: vi.fn() } as never,
      { allowApps: ["CODEXish"], logger, intervalMs: 250, saveDiagnostic, onApproval },
    );
    try {
      await vi.waitFor(
        () => expect(lines().some((line) => line.includes("attempt 10)"))).toBe(true),
        {
          timeout: 30_000,
        },
      );
      // From now on the button holds still but the click never reaches it.
      reachable = true;
      await vi.waitFor(
        () => expect(lines().some((line) => line.includes("(unreached"))).toBe(true),
        {
          timeout: 10_000,
        },
      );
    } finally {
      await stop();
    }
    const failures = lines().filter((line) => line.includes("click did not happen ("));
    expect(failures.slice(0, 2)).toEqual([
      '[browser] App approval for CODEXish: the "Always allow" click did not happen (obscured: target moved before the click; attempt 1); will retry.',
      '[browser] App approval for CODEXish: the "Always allow" click did not happen (obscured: target moved before the click; attempt 10); will retry.',
    ]);
    expect(failures[2]).toMatch(
      /^\[browser\] App approval for CODEXish: the "Always allow" click did not happen \(unreached: the click did not reach the target; attempt 1\d\); will retry\.$/,
    );
    expect(failures).toHaveLength(3);
    expect(
      lines()
        .filter((line) => line.includes('clicks on "Always allow" did not happen'))
        .slice(0, 3),
    ).toEqual([
      '[browser] App approval for CODEXish: 3 clicks on "Always allow" did not happen; scrolling the card to the end of the view for one more.',
      '[browser] App approval for CODEXish: 6 clicks on "Always allow" did not happen; scrolling the card to the end of the view for one more.',
      '[browser] App approval for CODEXish: 9 clicks on "Always allow" did not happen; scrolling the card to the end of the view for one more.',
    ]);
    expect(saveDiagnostic).toHaveBeenCalledTimes(1);
    expect(onApproval).not.toHaveBeenCalled();
  }, 60_000);

  test("after three misses the card goes to the end of the view, then the verified button is clicked in the page", async () => {
    const { runtime, order } = clickPage({ arm: () => false, inPage: "clicked" });
    const logger = Object.assign(vi.fn(), { verbose: false });
    const onApproval = vi.fn();
    const stop = startAppApprovalMonitor(
      runtime as never,
      { dispatchMouseEvent: vi.fn() } as never,
      { allowApps: ["CODEXish"], logger, intervalMs: 250, onApproval },
    );
    try {
      await vi.waitFor(() => expect(onApproval).toHaveBeenCalled(), { timeout: 20_000 });
    } finally {
      await stop();
    }
    expect(order.slice(0, 6)).toEqual(["arm", "arm", "arm", "scroll-end", "arm", "in-page"]);
    // The retry after the scroll keeps the card at the end instead of centring it again.
    expect(
      runtime.evaluate.mock.calls.some(
        ([call]) =>
          call.expression.includes("'settling'") && call.expression.includes('block: "end"'),
      ),
    ).toBe(true);
    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({ app: "CODEXish", button: "Always allow", method: "in-page-click" }),
    );
    const lines = logger.mock.calls.map(([line]) => String(line));
    expect(
      lines.some((line) => line.includes('approved ("Always allow") by in-page click() at')),
    ).toBe(true);
  }, 30_000);

  test("a trusted click that lands after the scroll to the end is recorded as one", async () => {
    let arms = 0;
    const { runtime, order } = clickPage({ arm: () => ++arms > 3, reached: true });
    const logger = Object.assign(vi.fn(), { verbose: false });
    const onApproval = vi.fn();
    const stop = startAppApprovalMonitor(
      runtime as never,
      { dispatchMouseEvent: vi.fn() } as never,
      { allowApps: ["CODEXish"], logger, intervalMs: 250, onApproval },
    );
    try {
      await vi.waitFor(() => expect(onApproval).toHaveBeenCalled(), { timeout: 20_000 });
    } finally {
      await stop();
    }
    expect(order).not.toContain("in-page");
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ method: "trusted-click" }));
    const lines = logger.mock.calls.map(([line]) => String(line));
    expect(
      lines.some((line) =>
        line.includes('approved ("Always allow") by trusted click after scrolling to the end at'),
      ),
    ).toBe(true);
  }, 30_000);

  test("a page scan that throws is reported once and the watch goes on", async () => {
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: { type: "object", subtype: "error" },
        exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } },
      })),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });
    const stop = startAppApprovalMonitor(runtime as never, undefined, {
      allowApps: ["CODEXish"],
      logger,
      intervalMs: 250,
    });
    await vi.waitFor(() => expect(runtime.evaluate.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 5_000,
    });
    await stop();
    expect(logger.mock.calls.map(([line]) => String(line))).toEqual([
      "[browser] App approval check failed (will keep watching): the page scan threw: TypeError: boom",
    ]);
  });
});

describe("app approval monitor", () => {
  test("approves allowed cards, records them, and logs other cards once", async () => {
    const cards = [
      {
        key: "codexish",
        app: "CODEXish",
        toolText: "CODEXish wants to run echo",
        button: { label: "Always allow", rank: 0, index: 0 },
      },
      {
        key: "gmail",
        app: null,
        toolText: "Allow Gmail to send an email?",
        button: { label: "Allow", rank: 2, index: 1 },
      },
    ];
    let approved = false;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("window.__oracleApprovalButtons = {")) {
          return { result: { value: approved ? cards.slice(1) : cards } };
        }
        if (expression.includes("__oracleTrustedClickGuards ??=")) {
          return { result: { value: { ready: true, contextMatches: true } } };
        }
        if (expression.includes("const summary = { reached")) {
          approved = true;
          return { result: { value: { reached: true, blocked: null } } };
        }
        return { result: { value: { status: "ready", x: 50, y: 60 } } };
      }),
    };
    const input = { dispatchMouseEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });
    const onApproval = vi.fn();
    const stop = startAppApprovalMonitor(runtime as never, input as never, {
      allowApps: ["CODEXish"],
      logger,
      intervalMs: 250,
      onApproval,
    });
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await stop();
    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        app: "CODEXish",
        button: "Always allow",
        toolText: "CODEXish wants to run echo",
      }),
    );
    expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    const leftForUser = logger.mock.calls.filter(([line]) =>
      String(line).includes("left for the user"),
    );
    expect(leftForUser).toHaveLength(1);
  });

  test("records nothing when the click never reached the button", async () => {
    const card = {
      key: "codexish",
      app: "CODEXish",
      title: "Allow CODEXish?",
      toolText: "CODEXish wants to run echo",
      button: { label: "Always allow", rank: 0, index: 0 },
    };
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("window.__oracleApprovalButtons = {")) {
          return { result: { value: [card] } };
        }
        if (expression.includes("__oracleTrustedClickGuards ??=")) {
          return { result: { value: { ready: true, contextMatches: true } } };
        }
        if (expression.includes("const summary = { reached")) {
          return { result: { value: { reached: false, blocked: null } } };
        }
        return { result: { value: { status: "ready", x: 50, y: 60 } } };
      }),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });
    const onApproval = vi.fn();
    const stop = startAppApprovalMonitor(
      runtime as never,
      { dispatchMouseEvent: vi.fn() } as never,
      { allowApps: ["CODEXish"], logger, intervalMs: 250, onApproval },
    );
    await vi.waitFor(
      () =>
        expect(
          runtime.evaluate.mock.calls.filter(([call]) => call.expression.includes("const summary")),
        ).not.toHaveLength(0),
      { timeout: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stop();
    expect(onApproval).not.toHaveBeenCalled();
    expect(logger.mock.calls.some(([line]) => String(line).includes("approved ("))).toBe(false);
  });

  test("does nothing when no app is allowed", async () => {
    const runtime = { evaluate: vi.fn() };
    const stop = startAppApprovalMonitor(runtime as never, undefined, {
      allowApps: [" "],
      logger: Object.assign(vi.fn(), { verbose: false }),
    });
    await stop();
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });
});
