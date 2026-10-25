import { describe, expect, test, vi } from "vitest";
import {
  ARCHIVE_LABELS,
  archiveChatGptConversation,
  conversationIdFromUrl,
  findArchiveMenuItem,
  findConversationRowMenuButton,
  findHeaderConversationMenuButton,
  findMenuForTrigger,
  isProjectChatgptUrl,
  isTemporaryChatgptUrl,
  menuOffersUnarchive,
  readArchiveSignals,
  resolveBrowserArchiveDecision,
} from "../../src/browser/actions/archiveConversation.js";
import { DomNode, FakeDocument, FakeElement } from "./domFixture.js";

describe("browser conversation archive policy", () => {
  test("archives successful non-project one-shots in auto mode", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "off",
        followUpCount: 0,
      }),
    ).toMatchObject({
      mode: "auto",
      shouldArchive: true,
      reason: "successful-one-shot",
    });
  });

  test("does not auto-archive project, Temporary Chat, Deep Research, multi-turn, or missing-url runs", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "project-conversation" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "project-conversation" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
        conversationUrl: "https://chatgpt.com/?temporary-chat=true",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "temporary-chat" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "deep-research" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 1,
      }),
    ).toMatchObject({ shouldArchive: false, reason: "multi-turn" });
    expect(resolveBrowserArchiveDecision({ mode: "auto" })).toMatchObject({
      shouldArchive: false,
      reason: "missing-conversation-url",
    });
  });

  test("honors explicit always and never modes", () => {
    expect(resolveBrowserArchiveDecision({ mode: "never", conversationUrl: "x" })).toMatchObject({
      shouldArchive: false,
      reason: "disabled",
    });
    expect(
      resolveBrowserArchiveDecision({
        mode: "always",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
        followUpCount: 2,
      }),
    ).toMatchObject({ shouldArchive: true, reason: "forced" });
  });

  test("detects ChatGPT project URLs", () => {
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project?model=gpt-5")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });

  test("detects ChatGPT temporary chat URLs", () => {
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=true")).toBe(true);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=false")).toBe(false);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });
});

describe("archiveChatGptConversation", () => {
  test("a failure is reported as not archived, never thrown", async () => {
    const runtime = { evaluate: vi.fn().mockRejectedValue(new Error("target closed")) };
    const logger = vi.fn();
    await expect(
      archiveChatGptConversation(runtime as never, logger as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: true,
      archived: false,
      reason: "archive-failed",
      error: "target closed",
      conversationUrl: "https://chatgpt.com/c/abc",
    });
    expect(logger).toHaveBeenCalledWith("[browser] ChatGPT archive skipped (target closed).");
  });

  test("without the run's own conversation id nothing is clicked", async () => {
    // The open page is a conversation, but the run's id is unknown: it may not be ours.
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValue({ result: { value: "https://chatgpt.com/c/someone-else" } }),
    };
    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: null,
      }),
    ).resolves.toMatchObject({ archived: false, reason: "missing-conversation-url" });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });
});

// Today's sidebar row (2026-10): a role="group" row inside a role="list", the chat link, and a
// hover-revealed "Chat actions" menu button next to "Pin chat".
const row = (id: string, buttons: FakeElement[] = [chatActions(id)]) =>
  new FakeElement("div", { role: "listitem" }, [
    new FakeElement("div", { role: "group", "aria-label": `Chat ${id}` }, [
      new FakeElement("div", {}, [new FakeElement("a", { href: `/c/${id}` }, [], `Chat ${id}`)]),
      new FakeElement("div", {}, buttons),
    ]),
  ]);
const chatActions = (id: string, label = "Chat actions") =>
  new FakeElement("button", {
    id: `trigger-${id}`,
    "aria-label": label,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
  });
const sidebar = (...rows: FakeElement[]) =>
  new FakeElement("nav", {}, [new FakeElement("div", { role: "list" }, rows)]);
const menu = (labels: string[], attrs: Record<string, string> = {}) =>
  new FakeElement(
    "div",
    { role: "menu", ...attrs },
    labels.map((label) => new FakeElement("div", { role: "menuitem" }, [], label)),
  );
const doc = (...children: FakeElement[]) => new FakeDocument(children) as unknown as Document;
const el = (node: FakeElement) => node as unknown as Element;

