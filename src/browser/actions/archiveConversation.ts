import type {
  BrowserArchiveMode,
  BrowserArchiveResult,
  BrowserLogger,
  BrowserResearchMode,
  ChromeClient,
} from "../types.js";
import { delay } from "../utils.js";
import { guardedTrustedClick } from "./composerTools.js";

export interface BrowserArchiveDecision {
  mode: BrowserArchiveMode;
  shouldArchive: boolean;
  reason: string;
}

export function isProjectChatgptUrl(url?: string | null): boolean {
  return /\/project(?:[/?#]|$)/i.test(url ?? "");
}

export function isTemporaryChatgptUrl(url?: string | null): boolean {
  try {
    const parsed = new URL(url ?? "");
    return (parsed.searchParams.get("temporary-chat") ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function resolveBrowserArchiveDecision({
  mode = "auto",
  chatgptUrl,
  conversationUrl,
  researchMode,
  followUpCount,
}: {
  mode?: BrowserArchiveMode;
  chatgptUrl?: string | null;
  conversationUrl?: string | null;
  researchMode?: BrowserResearchMode;
  followUpCount?: number;
}): BrowserArchiveDecision {
  if (mode === "never") {
    return { mode, shouldArchive: false, reason: "disabled" };
  }
  if (!conversationUrl) {
    return { mode, shouldArchive: false, reason: "missing-conversation-url" };
  }
  if (isTemporaryChatgptUrl(chatgptUrl) || isTemporaryChatgptUrl(conversationUrl)) {
    return { mode, shouldArchive: false, reason: "temporary-chat" };
  }
  if (mode === "always") {
    return { mode, shouldArchive: true, reason: "forced" };
  }
  if (isProjectChatgptUrl(chatgptUrl) || isProjectChatgptUrl(conversationUrl)) {
    return { mode, shouldArchive: false, reason: "project-conversation" };
  }
  if (researchMode === "deep") {
    return { mode, shouldArchive: false, reason: "deep-research" };
  }
  if ((followUpCount ?? 0) > 0) {
    return { mode, shouldArchive: false, reason: "multi-turn" };
  }
  return { mode, shouldArchive: true, reason: "successful-one-shot" };
}

/**
 * Labels the archive flow matches, lower-case. Matching is by substring after the exclusions, so
 * "unarchive" style labels are listed in `unarchive` and checked first. Today's English UI uses
 * "Chat actions" (sidebar row) and "Archive"; the other locales are kept from earlier UIs.
 */
export const ARCHIVE_LABELS = {
  /** The conversation's own menu in the page header (earlier UIs). */
  headerMenuButton: [
    "more",
    "conversation options",
    "open menu",
    "więcej",
    "opcje",
    "その他",
    "会話オプション",
  ],
  /** The menu button on the conversation's sidebar row; the row's only menu button also counts. */
  rowMenuButton: ["chat actions", "conversation actions", "options", "more", "menu"],
  archiveItem: [
    "archive",
    "archiv",
    "archiwizuj",
    "arquivar",
    "アーカイブ",
    "アーカイブする",
    "보관",
    "아카이브",
    "归档",
    "封存",
    "архив",
  ],
  unarchive: [
    "unarchive",
    "restore",
    "przywróć",
    "przywroc",
    "desarchiv",
    "désarchiv",
    "dearchiv",
    "aus dem archiv",
    "アーカイブを解除",
    "보관 해제",
    "보관 취소",
    "아카이브 해제",
    "복원",
    "取消归档",
    "取消封存",
    "разархив",
    "восстанов",
  ],
  /** Confirmation-dialog buttons, matched exactly. */
  confirmButtonExact: [
    "archive",
    "archiwizuj",
    "アーカイブ",
    "archivieren",
    "archiver",
    "archivar",
    "arquivar",
    "보관",
    "보관하기",
    "归档",
    "封存",
    "архивировать",
  ],
  /** Confirmation-dialog buttons, matched by substring. */
  confirmButtonContains: ["archive conversation", "archive chat", "アーカイブする"],
  /** Toasts that report the archive. */
  toast: [
    "archived",
    "conversation archived",
    "chat archived",
    "zarchiwizowano",
    "archiwum",
    "archiviert",
    "archivé",
    "archivad",
    "arquivad",
    "アーカイブしました",
    "アーカイブされました",
    "보관됨",
    "보관되었",
    "보관했",
    "已归档",
    "已封存",
    "архивирован",
  ],
} as const;

type ArchiveLabelSet = { [K in keyof typeof ARCHIVE_LABELS]: readonly string[] };

/** Page function: the id in a ChatGPT conversation URL or path (`/c/<id>`), or null. */
export function conversationIdFromUrl(url: string | null | undefined): string | null {
  const match = /\/c\/([^/?#]+)/.exec(String(url ?? ""));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Page function: the menu button on one conversation's sidebar row. The row is the nearest
 * ancestor of that conversation's link that holds a menu button, below any list or navigation
 * container and holding no other conversation's link, so another chat's menu is never used.
 */
export function findConversationRowMenuButton(
  doc: Document,
  conversationId: string,
  labels: readonly string[],
): Element | null {
  const idOf = (href: string | null) => {
    const match = /\/c\/([^/?#]+)/.exec(String(href ?? ""));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const labelOf = (node: Element) =>
    String(node.getAttribute("aria-label") ?? node.getAttribute("title") ?? node.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const containerSelector =
    'nav, aside, header, main, body, ul, ol, [role="list"], [role="navigation"], [role="menu"]';
  const menuButtonSelector = 'button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]';
  const links = Array.from(doc.querySelectorAll("a[href]")).filter(
    (link) => idOf(link.getAttribute("href")) === conversationId,
  );
  // Sidebar links first.
  links.sort(
    (a, b) => Number(Boolean(b.closest("nav, aside"))) - Number(Boolean(a.closest("nav, aside"))),
  );
  for (const link of links) {
    let row: Element | null = null;
    for (let node = link.parentElement; node; node = node.parentElement) {
      if (node.matches(containerSelector)) break;
      const holdsOther = Array.from(node.querySelectorAll("a[href]")).some((other) => {
        const id = idOf(other.getAttribute("href"));
        return id !== null && id !== conversationId;
      });
      if (holdsOther) break;
      if (node.querySelector(menuButtonSelector)) {
        row = node;
        break;
      }
    }
    if (!row) continue;
    const buttons = Array.from(row.querySelectorAll(menuButtonSelector)).filter(visible);
    const labelled = buttons.find((button) => {
      const label = labelOf(button);
      return labels.some((entry) => label.includes(entry));
    });
    const button = labelled ?? (buttons.length === 1 ? buttons[0] : null);
    if (button) return button;
  }
  return null;
}

/**
 * Page function: the conversation menu button in the page header (earlier UIs), never one inside
 * the sidebar list, where it would belong to another chat.
 */
export function findHeaderConversationMenuButton(
  doc: Document,
  labels: readonly string[],
): Element | null {
  const labelOf = (node: Element) =>
    String(
      [node.getAttribute("aria-label"), node.getAttribute("title"), node.textContent]
        .filter(Boolean)
        .join(" "),
    )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const width = doc.defaultView?.innerWidth ?? 0;
  const candidates = Array.from(doc.querySelectorAll('button, [role="button"]'))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      if (node.closest('nav, aside, ul, ol, [role="list"], [role="listitem"], [role="menu"]'))
        return false;
      const label = labelOf(node);
      return labels.some((entry) => label.includes(entry));
    })
    .map((node) => ({ node, rect: node.getBoundingClientRect() }));
  // Header position only: a matching button elsewhere may belong to anything.
  const header = candidates
    .filter(({ rect }) => rect.top < 180 && rect.right > width - 420)
    .sort((a, b) => b.rect.right - a.rect.right);
  return header[0]?.node ?? null;
}

/**
 * Page function: the open menu that belongs to `trigger`: linked to it (`aria-controls`, or
 * `aria-labelledby` = its id), or, without link attributes, the only unlinked menu while the
 * trigger reads expanded. A menu linked to another trigger, or one in `openBefore` (open before
 * our click), is never used.
 */
export function findMenuForTrigger(
  doc: Document,
  trigger: Element | null,
  openBefore?: { has(menu: Element): boolean } | null,
): Element | null {
  if (!trigger) return null;
  const menus = Array.from(doc.querySelectorAll('[role="menu"]')).filter((menu) => {
    const rect = menu.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !openBefore?.has(menu);
  });
  const controls = trigger.getAttribute("aria-controls");
  const id = trigger.getAttribute("id");
  const linked = menus.find(
    (menu) =>
      (controls && menu.getAttribute("id") === controls) ||
      (id && menu.getAttribute("aria-labelledby") === id),
  );
  if (linked) return linked;
  if (trigger.getAttribute("aria-expanded") !== "true") return null;
  const unlinked = menus.filter((menu) => {
    const labelledBy = menu.getAttribute("aria-labelledby");
    const menuId = menu.getAttribute("id");
    return (!labelledBy || labelledBy === id) && !(controls && menuId && menuId !== controls);
  });
  return unlinked.length === 1 ? unlinked[0] : null;
}

/** Page function: the Archive item in `menu` (never Unarchive, Restore or anything else). */
export function findArchiveMenuItem(
  menu: Element | null,
  labels: Pick<ArchiveLabelSet, "archiveItem" | "unarchive">,
): Element | null {
  if (!menu) return null;
  const labelOf = (node: Element) =>
    String(
      [node.getAttribute("aria-label"), node.getAttribute("title"), node.textContent]
        .filter(Boolean)
        .join(" "),
    )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const items = Array.from(
    menu.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], [role="option"], button, a, div[tabindex]',
    ),
  ).filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return (
    items.find((item) => {
      const label = labelOf(item);
      if (!label) return false;
      if (labels.unarchive.some((entry) => label.includes(entry))) return false;
      return labels.archiveItem.some((entry) => label.includes(entry));
    }) ?? null
  );
}

/** Page function: whether `menu` offers Unarchive/Restore (the chat is already archived). */
export function menuOffersUnarchive(
  menu: Element | null,
  labels: Pick<ArchiveLabelSet, "unarchive">,
): boolean {
  if (!menu) return false;
  return Array.from(menu.querySelectorAll('[role^="menuitem"], [role="option"], button')).some(
    (item) => {
      const label = String(item.getAttribute("aria-label") ?? item.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return labels.unarchive.some((entry) => label.includes(entry));
    },
  );
}

/** Page function: an Archive button in a confirmation dialog, if one is open. */
export function findArchiveConfirmButton(
  doc: Document,
  labels: Pick<ArchiveLabelSet, "confirmButtonExact" | "confirmButtonContains" | "unarchive">,
): Element | null {
  const candidates = Array.from(
    doc.querySelectorAll(
      '[role="dialog"] button, [role="dialog"] [role="button"], [role="alertdialog"] button, [role="alertdialog"] [role="button"]',
    ),
  ).filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return (
    candidates.find((node) => {
      const label = String(node.getAttribute("aria-label") ?? node.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!label) return false;
      if (labels.unarchive.some((entry) => label.includes(entry))) return false;
      return (
        labels.confirmButtonExact.includes(label) ||
        labels.confirmButtonContains.some((entry) => label.includes(entry))
      );
    }) ?? null
  );
}

/** Page function: what the page shows about the archive right now. */
export function readArchiveSignals(
  doc: Document,
  conversationId: string | null,
  labels: Pick<ArchiveLabelSet, "toast">,
): { rowPresent: boolean; pageConversationId: string | null; toast: boolean } {
  const idOf = (href: string | null) => {
    const match = /\/c\/([^/?#]+)/.exec(String(href ?? ""));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const rowPresent = Boolean(
    conversationId &&
    Array.from(doc.querySelectorAll("a[href]")).some(
      (link) =>
        idOf(link.getAttribute("href")) === conversationId &&
        !link.closest("main") &&
        visible(link),
    ),
  );
  const toastText = Array.from(
    doc.querySelectorAll(
      '[role="status"], [role="alert"], [data-testid*="toast"], [class*="toast"], [class*="snackbar"]',
    ),
  )
    .filter(visible)
    .map((node) => String(node.textContent ?? "").toLowerCase())
    .join(" ");
  return {
    rowPresent,
    pageConversationId: idOf(doc.location?.pathname ?? null),
    toast: labels.toast.some((entry) => toastText.includes(entry)),
  };
}

type ArchiveOutcome =
  | { status: "archived"; conversationUrl?: string | null }
  | { status: "skipped"; reason: string; detail?: string; conversationUrl?: string | null }
  | { status: "failed"; error: string; conversationUrl?: string | null };

type ArchivePath = { name: string; trigger: string; target: string; navigationUrl: string };

const ARCHIVE_STAGE = "archive-conversation";
const REASON_RANK: Record<string, number> = {
  "conversation-menu-not-found": 0,
  "conversation-menu-not-opened": 1,
  "archive-menu-item-not-found": 2,
};

type ArchiveClickResult =
  | Awaited<ReturnType<typeof guardedTrustedClick>>
  | { status: "conversation-changed" | "cancelled"; detail?: string };

/** A guarded click whose navigation or delivery cancellation is a result, not an error. */
async function archiveClick(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  options: { locate: string; target: string; navigationUrl: string; settleTimeoutMs: number },
): Promise<ArchiveClickResult> {
  try {
    return await guardedTrustedClick(runtime, input, { ...options, stage: ARCHIVE_STAGE });
  } catch (error) {
    const code = (error as { details?: { code?: string } })?.details?.code;
    if (code === "attachment-control-unexpected-navigation") {
      return { status: "conversation-changed", detail: "the open page changed before the click" };
    }
    if (code === "trusted-click-cancelled") {
      return { status: "cancelled", detail: "the target moved or was covered at the click" };
    }
    throw error;
  }
}

async function evaluateValue<T>(
  runtime: ChromeClient["Runtime"],
  expression: string,
): Promise<T | undefined> {
  const evaluated = await runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  return evaluated?.result?.value as T | undefined;
}

const menuLocate = (path: ArchivePath) =>
  `() => (${findMenuForTrigger.toString()})(document, (${path.trigger})(), window.__oracleArchiveMenusBefore ?? null)`;

async function waitForMenu(
  runtime: ChromeClient["Runtime"],
  path: ArchivePath,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluateValue<boolean>(runtime, `Boolean((${menuLocate(path)})())`)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

async function closeMenus(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
): Promise<void> {
  const remaining = await evaluateValue<number>(
    runtime,
    `(() => {
      const target = document.activeElement ?? document;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return document.querySelectorAll('[role="menu"]').length;
    })()`,
  ).catch(() => 0);
  if (remaining && input && typeof input.dispatchKeyEvent === "function") {
    await delay(150);
    for (const type of ["keyDown", "keyUp"] as const) {
      await input
        .dispatchKeyEvent({ type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
        .catch(() => undefined);
    }
  }
}

/** Opens the path's menu with our own click. Returns why not, or null when it is open. */
async function openPathMenu(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  path: ArchivePath,
): Promise<{ reason: string; detail: string } | null> {
  // A menu that is already open was not opened by us: close it and never adopt it.
  const openMenus = await evaluateValue<number>(
    runtime,
    `document.querySelectorAll('[role="menu"]').length`,
  );
  if (openMenus) await closeMenus(runtime, input);
  await evaluateValue(
    runtime,
    `(() => { window.__oracleArchiveMenusBefore = new WeakSet(Array.from(document.querySelectorAll('[role="menu"]'))); return true; })()`,
  );
  const clicked = await archiveClick(runtime, input, {
    locate: path.trigger,
    target: path.target,
    navigationUrl: path.navigationUrl,
    settleTimeoutMs: 1_500,
  });
  if (clicked.status === "conversation-changed") {
    return { reason: "conversation-changed", detail: `${path.name}: ${clicked.detail}` };
  }
  if (clicked.status === "missing") {
    return { reason: "conversation-menu-not-found", detail: `${path.name}: no menu button` };
  }
  if (clicked.status !== "clicked") {
    return {
      reason: "conversation-menu-not-opened",
      detail: `${path.name}: menu button ${clicked.status}${clicked.detail ? ` (${clicked.detail})` : ""}`,
    };
  }
  if (await waitForMenu(runtime, path, 2_000)) return null;
  return { reason: "conversation-menu-not-opened", detail: `${path.name}: no menu appeared` };
}

async function runArchive(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  conversationUrl: string | null,
): Promise<ArchiveOutcome> {
  const startUrl = (await evaluateValue<string>(runtime, "location.href")) ?? conversationUrl;
  // Only the run's own conversation is ever archived; without its id nothing is.
  const conversationId = conversationIdFromUrl(conversationUrl);
  if (!conversationId || !startUrl) {
    return {
      status: "skipped",
      reason: "missing-conversation-url",
      detail: "the run's conversation id is unknown",
      conversationUrl: startUrl,
    };
  }
  const pageConversationId = conversationIdFromUrl(startUrl);
  const labels = JSON.stringify(ARCHIVE_LABELS);
  const signalsExpression = `(${readArchiveSignals.toString()})(document, ${JSON.stringify(conversationId)}, ${labels})`;
  // Every click is cancelled at delivery if the open page is no longer the one we started on.
  const paths: ArchivePath[] = [
    {
      name: "sidebar row",
      trigger: `() => (${findConversationRowMenuButton.toString()})(document, ${JSON.stringify(conversationId)}, ${JSON.stringify(ARCHIVE_LABELS.rowMenuButton)})`,
      target: "The chat's sidebar menu button",
      navigationUrl: startUrl,
    },
  ];
  // The header menu acts on the open page, so it is only used while that page is this chat.
  if (pageConversationId === conversationId) {
    paths.push({
      name: "header menu",
      trigger: `() => (${findHeaderConversationMenuButton.toString()})(document, ${JSON.stringify(ARCHIVE_LABELS.headerMenuButton)})`,
      target: "The conversation menu button",
      navigationUrl: startUrl,
    });
  }
  const before = await evaluateValue<{ rowPresent?: boolean }>(runtime, signalsExpression);
  const rowPresentBefore = before?.rowPresent === true;
  let reason = "conversation-menu-not-found";
  const details: string[] = [];
  const note = (nextReason: string, detail: string) => {
    details.push(detail);
    if ((REASON_RANK[nextReason] ?? 0) >= (REASON_RANK[reason] ?? 0)) reason = nextReason;
  };
  const conversationChanged = (detail: string): ArchiveOutcome => ({
    status: "skipped",
    reason: "conversation-changed",
    detail: `${detail}; nothing more was clicked`,
    conversationUrl: startUrl,
  });
  for (const path of paths) {
    const notOpen = await openPathMenu(runtime, input, path);
    if (notOpen?.reason === "conversation-changed") {
      await closeMenus(runtime, input);
      return conversationChanged(notOpen.detail);
    }
    if (notOpen) {
      note(notOpen.reason, notOpen.detail);
      continue;
    }
    const itemLocate = `() => (${findArchiveMenuItem.toString()})((${menuLocate(path)})(), ${labels})`;
    const item = await archiveClick(runtime, input, {
      locate: itemLocate,
      target: "The ChatGPT Archive menu item",
      navigationUrl: path.navigationUrl,
      settleTimeoutMs: 1_000,
    });
    if (item.status === "conversation-changed") {
      await closeMenus(runtime, input);
      return conversationChanged(`${path.name}: ${item.detail}`);
    }
    if (item.status !== "clicked") {
      note(
        "archive-menu-item-not-found",
        `${path.name}: ${item.status === "missing" ? "no Archive item" : `Archive item ${item.status}`}`,
      );
      await closeMenus(runtime, input);
      continue;
    }
    if (
      await waitForArchived(runtime, input, {
        signalsExpression,
        conversationId,
        pageConversationId,
        rowPresentBefore,
        navigationUrl: path.navigationUrl,
      })
    ) {
      return { status: "archived", conversationUrl: startUrl };
    }
    // Earlier UIs keep the chat open and offer Unarchive in the same menu afterwards.
    if ((await openPathMenu(runtime, input, path)) === null) {
      const unarchive = await evaluateValue<boolean>(
        runtime,
        `(${menuOffersUnarchive.toString()})((${menuLocate(path)})(), ${labels})`,
      );
      await closeMenus(runtime, input);
      if (unarchive) return { status: "archived", conversationUrl: startUrl };
    }
    return {
      status: "skipped",
      reason: "archive-not-confirmed",
      detail: `${path.name}: Archive clicked, but the chat stayed in the sidebar and no confirmation appeared`,
      conversationUrl: startUrl,
    };
  }
  return { status: "skipped", reason, detail: details.join("; "), conversationUrl: startUrl };
}

async function waitForArchived(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  options: {
    signalsExpression: string;
    conversationId: string | null;
    pageConversationId: string | null;
    rowPresentBefore: boolean;
    navigationUrl: string;
  },
): Promise<boolean> {
  const confirmLocate = `() => (${findArchiveConfirmButton.toString()})(document, ${JSON.stringify(ARCHIVE_LABELS)})`;
  let confirmed = false;
  const deadline = Date.now() + 6_000;
  for (;;) {
    const signals = await evaluateValue<ReturnType<typeof readArchiveSignals>>(
      runtime,
      options.signalsExpression,
    );
    if (signals) {
      if (signals.toast) return true;
      if (options.rowPresentBefore && !signals.rowPresent) return true;
      // Leaving the chat counts only as the effect of our own Archive click on the open chat
      // (ChatGPT sends you home); a move to another conversation is not an archive.
      if (
        !options.rowPresentBefore &&
        options.pageConversationId === options.conversationId &&
        signals.pageConversationId === null
      )
        return true;
    }
    if (!confirmed && (await evaluateValue<boolean>(runtime, `Boolean((${confirmLocate})())`))) {
      const clicked = await archiveClick(runtime, input, {
        locate: confirmLocate,
        target: "The archive confirmation button",
        navigationUrl: options.navigationUrl,
        settleTimeoutMs: 1_000,
      });
      if (clicked.status === "conversation-changed") return false;
      confirmed = clicked.status === "clicked";
    }
    if (Date.now() >= deadline) return false;
    await delay(150);
  }
}

/**
 * Archives the conversation through ChatGPT's own menus: today the sidebar row's "Chat actions"
 * menu, earlier the header conversation menu. Clicks are trusted when `Input` is available. A
 * failure is reported, never thrown: the run already succeeded.
 */
export async function archiveChatGptConversation(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  {
    mode,
    conversationUrl,
    Input,
  }: {
    mode: BrowserArchiveMode;
    conversationUrl?: string | null;
    Input?: ChromeClient["Input"];
  },
): Promise<BrowserArchiveResult> {
  let value: ArchiveOutcome;
  try {
    value = await runArchive(Runtime, Input, conversationUrl ?? null);
  } catch (error) {
    value = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  const resolvedUrl = value.conversationUrl ?? conversationUrl ?? undefined;
  if (value.status === "archived") {
    logger("[browser] Archived ChatGPT conversation after saving local artifacts.");
    return { mode, attempted: true, archived: true, conversationUrl: resolvedUrl };
  }
  const reason = value.status === "skipped" ? value.reason : "archive-failed";
  const error = value.status === "failed" ? value.error : undefined;
  const detail = value.status === "skipped" && value.detail ? `: ${value.detail}` : "";
  logger(`[browser] ChatGPT archive skipped (${error ?? reason}${detail}).`);
  return {
    mode,
    attempted: true,
    archived: false,
    reason,
    conversationUrl: resolvedUrl,
    error,
  };
}
