import { randomUUID } from "node:crypto";
import type { BrowserAppApprovalRecord, BrowserLogger, ChromeClient } from "../types.js";
import { guardedTrustedClick } from "./composerTools.js";

/**
 * Allow-type buttons of ChatGPT's tool-permission prompts, compared trimmed and case-folded.
 * Lower rank wins: Always allow > Allow once > Allow. Deny or cancel labels are never listed.
 */
export const APP_APPROVAL_ALLOW_LABELS: ReadonlyArray<{ label: string; rank: number }> = [
  { label: "always allow", rank: 0 },
  { label: "항상 허용", rank: 0 },
  { label: "allow once", rank: 1 },
  { label: "1회 허용", rank: 1 },
  { label: "한 번만 허용", rank: 1 },
  { label: "allow", rank: 2 },
  { label: "허용", rank: 2 },
];

export interface AppApprovalVocabulary {
  /** Whole labels and their rank (lower wins). */
  exact: ReadonlyArray<{ label: string; rank: number }>;
  /** Label beginnings that make an allow button when the label ends there or goes on with a non-letter. */
  prefixes: ReadonlyArray<{ prefix: string; rank: number }>;
  /** A label (or aria-label) containing any of these is never an allow button. */
  deny: readonly string[];
}

/** What counts as an allow button, compared case-folded with whitespace collapsed. */
export const APP_APPROVAL_VOCABULARY: AppApprovalVocabulary = {
  exact: APP_APPROVAL_ALLOW_LABELS,
  // Longest first, so "Always allow for this chat" ranks as Always allow.
  prefixes: [
    { prefix: "always allow", rank: 0 },
    { prefix: "allow", rank: 2 },
    { prefix: "허용", rank: 2 },
  ],
  deny: ["don't", "do not", "deny", "not now", "cancel", "거부", "허용 안", "허용하지", "취소"],
};

export interface AppApprovalCard {
  /** Stable text key for "log once" bookkeeping. */
  key: string;
  /** The allowed app the card's title names, or null when it names none of them. */
  app: string | null;
  /** The card's title: its heading, its labelling text, or else its first line. */
  title: string;
  /** Card text without its buttons: what ChatGPT asks to run. */
  toolText: string;
  /** Best allow-type button (lowest rank) and its index in the remembered button list. */
  button: { label: string; rank: number; index: number };
}

/**
 * Finds visible approval cards. A candidate is an allow-type button. When its nearest alert or
 * dialog (one that holds no editor) exists, that element is the card wherever it sits, the
 * composer and floating layers included, but never inside a user message or an editable area.
 * Any other button must sit inside a dialog or the conversation thread, and never inside page
 * chrome (nav, aside, header), the composer, a user message or assistant prose; its card is the
 * nearest ancestor with text of its own. The allowed app must be named in the card's title
 * (heading, aria-labelledby/aria-label text, or else its first line), so tool arguments shown in
 * another app's card that mention an allowed app cannot approve that card. A button's label is
 * its rendered text without shortcut hints (kbd, trailing key glyphs or key names), icons and
 * hidden parts, or else its aria-label; it is an allow button by a whole known label or a known
 * beginning, never when it holds a deny word. Injected into the page with
 * Function.prototype.toString.
 */