describe("archive locators", () => {
  test("reads the conversation id from ChatGPT URLs and paths", () => {
    expect(conversationIdFromUrl("https://chatgpt.com/c/6add23d8-3344?x=1")).toBe("6add23d8-3344");
    expect(conversationIdFromUrl("https://chatgpt.com/g/g-p-demo/project/c/abc#top")).toBe("abc");
    expect(conversationIdFromUrl("/c/abc")).toBe("abc");
    expect(conversationIdFromUrl("https://chatgpt.com/")).toBeNull();
    expect(conversationIdFromUrl(undefined)).toBeNull();
  });

  test("finds this chat's own row menu button, never another row's", () => {
    const page = doc(sidebar(row("bbb"), row("aaa"), row("ccc")));
    const found = findConversationRowMenuButton(page, "aaa", ARCHIVE_LABELS.rowMenuButton);
    expect(found?.getAttribute("id")).toBe("trigger-aaa");
    expect(findConversationRowMenuButton(page, "zzz", ARCHIVE_LABELS.rowMenuButton)).toBeNull();
  });

  test("a row without its own menu button does not borrow a neighbour's", () => {
    const page = doc(sidebar(row("bbb"), row("aaa", []), row("ccc")));
    expect(findConversationRowMenuButton(page, "aaa", ARCHIVE_LABELS.rowMenuButton)).toBeNull();
  });

  test("a row's only menu button counts whatever its label, a labelled one wins over others", () => {
    const unlabelled = doc(sidebar(row("aaa", [chatActions("aaa", "채팅 작업")])));
    expect(
      findConversationRowMenuButton(unlabelled, "aaa", ARCHIVE_LABELS.rowMenuButton)?.getAttribute(
        "id",
      ),
    ).toBe("trigger-aaa");
    const share = new FakeElement("button", {
      id: "share-aaa",
      "aria-label": "Share",
      "aria-haspopup": "menu",
    });
    const two = doc(sidebar(row("aaa", [share, chatActions("aaa")])));
    expect(
      findConversationRowMenuButton(two, "aaa", ARCHIVE_LABELS.rowMenuButton)?.getAttribute("id"),
    ).toBe("trigger-aaa");
  });

  test("the header menu button is only one in the header position, never in the sidebar", () => {
    const at = (attrs: Record<string, string>, rect: { top: number; right: number }) =>
      Object.assign(new FakeElement("button", attrs), {
        getBoundingClientRect: () => ({ width: 20, height: 20, ...rect }),
      });
    const more = at({ id: "more", "aria-label": "More" }, { top: 8, right: 1170 });
    const page = doc(
      sidebar(row("aaa", [chatActions("aaa", "More")])),
      new FakeElement("header", {}, [more]),
    );
    expect(
      findHeaderConversationMenuButton(page, ARCHIVE_LABELS.headerMenuButton)?.getAttribute("id"),
    ).toBe("more");
    expect(
      findHeaderConversationMenuButton(
        doc(sidebar(row("aaa", [chatActions("aaa", "More")]))),
        ARCHIVE_LABELS.headerMenuButton,
      ),
    ).toBeNull();
    // A matching button anywhere else (here: a drawer row far below the header) is not used.
    const elsewhere = at(
      { id: "drawer-more", "aria-label": "More options" },
      { top: 600, right: 900 },
    );
    expect(
      findHeaderConversationMenuButton(
        doc(new FakeElement("div", {}, [elsewhere])),
        ARCHIVE_LABELS.headerMenuButton,
      ),
    ).toBeNull();
  });

  test("reads only the menu linked to the trigger", () => {
    const trigger = chatActions("aaa");
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", "menu-a");
    const other = menu(["Pin", "Archive"], { id: "menu-b", "aria-labelledby": "trigger-bbb" });
    const own = menu(["Rename", "Archive"], { id: "menu-a" });
    expect(findMenuForTrigger(doc(sidebar(row("aaa")), other, own), el(trigger))).toBe(el(own));
    expect(findMenuForTrigger(doc(other), el(trigger))).toBeNull();
    // A closed trigger never adopts an unrelated open menu.
    expect(findMenuForTrigger(doc(other), el(chatActions("aaa")))).toBeNull();
    // Menus without link attributes: only while the trigger reads expanded.
    const bare = new FakeElement("button", { "aria-haspopup": "menu" });
    const lone = menu(["Archive"]);
    expect(findMenuForTrigger(doc(lone), el(bare))).toBeNull();
    bare.setAttribute("aria-expanded", "true");
    expect(findMenuForTrigger(doc(lone), el(bare))).toBe(el(lone));
  });

  test("never uses a menu linked to another trigger or one that was open before our click", () => {
    // A trigger without link attributes that reads expanded.
    const bare = new FakeElement("button", { "aria-haspopup": "menu", "aria-expanded": "true" });
    const othersMenu = menu(["Rename", "Archive"], { "aria-labelledby": "radix-other" });
    expect(findMenuForTrigger(doc(othersMenu), el(bare))).toBeNull();
    const lone = menu(["Archive"]);
    expect(findMenuForTrigger(doc(lone), el(bare), new Set([el(lone)]))).toBeNull();
    // Even a linked menu that was already open is not adopted.
    const trigger = chatActions("aaa");
    const linked = menu(["Archive"], { "aria-labelledby": "trigger-aaa" });
    expect(findMenuForTrigger(doc(linked), el(trigger), new Set([el(linked)]))).toBeNull();
    expect(findMenuForTrigger(doc(linked), el(trigger), new Set())).toBe(el(linked));
  });

  test("picks Archive, never Delete, Unarchive or Restore", () => {
    const today = menu(["Rename", "Pin", "Share", "Archive", "Delete", "Move to project"]);
    expect(findArchiveMenuItem(el(today), ARCHIVE_LABELS)?.textContent).toBe("Archive");
    expect(
      findArchiveMenuItem(el(menu(["Pin", "Plugins", "View files in chat"])), ARCHIVE_LABELS),
    ).toBeNull();
    expect(findArchiveMenuItem(el(menu(["Unarchive", "Delete"])), ARCHIVE_LABELS)).toBeNull();
    expect(findArchiveMenuItem(el(menu(["Restore chat", "Delete"])), ARCHIVE_LABELS)).toBeNull();
    expect(
      findArchiveMenuItem(el(menu(["삭제", "아카이브에 보관"])), ARCHIVE_LABELS)?.textContent,
    ).toBe("아카이브에 보관");
    expect(findArchiveMenuItem(el(menu(["보관 해제", "삭제"])), ARCHIVE_LABELS)).toBeNull();
    expect(menuOffersUnarchive(el(menu(["Unarchive"])), ARCHIVE_LABELS)).toBe(true);
    expect(menuOffersUnarchive(el(today), ARCHIVE_LABELS)).toBe(false);
  });

  test("no label list can select Delete", () => {
    const all = Object.values(ARCHIVE_LABELS).flat();
    expect(all.some((label) => "delete".includes(label) || label.includes("delete"))).toBe(false);
  });

  test("archive signals: the row, the open page and toasts", () => {
    const page = doc(
      sidebar(row("aaa")),
      new FakeElement("div", { role: "status" }, [], "Chat archived"),
    );
    expect(readArchiveSignals(page, "aaa", ARCHIVE_LABELS)).toMatchObject({
      rowPresent: true,
      toast: true,
    });
    expect(readArchiveSignals(doc(sidebar(row("bbb"))), "aaa", ARCHIVE_LABELS)).toMatchObject({
      rowPresent: false,
      toast: false,
    });
  });
});

