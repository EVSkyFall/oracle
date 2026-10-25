import { describe, expect, test, vi } from "vitest";
import {
  APP_APPROVAL_ALLOW_LABELS,
  buildAppApprovalLocate,
  scanAppApprovalCards,
  startAppApprovalMonitor,
} from "../../src/browser/actions/appApprovals.js";
import { DomNode, FakeDocument } from "./domFixture.js";

const button = (label: string) => new DomNode("button", {}, [label]);
const scan = (children: DomNode[], allowApps = ["CODEXish"]) =>
  scanAppApprovalCards(
    new FakeDocument(children) as unknown as Document,
    allowApps,
    APP_APPROVAL_ALLOW_LABELS,
  ).cards;

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
        new DomNode("main", {}, [new DomNode("form", { "data-chatgpt-composer": "" }, [card])]),
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