export function scanAppApprovalCards(
  doc: Document,
  allowApps: readonly string[],
  vocabulary: AppApprovalVocabulary,
): { cards: AppApprovalCard[]; buttons: Element[] } {
  const normalize = (value: unknown): string =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (node: Element): boolean => {
    if (typeof node.getBoundingClientRect !== "function") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const BUTTON = 'button, [role="button"]';
  const DIALOG = '[role="dialog"], [role="alertdialog"]';
  // Elements that announce themselves as a prompt; such an element is the card wherever it sits.
  const ROLE_CARD = '[role="alert"], [role="alertdialog"], [role="dialog"]';
  const TURN =
    '[data-message-author-role], [data-turn], [data-testid^="conversation-turn"], article';
  // Today's user turn carries no role attribute, only its markdown root and group classes.
  const USER =
    '[data-message-author-role="user"], [data-turn="user"], .rich-text-user-turn, [class~="group/user-message"]';
  const PROSE = '.markdown, [class*="markdown"], [class*="prose"]';
  const EDITABLE =
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], textarea';
  // Places that never hold a permission card of the current turn.
  const OFF_LIMITS = `${PROSE}, ${USER}, form, ${EDITABLE}, [data-composer-overlay-floating-ui], [data-testid*="composer" i]`;
  const PAGE_CHROME = 'nav, aside, header, [data-testid*="sidebar" i]';
  const ARGUMENTS = "code, pre, samp, kbd";
  // Buttons whose text and aria-label hold no allow word are skipped before any layout query.
  const hints = [
    ...vocabulary.exact.map((entry) => entry.label),
    ...vocabulary.prefixes.map((entry) => entry.prefix),
  ];
  const mayAllow = (button: Element): boolean => {
    const quick = `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`;
    const folded = normalize(quick).toLowerCase();
    return hints.some((hint) => folded.includes(hint));
  };
  // Shortcut hints and icons are not part of a button's name: "Always allow ⌘⏎" is Always allow.
  const NOT_LABEL = 'kbd, svg, [aria-hidden="true"], [hidden]';
  const shortcutTails = [
    /[\s+]*[⌘⌥⇧⌃⏎↵↩⎋⌫⌦⇥⇤␣]+$/,
    /(?:^|[\s+⌘⌥⇧⌃])(?:ctrl|control|cmd|command|alt|opt|option|shift|meta|enter|return|esc|escape|tab|space|backspace|delete|del)$/i,
    /(?:[⌘⌥⇧⌃]|(?:^|\s)(?:ctrl|control|cmd|command|alt|opt|option|shift|meta))\s*\+?\s*[a-z0-9]$/i,
    /\s*\+$/,
  ];
  const withoutShortcut = (text: string): string => {
    let current = text;
    for (;;) {
      const next = shortcutTails.reduce((value, tail) => value.replace(tail, ""), current).trim();
      if (!next || next === current) return current;
      current = next;
    }
  };
  /** The button's rendered text without hints and icons, or else its aria-label. */
  const label = (button: Element): string => {
    const parts: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (element !== button) {
        if (element.matches(NOT_LABEL)) return;
        const style = doc.defaultView?.getComputedStyle?.(element);
        if (style?.display === "none" || style?.visibility === "hidden") return;
      }
      const children = (element as { childNodes?: ArrayLike<Node> }).childNodes;
      if (!children) {
        parts.push(element.textContent ?? "");
        return;
      }
      for (const child of Array.from(children)) walk(child);
    };
    walk(button);
    return (
      withoutShortcut(normalize(parts.join(""))) || normalize(button.getAttribute("aria-label"))
    );
  };
  const fold = (value: unknown): string =>
    normalize(value)
      .toLowerCase()
      .replace(/[‘’ʼ`´]/g, "'");
  const denied = (value: unknown): boolean => {
    const text = fold(value);
    return vocabulary.deny.some((word) => text.includes(word));
  };
  const rankOf = (button: Element, text: string): number => {
    if (denied(text) || denied(button.getAttribute("aria-label"))) return -1;
    const folded = fold(text);
    const exact = vocabulary.exact.find((entry) => entry.label === folded);
    if (exact) return exact.rank;
    for (const { prefix, rank } of vocabulary.prefixes) {
      if (folded.startsWith(prefix) && !/^[\p{L}\p{N}]/u.test(folded.slice(prefix.length))) {
        return rank;
      }
    }
    return -1;
  };
  const textOf = (root: Element, skip: string): string => {
    const parts: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (element.matches(skip) || element.getAttribute("aria-hidden") === "true") return;
      for (const child of Array.from(element.childNodes)) walk(child);
    };
    walk(root);
    return normalize(parts.join(" "));
  };
  /**
   * The nearest alert or dialog around the button, unless it holds an editor: that is a chat
   * surface (a floating chat frame), not a card.
   */
  const roleCardOf = (button: Element): Element | null => {
    const role = button.closest(ROLE_CARD);
    return role && !role.querySelector(EDITABLE) ? role : null;
  };
  /**
   * Where the button sits. A role card is its own region wherever it is (docked in the composer
   * form, in a floating layer), except inside a user message or an editable area. Any other
   * button must sit in a dialog, a turn or main with no excluded place in its whole ancestry: an
   * article inside prose or a user message must not end the check early.
   */
  const placeOf = (button: Element): { region: Element | null; role: boolean } => {
    const role = roleCardOf(button);
    if (role) {
      for (let node: Element | null = role; node; node = node.parentElement) {
        if (node.matches(USER) || node.matches(EDITABLE)) return { region: null, role: true };
      }
      return { region: role, role: true };
    }
    for (let node = button.parentElement; node; node = node.parentElement) {
      if (node.matches(OFF_LIMITS) || node.matches(PAGE_CHROME)) {
        return { region: null, role: false };
      }
    }
    return {
      region: button.closest(`${DIALOG}, ${TURN}`) ?? button.closest("main"),
      role: false,
    };
  };
  const cardOf = (button: Element, region: Element): Element | null => {
    for (let node = button.parentElement; node; node = node.parentElement) {
      if (textOf(node, `${BUTTON}, ${PROSE}, ${USER}`)) return node;
      if (node === region) return null;
    }
    return null;
  };
  // Declared before use by titlesOf; the first rendered line of each labelling element.
  const labelledLine = (ids: string | null): string =>
    normalize(
      String(ids ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) =>
          firstLineOf(
            Array.from(doc.querySelectorAll("[id]")).find(
              (node) => node.getAttribute("id") === id,
            ) ?? null,
            null,
          ),
        )
        .join(" "),
    );
  // Rendered lines: inline pieces join, block elements (by computed display, or by tag where
  // there is no layout) start new lines. Buttons, prose, user text and tool arguments are skipped.
  const BLOCK_TAGS =
    /^(address|article|aside|blockquote|br|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/i;
  const isBlock = (element: Element): boolean => {
    const display = doc.defaultView?.getComputedStyle?.(element)?.display;
    if (display)
      return !display.startsWith("inline") && display !== "contents" && display !== "none";
    return BLOCK_TAGS.test(element.tagName);
  };
  // Text a reader does not see is not part of a rendered line.
  const hiddenElement = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true") return true;
    const style = doc.defaultView?.getComputedStyle?.(element);
    if (style?.display === "none" || /^(hidden|collapse)$/.test(style?.visibility ?? "")) {
      return true;
    }
    // A display: contents wrapper has no box of its own, but its children render.
    if (style?.display === "contents") return false;
    const rect = element.getBoundingClientRect?.();
    return Boolean(rect) && (rect.width === 0 || rect.height === 0);
  };
  // A title root counts only when shown: the root by every rule above, its ancestors up to
  // `boundary` (the whole document when null) by the states that hide a subtree; a zero-size
  // wrapper can still show children that overflow it.
  const hiddenRoot = (root: Element, boundary: Element | null): boolean => {
    if (hiddenElement(root)) return true;
    for (let node = root.parentElement; node; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true") return true;
      if (doc.defaultView?.getComputedStyle?.(node)?.display === "none") return true;
      if (node === boundary) break;
    }
    return false;
  };
  const firstLineOf = (root: Element | null, boundary: Element | null): string => {
    if (!root || hiddenRoot(root, boundary)) return "";
    const skip = `${BUTTON}, ${PROSE}, ${USER}, ${ARGUMENTS}`;
    const lines: string[] = [""];
    const breakLine = () => {
      if (lines[lines.length - 1].trim()) lines.push("");
    };
    const walk = (node: Node, top: boolean): void => {
      if (node.nodeType === 3) {
        // A newline in the text is a line break where CSS keeps it (or where nothing says).
        const whiteSpace = node.parentElement
          ? doc.defaultView?.getComputedStyle?.(node.parentElement)?.whiteSpace
          : undefined;
        const keepsBreaks = !whiteSpace || /pre|break-spaces/.test(whiteSpace);
        const parts = keepsBreaks
          ? String(node.nodeValue ?? "").split(/\r?\n/)
          : [node.nodeValue ?? ""];
        parts.forEach((part, index) => {
          if (index > 0) breakLine();
          lines[lines.length - 1] += part;
        });
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      // Chrome computes display: inline and no box for <br>, but it always ends the line.
      if (element.tagName === "BR") {
        breakLine();
        return;
      }
      if (!top && (element.matches(skip) || hiddenElement(element))) return;
      const block = !top && isBlock(element);
      if (block) breakLine();
      for (const child of Array.from(element.childNodes)) walk(child, false);
      if (block) breakLine();
    };
    walk(root, true);
    return lines.map((line) => normalize(line)).find(Boolean) ?? "";
  };
  /**
   * Title candidates in order, each a single line and never merged with what follows: the
   * card's heading, its aria-labelledby text, its aria-label, its first rendered line. The card's
   * title is the first one present. A surrounding dialog's label is never the card's title: a
   * dialog that is a prompt is the card itself, and one that holds the chat is labelled with the
   * chat's name.
   */
  const titlesOf = (card: Element, region: Element): string[] => {
    const heading = Array.from(
      card.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6'),
    ).find((node) => !node.closest(PROSE) && !hiddenRoot(node, card));
    const candidates = [firstLineOf(heading ?? null, card)];
    if (!hiddenRoot(card, region)) {
      candidates.push(labelledLine(card.getAttribute("aria-labelledby")));
      candidates.push(normalize(card.getAttribute("aria-label")));
    }
    candidates.push(firstLineOf(card, region));
    return candidates.filter(Boolean);
  };
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = (text: string): string | null =>
    allowApps.find((app) =>
      new RegExp(`(^|[^A-Za-z0-9_])${escape(app.trim())}($|[^A-Za-z0-9_])`, "i").test(text),
    ) ?? null;

  type Candidate = {
    button: Element;
    rank: number;
    label: string;
    region: Element;
    role: boolean;
    textCard: Element;
  };
  const candidates: Candidate[] = [];
  for (const button of Array.from(doc.querySelectorAll(BUTTON))) {
    if (!mayAllow(button) || !visible(button)) continue;
    if (button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true")
      continue;
    const text = label(button);
    const rank = rankOf(button, text);
    if (rank < 0) continue;
    const { region, role } = placeOf(button);
    if (!region) continue;
    // The nearest ancestor with text of its own; a role card counts even with only a label.
    const textCard = cardOf(button, region) ?? (role ? region : null);
    if (!textCard) continue;
    candidates.push({ button, rank, label: text, region, role, textCard });
  }
  // A role element holding several prompts (buttons under different text blocks) is a container:
  // each prompt is its own card there, so one prompt's title never covers another's button.
  const promptsIn = new Map<Element, Set<Element>>();
  for (const { region, role, textCard } of candidates) {
    if (!role || textCard === region) continue;
    const set = promptsIn.get(region) ?? new Set<Element>();
    set.add(textCard);
    promptsIn.set(region, set);
  }
  const byCard = new Map<
    Element,
    { region: Element; best: Element; rank: number; label: string }
  >();
  for (const { button, rank, label: text, region, role, textCard } of candidates) {
    const card = role && (promptsIn.get(region)?.size ?? 0) < 2 ? region : textCard;
    const current = byCard.get(card);
    if (!current || rank < current.rank) {
      byCard.set(card, { region, best: button, rank, label: text });
    }
  }
  const cards: AppApprovalCard[] = [];
  const buttons: Element[] = [];
  for (const [card, { region, best, rank, label: bestLabel }] of byCard.entries()) {
    // The title is the first candidate present; a later line naming the app does not count.
    const title = titlesOf(card, region)[0] ?? "";
    const text = textOf(card, `${BUTTON}, ${PROSE}, ${USER}`);
    buttons.push(best);
    cards.push({
      key: `${title}\n${text}`.slice(0, 400),
      app: names(title),
      title: title.slice(0, 200),
      toolText: text.slice(0, 500),
      button: { label: bestLabel, rank, index: buttons.length - 1 },
    });
  }
  return { cards, buttons };
}

export function buildAppApprovalScanExpression(
  allowApps: readonly string[],
  token: string,
): string {
  return `(() => {
    const scan = ${scanAppApprovalCards.toString()};
    const { cards, buttons } = scan(document, ${JSON.stringify(allowApps)}, ${JSON.stringify(APP_APPROVAL_VOCABULARY)});
    window.__oracleApprovalButtons = { token: ${JSON.stringify(token)}, nodes: buttons };
    return cards;
  })()`;
}

/**
 * Page function source for the click target: the remembered button, but only while a fresh
 * scan still finds it as the allow-type button of a card whose title names the same app.
 */
export function buildAppApprovalLocate(
  allowApps: readonly string[],
  token: string,
  card: Pick<AppApprovalCard, "app" | "button">,
): string {
  return `() => {
    const stored = window.__oracleApprovalButtons?.token === ${JSON.stringify(token)} ? window.__oracleApprovalButtons.nodes[${card.button.index}] ?? null : null;
    if (!stored || !stored.isConnected) return null;
    const scan = ${scanAppApprovalCards.toString()};
    const { cards, buttons } = scan(document, ${JSON.stringify(allowApps)}, ${JSON.stringify(APP_APPROVAL_VOCABULARY)});
    const now = cards[buttons.indexOf(stored)];
    return now && now.app === ${JSON.stringify(card.app)} && now.button.label === ${JSON.stringify(card.button.label)} ? stored : null;
  }`;
}

export interface AppApprovalMonitorOptions {
  allowApps: readonly string[];
  logger: BrowserLogger;
  intervalMs?: number;
  onApproval?: (record: BrowserAppApprovalRecord) => void | Promise<void>;
  /** Run-level set of stop functions, so the run's cleanup can stop a monitor it raced past. */
  registry?: Set<() => Promise<void>>;
}

// Unref'd so a monitor can never keep the process alive on its own.
const idle = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

const RECLICK_AFTER_MS = 3_000;

/**
 * Watches the tab for tool-permission prompts of the allowed apps and approves them with a
 * guarded trusted click. Cards that name no allowed app are left for the user (logged once).
 * Returns a stop function that waits for an in-flight poll.
 */
export function startAppApprovalMonitor(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  options: AppApprovalMonitorOptions,
): () => Promise<void> {
  const allowApps = options.allowApps.map((app) => app.trim()).filter(Boolean);
  if (allowApps.length === 0) return async () => {};
  const intervalMs = Math.max(250, options.intervalMs ?? 1_500);
  const leftForUser = new Set<string>();
  const lastClick = new Map<string, number>();
  const reportedErrors = new Set<string>();
  let stopped = false;

  const poll = async (): Promise<void> => {
    const token = randomUUID();
    const { result } = await runtime.evaluate({
      expression: buildAppApprovalScanExpression(allowApps, token),
      returnByValue: true,
    });
    const cards = Array.isArray(result?.value) ? (result.value as AppApprovalCard[]) : [];
    const visibleKeys = new Set(cards.map((card) => card.key));
    for (const key of lastClick.keys()) if (!visibleKeys.has(key)) lastClick.delete(key);
    for (const card of cards) {
      if (!card.app) {
        if (!leftForUser.has(card.key)) {
          leftForUser.add(card.key);
          options.logger(
            `[browser] App approval for "${(card.title || card.toolText).slice(0, 160)}" left for the user (its title names no app in --browser-allow-app).`,
          );
        }
        continue;
      }
      const previous = lastClick.get(card.key);
      if (previous !== undefined && Date.now() - previous < RECLICK_AFTER_MS) continue;
      if (previous !== undefined) {
        options.logger(
          `[browser] App approval for ${card.app} is still shown; clicking "${card.button.label}" again.`,
        );
      }
      lastClick.set(card.key, Date.now());
      const clicked = await guardedTrustedClick(runtime, input, {
        locate: buildAppApprovalLocate(allowApps, token, card),
        stage: "app-approval",
        target: `The "${card.button.label}" button for ${card.app}`,
        settleTimeoutMs: 1_500,
      });
      if (clicked.status !== "clicked") {
        lastClick.delete(card.key);
        continue;
      }
      const record: BrowserAppApprovalRecord = {
        app: card.app,
        button: card.button.label,
        toolText: card.toolText,
        approvedAt: new Date().toISOString(),
      };
      options.logger(
        `[browser] App approval: ${record.app} approved ("${record.button}") at ${record.approvedAt}: ${record.toolText.slice(0, 200)}`,
      );
      await options.onApproval?.(record);
    }
  };

  const loop = (async () => {
    while (!stopped) {
      try {
        await poll();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!reportedErrors.has(message)) {
          reportedErrors.add(message);
          options.logger(`[browser] App approval check failed (will keep watching): ${message}`);
        }
      }
      if (stopped) break;
      await idle(intervalMs);
    }
  })();

  const stop = async () => {
    stopped = true;
    options.registry?.delete(stop);
    await loop.catch(() => undefined);
  };
  options.registry?.add(stop);
  return stop;
}

/** Runs `operation` with the approval monitor active (no-op when no app is allowed). */
export async function withAppApprovalMonitor<T>(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  options: AppApprovalMonitorOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const stop = startAppApprovalMonitor(runtime, input, options);
  try {
    return await operation();
  } finally {
    await stop();
  }
}