// Every label kept from earlier UIs, one per literal, checked in the list that consumes it, so a
// change that drops or renames one fails here instead of in a live run (history: #407/#405).
describe("archive locale label inventory", () => {
  test("conversation menu ('more options') labels are present", () => {
    for (const label of [
      "more",
      "conversation options",
      "open menu",
      "więcej",
      "opcje",
      "その他",
      "会話オプション",
    ]) {
      expect(ARCHIVE_LABELS.headerMenuButton).toContain(label);
    }
  });

  test("archive menu-item labels are present", () => {
    for (const label of ["archive", "archiwizuj", "アーカイブ", "アーカイブする"]) {
      expect(ARCHIVE_LABELS.archiveItem).toContain(label);
    }
  });

  test("archive confirmation-button labels are present", () => {
    for (const label of ["archive", "archiwizuj", "アーカイブ"]) {
      expect(ARCHIVE_LABELS.confirmButtonExact).toContain(label);
    }
    for (const label of ["archive conversation", "アーカイブする"]) {
      expect(ARCHIVE_LABELS.confirmButtonContains).toContain(label);
    }
  });

  test("unarchive/restore exclusion labels are present", () => {
    for (const label of ["unarchive", "restore", "アーカイブを解除", "przywróć", "przywroc"]) {
      expect(ARCHIVE_LABELS.unarchive).toContain(label);
    }
  });

  test("post-archive confirmation toast labels are present", () => {
    for (const label of [
      "archived",
      "conversation archived",
      "chat archived",
      "zarchiwizowano",
      "archiwum",
      "アーカイブしました",
      "アーカイブされました",
    ]) {
      expect(ARCHIVE_LABELS.toast).toContain(label);
    }
  });
});

