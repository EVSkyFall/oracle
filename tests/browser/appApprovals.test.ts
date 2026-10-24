import { describe, expect, test, vi } from "vitest";
import {
  APP_APPROVAL_ALLOW_LABELS,
  scanAppApprovalCards,
  startAppApprovalMonitor,
} from "../../src/browser/actions/appApprovals.js";
import { FakeDocument, FakeElement } from "./domFixture.js";

/** FakeElement with text nodes, enough for the scanner's text walk. */
class DomNode extends FakeElement {
  nodeType = 1;
  constructor(
    tag: string,
    attrs: Record<string, string> = {},
    readonly nodes: Array<DomNode | string> = [],
  ) {
    super(
      tag,
      attrs,
      nodes.filter((node): node is DomNode => typeof node !== "string"),
    );
  }
  get childNodes(): Array<DomNode | { nodeType: number; nodeValue: string }> {
    return this.nodes.map((node) =>
      typeof node === "string" ? { nodeType: 3, nodeValue: node } : node,
    );
  }
  override get textContent(): string {
    return this.nodes.map((node) => (typeof node === "string" ? node : node.textContent)).join("");
  }
}

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
      new DomNode("div", {}, [
        new DomNode("span", {}, ["Use CODEXish?"]),
        button("Allow"),
        button(" Always  allow "),
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
      new DomNode("div", {}, [
        new DomNode("p", {}, ["Allow CODEXishPro to run?"]),
        button("Allow"),
      ]),
    ]);
    expect(lookAlike?.app).toBeNull();
    const [allowed] = scan(
      [new DomNode("div", {}, [new DomNode("p", {}, ["Allow codexish to run?"]), button("Allow")])],
      ["CODEXish"],
    );
    expect(allowed?.app).toBe("CODEXish");
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