describe("archive confirmation ownership", () => {
  type Part = DomNode | string;
  const dialog = (...text: Part[]) =>
    new DomNode("div", { role: "dialog" }, [
      new DomNode("p", {}, text),
      new DomNode("div", {}, [new DomNode("button", {}, ["Archive"])]),
    ]);
  const strong = (name: string) => new DomNode("strong", {}, [name]);
  const confirmOf = (node: DomNode) => node.children[1].children[0];
  const page = (titles: Record<string, string>, ...dialogs: DomNode[]) =>
    new FakeDocument([
      new DomNode(
        "nav",
        {},
        Object.entries(titles).map(
          ([id, title]) => new DomNode("a", { href: `/c/${id}` }, [title]),
        ),
      ),
      ...dialogs,
    ]);
  const TITLES = { aaa: "Trip planning", bbb: "Budget review" };
  const inspect = async (doc: FakeDocument, before: DomNode[] = []) => {
    const { inspectArchiveConfirm, ARCHIVE_LABELS } =
      await import("../../src/browser/actions/archiveConversation.js");
    return inspectArchiveConfirm(doc as unknown as Document, ARCHIVE_LABELS, {
      before: new WeakSet(before as unknown as Element[]),
      conversationId: "aaa",
    });
  };

  test("only a dialog that appeared after our click, naming our chat or none, is ours", async () => {
    const ours = dialog("This will archive ", strong("Trip planning"), ".");
    expect((await inspect(page(TITLES, ours))).button).toBe(confirmOf(ours));
    const unnamed = dialog("Archive this chat?");
    expect((await inspect(page(TITLES, unnamed))).button).toBe(confirmOf(unnamed));
    const old = dialog("Archive this chat?");
    expect(await inspect(page(TITLES, old), [old])).toEqual({ button: null, ambiguous: null });
  });

  test("another chat's confirmation, or two new ones, are ambiguous and nothing is chosen", async () => {
    await expect(
      inspect(page(TITLES, dialog("This will archive ", strong("Budget review"), "."))),
    ).resolves.toEqual({
      button: null,
      ambiguous: 'the confirmation names another chat ("budget review")',
    });
    await expect(
      inspect(page(TITLES, dialog("This will archive “Budget review”."))),
    ).resolves.toMatchObject({ button: null, ambiguous: expect.stringContaining("budget review") });
    await expect(
      inspect(page(TITLES, dialog("Archive this chat?"), dialog("Archive this chat?"))),
    ).resolves.toEqual({ button: null, ambiguous: "2 new confirmation dialogs are open" });
  });

  test("a chat name counts only as a whole name, never as part of other text", async () => {
    const titles = { aaa: "Plan", bbb: "Plan review" };
    // Our chat "Plan" is part of the other chat's name: that confirmation is not ours.
    await expect(
      inspect(page(titles, dialog("This will archive ", strong("Plan review"), "."))),
    ).resolves.toEqual({
      button: null,
      ambiguous: 'the confirmation names another chat ("plan review")',
    });
    const ours = dialog("This will archive ", strong("Plan"), ".");
    expect((await inspect(page(titles, ours))).button).toBe(confirmOf(ours));
    // A name that only appears inside a sentence names no chat; the dialog is ours by appearing
    // after our click.
    const prose = dialog("This will archive Plan review.");
    expect((await inspect(page(titles, prose))).button).toBe(confirmOf(prose));
  });

  test("button labels never name a chat, so a chat titled Archive leaves a generic confirmation ours", async () => {
    const generic = dialog("Archive this chat?");
    await expect(inspect(page({ aaa: "Trip planning", bbb: "Archive" }, generic))).resolves.toEqual(
      { button: confirmOf(generic), ambiguous: null },
    );
  });
});
