import { randomUUID } from "node:crypto";
import { BrowserAutomationError } from "../../oracle/errors.js";
import type { BrowserAppApprovalRecord, BrowserLogger, ChromeClient } from "../types.js";
import { guardedTrustedClick, type GuardedTrustedClickResult } from "./composerTools.js";

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
  /**
   * Beginnings of labels that look like an allow or approve button. Such a button that is not
   * taken is reported (with why), so a renamed or moved prompt never goes unnoticed.
   */
  allowLike: readonly string[];
  /**
   * Whole labels (or beginnings followed by a non-letter) of a prompt's other actions. With a
   * deny label they mark a card without a role as a prompt, so an allowed app's prompt whose
   * buttons are all unknown (e.g. "Continue") is reported.
   */
  promptActions: readonly string[];
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
  allowLike: ["allow", "always", "허용", "항상", "1회", "한 번만", "approve", "승인"],
  promptActions: ["continue", "proceed", "confirm", "ok", "yes", "계속", "확인", "예"],
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
  /** Index of the card element in the remembered subject list (for diagnostics). */
  subject?: number;
  /**
   * The card's identity across polls (set by the scan expression): the document's own random
   * token and a number, so a card of a reloaded page never takes an earlier page's identity.
   */
  id?: string | number;
}

/** An allow-looking button, or an allowed app's prompt, that the scan does not take. */
export interface AppApprovalSkip {
  /**
   * label: no known allow label (an allowed app's prompt with unknown buttons, or an
   * allow-looking label that is not in the list); excluded: an ancestor rules the place out;
   * no-card: nothing around the button counts as a card.
   */
  reason: "label" | "excluded" | "no-card";
  /** Labels of the buttons concerned. */
  labels: string[];
  /** The card's title, when there is a card. */
  title: string;
  /** The allowed app that title names, if any. */
  app: string | null;
  /** The excluding ancestor (tag#id.classes [role] [data-testid]) for "excluded". */
  detail: string;
  /** Index of the element to describe in a diagnostic. */
  subject: number;
  /** That element's identity across polls (set by the scan expression), per document. */
  id?: string | number;
}

/**
 * An approval prompt of an allowed app that is in the page but not shown: zero-size, collapsed,
 * display: none, visibility: hidden, content-visibility-skipped, inside a closed details, or with
 * its allow buttons hidden. Never clicked; the run reloads the conversation so it renders.
 */
export interface AppApprovalHidden {
  app: string;
  /** Its question ("Allow ChatGPT to use CODEXish?") or else its first line, hidden text included. */
  title: string;
  /** Why it is not shown, e.g. "display: none" or "collapsed (zero-size ancestor)". */
  state: string;
  /** True when it holds an enabled allow button: a prompt that waits for an answer. */
  pending: boolean;
  subject: number;
  id?: string | number;
}

/** What a diagnostic file holds about a card that was not taken or not clicked. */
export interface AppApprovalDiagnosticPage {
  url: string;
  /** The card's outerHTML, cut at about 30 KB. */
  html: string;
  htmlLength: number;
  /** The card and its ancestors up to body. */
  ancestors: Array<{ tag: string; id: string; className: string; role: string; testId: string }>;
  buttons: Array<{ label: string; text: string; ariaLabel: string | null; disabled: boolean }>;
  /** True when the element was too wide to save (it held the main area or the conversation). */
  withheld?: boolean;
}

export interface AppApprovalDiagnostic {
  /** The log line it belongs to. */
  reason: string;
  capturedAt: string;
  /** Null when the card was gone before it could be read. */
  page: AppApprovalDiagnosticPage | null;
}

const DIAGNOSTIC_HTML_CHARS = 30_000;
// Markup a diagnostic never holds: the page's main area, an editor, or a conversation turn.
const DIAGNOSTIC_WIDE_SELECTOR =
  'main, [contenteditable="true"], [role="textbox"], textarea, [data-message-author-role], [data-turn], [data-testid^="conversation-turn"], .rich-text-user-turn, [class~="group/user-message"]';

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
): {
  cards: AppApprovalCard[];
  buttons: Element[];
  skipped: AppApprovalSkip[];
  hidden: AppApprovalHidden[];
  subjects: Element[];
  labelOf: (button: Element) => string;
} {
  const normalize = (value: unknown): string =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (node: Element): boolean => {
    if (typeof node.getBoundingClientRect !== "function") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const styleOf = (node: Element) => doc.defaultView?.getComputedStyle?.(node) ?? null;
  // A fixed or absolute element can escape a box that clips: the point at its centre hits it.
  const hitsItself = (node: Element): boolean => {
    const view = doc.defaultView;
    const rect = node.getBoundingClientRect?.();
    if (!view || !rect || typeof doc.elementFromPoint !== "function") return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return false;
    const hit = doc.elementFromPoint(x, y);
    return Boolean(hit) && (hit === node || node.contains(hit));
  };
  /**
   * Why a reader cannot see the element, or "" when it is shown. A box alone is not enough: a
   * visibility: hidden button keeps its box, a card collapsed into a zero-size ancestor that
   * hides overflow keeps its own size, and the contents of a closed details or of a
   * content-visibility: hidden element are not rendered. `skippedCounts` also counts contents that
   * content-visibility: auto skips because they are off screen (scrolling brings those back).
   */
  const hiddenState = (node: Element, skippedCounts: boolean): string => {
    let child: Element = node;
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (
        ancestor.tagName === "DETAILS" &&
        !ancestor.hasAttribute("open") &&
        child.tagName !== "SUMMARY"
      ) {
        return "inside a closed details";
      }
      child = ancestor;
    }
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = styleOf(current);
      if (!style) continue;
      if (style.display === "none") return "display: none";
      if (current === node && /^(hidden|collapse)$/.test(style.visibility)) {
        return `visibility: ${style.visibility}`;
      }
      if (current === node) continue;
      const contentVisibility = style.getPropertyValue?.("content-visibility") ?? "";
      if (contentVisibility === "hidden") return "content-visibility: hidden";
      const clips = /hidden|clip|auto|scroll/.test(`${style.overflowX} ${style.overflowY}`);
      // A display: contents wrapper has no box of its own and clips nothing.
      if (
        clips &&
        style.display !== "contents" &&
        typeof current.getBoundingClientRect === "function"
      ) {
        const box = current.getBoundingClientRect();
        if ((box.width <= 0 || box.height <= 0) && !hitsItself(node)) {
          return "collapsed (zero-size ancestor)";
        }
      }
    }
    if (!visible(node)) return "zero-size";
    const check = (node as { checkVisibility?: (options: object) => boolean }).checkVisibility;
    if (typeof check === "function") {
      // checkVisibilityCSS is the older name of visibilityProperty; unknown options are ignored.
      const options = { visibilityProperty: true, checkVisibilityCSS: true };
      if (!check.call(node, options)) return "not rendered";
      if (skippedCounts && !check.call(node, { ...options, contentVisibilityAuto: true })) {
        return "content-visibility: auto (skipped)";
      }
    }
    return "";
  };
  /** A button the user can see (or scroll to): only such a button is ever clicked. */
  const shown = (button: Element): boolean => hiddenState(button, false) === "";
  const BUTTON = 'button, [role="button"]';
  const DIALOG = '[role="dialog"], [role="alertdialog"]';
  // Elements that announce themselves as a prompt; such an element is the card wherever it sits.
  // ChatGPT's approval card (2026-10-26) marks itself as an approval surface; its role="alert"
  // wraps only the text, while the buttons sit in a sibling form.
  const ROLE_CARD =
    '[role="alert"], [role="alertdialog"], [role="dialog"], [data-codex-approval-surface="true"]';
  const TURN =
    '[data-message-author-role], [data-turn], [data-testid^="conversation-turn"], article';
  // Today's user turn carries no role attribute, only its markdown root and group classes.
  const USER =
    '[data-message-author-role="user"], [data-turn="user"], .rich-text-user-turn, [class~="group/user-message"]';
  const PROSE = '.markdown, [class*="markdown"], [class*="prose"]';
  const EDITABLE =
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], textarea';
  // Places that never hold a permission card of the current turn. A form counts only when it is
  // the composer (it holds an editor): the approval card keeps its own buttons in a small form.
  const OFF_LIMITS = `${PROSE}, ${USER}, ${EDITABLE}, [data-composer-overlay-floating-ui], [data-testid*="composer" i]`;
  const composerForm = (node: Element): boolean =>
    node.matches("form") && Boolean(node.querySelector(EDITABLE));
  const PAGE_CHROME = 'nav, aside, header, [data-testid*="sidebar" i]';
  const ARGUMENTS = "code, pre, samp, kbd";
  // Buttons whose text and aria-label hold no allow word are skipped before any layout query.
  const hints = [
    ...vocabulary.exact.map((entry) => entry.label),
    ...vocabulary.prefixes.map((entry) => entry.prefix),
    ...vocabulary.allowLike,
    ...vocabulary.promptActions,
    ...vocabulary.deny,
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
  const allowLike = (text: string): boolean => {
    const folded = fold(text);
    return !denied(folded) && vocabulary.allowLike.some((prefix) => folded.startsWith(prefix));
  };
  const startsWord = (folded: string, prefix: string): boolean =>
    folded.startsWith(prefix) && !/^[\p{L}\p{N}]/u.test(folded.slice(prefix.length));
  // A deny label or another action of a prompt ("Continue", "OK"): never clicked, only a sign
  // that the card around it is a prompt.
  const promptLike = (text: string): boolean => {
    const folded = fold(text);
    return denied(folded) || vocabulary.promptActions.some((action) => startsWord(folded, action));
  };
  const describe = (element: Element): string => {
    const classes = String(element.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4);
    const role = element.getAttribute("role");
    const testId = element.getAttribute("data-testid");
    const id = element.getAttribute("id");
    return [
      element.tagName.toLowerCase(),
      id ? `#${id}` : "",
      classes.map((name) => `.${name}`).join(""),
      role ? ` [role=${role}]` : "",
      testId ? ` [data-testid=${testId}]` : "",
    ].join("");
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
   * An alert or dialog that holds an editor, conversation turns or a user message is a chat
   * surface (the floating chat frame, with or without its composer mounted), never a card.
   */
  const chatSurface = (role: Element): boolean =>
    Boolean(role.querySelector(`${EDITABLE}, ${TURN}, ${USER}`));
  /** The nearest alert or dialog around the button, unless it is a chat surface. */
  const roleCardOf = (button: Element): Element | null => {
    const role = button.closest(ROLE_CARD);
    return role && !chatSurface(role) ? role : null;
  };
  /**
   * Where the button sits. A role card is its own region wherever it is (docked in the composer
   * form, in a floating layer), except inside a user message or an editable area. Any other
   * button must sit in a dialog, a turn or main with no excluded place in its whole ancestry: an
   * article inside prose or a user message must not end the check early.
   */
  const placeOf = (
    button: Element,
  ): { region: Element | null; role: boolean; excludedBy: Element | null } => {
    const role = roleCardOf(button);
    if (role) {
      for (let node: Element | null = role; node; node = node.parentElement) {
        if (node.matches(USER) || node.matches(EDITABLE)) {
          return { region: null, role: true, excludedBy: node };
        }
      }
      return { region: role, role: true, excludedBy: null };
    }
    for (let node = button.parentElement; node; node = node.parentElement) {
      if (node.matches(OFF_LIMITS) || composerForm(node) || node.matches(PAGE_CHROME)) {
        return { region: null, role: false, excludedBy: node };
      }
    }
    return {
      region: button.closest(`${DIALOG}, ${TURN}`) ?? button.closest("main"),
      role: false,
      excludedBy: null,
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
  const firstLineOf = (
    root: Element | null,
    boundary: Element | null,
    exclude: readonly Element[] = [],
  ): string => {
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
      if (!top && (exclude.includes(element) || element.matches(skip) || hiddenElement(element))) {
        return;
      }
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
   * chat's name. `exclude` leaves out blocks of the card (the separate prompts of a role card).
   */
  const titlesOf = (card: Element, region: Element, exclude: readonly Element[] = []): string[] => {
    const heading = Array.from(
      card.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6'),
    ).find(
      (node) =>
        !node.closest(PROSE) &&
        !hiddenRoot(node, card) &&
        !exclude.some((block) => block.contains(node)),
    );
    const candidates = [firstLineOf(heading ?? null, card)];
    if (!hiddenRoot(card, region)) {
      candidates.push(labelledLine(card.getAttribute("aria-labelledby")));
      candidates.push(normalize(card.getAttribute("aria-label")));
    }
    candidates.push(firstLineOf(card, region, exclude));
    return candidates.filter(Boolean);
  };
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = (text: string): string | null =>
    allowApps.find((app) =>
      new RegExp(`(^|[^A-Za-z0-9_])${escape(app.trim())}($|[^A-Za-z0-9_])`, "i").test(text),
    ) ?? null;
  // Whether a prompt title names some app (any name in the usual phrasings), so a prompt block
  // that names another app is never covered by the title of the role card around it.
  const namesSomeApp = (text: string): boolean =>
    [
      /\ballow\s+\S.*?\s+to\b/i,
      /^\S.*?\s+(?:wants|would like|is asking)\s+to\b/i,
      /\S\s*(?:을\(를\)|를\(을\)|을|를)\s*사용하도록/,
    ].some((pattern) => pattern.test(text));

  type Entry = {
    button: Element;
    rank: number;
    label: string;
    region: Element;
    role: boolean;
    textCard: Element;
    /** accepted: an allow button; unknown: allow-looking, not in the list; prompt: a prompt's other action. */
    kind: "accepted" | "unknown" | "prompt";
  };
  const enabled = (button: Element): boolean =>
    !button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true";
  const subjects: Element[] = [];
  const subjectOf = (element: Element): number => {
    const index = subjects.indexOf(element);
    if (index >= 0) return index;
    subjects.push(element);
    return subjects.length - 1;
  };
  // A diagnostic shows a card, never the thread: a subject holding the page's main area, a chat
  // surface or (outside a role card) a rendered message is narrowed to the button's parent.
  const tooWide = (node: Element): boolean =>
    node.matches("html, body, main") ||
    Boolean(node.querySelector("main")) ||
    chatSurface(node) ||
    (!node.matches(ROLE_CARD) && Boolean(node.querySelector(`${PROSE}, [class*="MarkdownRoot"]`)));
  const subjectFor = (preferred: Element | null, button: Element): number => {
    for (const node of [preferred, button.parentElement]) {
      if (node && !tooWide(node)) return subjectOf(node);
    }
    return subjectOf(button);
  };
  // The nearest ancestor with text of its own strictly below `boundary`.
  const cardBelow = (button: Element, boundary: Element): Element | null => {
    for (let node = button.parentElement; node && node !== boundary; node = node.parentElement) {
      if (textOf(node, `${BUTTON}, ${PROSE}, ${USER}`)) return node;
    }
    return null;
  };
  // Buttons that are not taken because of where they sit, one report per subject and place.
  const placeSkips: AppApprovalSkip[] = [];
  const skipPlace = (
    reason: "excluded" | "no-card",
    text: string,
    detail: string,
    subject: number,
  ) => {
    const same = placeSkips.find(
      (skip) => skip.subject === subject && skip.reason === reason && skip.detail === detail,
    );
    if (same) {
      if (!same.labels.includes(text)) same.labels.push(text);
      return;
    }
    placeSkips.push({ reason, labels: [text], title: "", app: null, detail, subject });
  };
  const entries: Entry[] = [];
  for (const button of Array.from(doc.querySelectorAll(BUTTON))) {
    if (!mayAllow(button) || !enabled(button) || !shown(button)) continue;
    const text = label(button);
    const rank = rankOf(button, text);
    const kind =
      rank >= 0 ? "accepted" : allowLike(text) ? "unknown" : promptLike(text) ? "prompt" : null;
    if (!kind) continue;
    const { region, role, excludedBy } = placeOf(button);
    if (!region) {
      if (kind === "prompt") continue;
      // Never above the excluding ancestor: the role card, else a text card below it.
      const around = roleCardOf(button) ?? (excludedBy ? cardBelow(button, excludedBy) : null);
      skipPlace(
        excludedBy ? "excluded" : "no-card",
        text,
        excludedBy ? describe(excludedBy) : "",
        subjectFor(around, button),
      );
      continue;
    }
    // The nearest ancestor with text of its own; a role card counts even with only a label.
    const textCard = cardOf(button, region) ?? (role ? region : null);
    if (!textCard) {
      if (kind !== "prompt")
        skipPlace("no-card", text, "", subjectFor(button.parentElement, button));
      continue;
    }
    entries.push({ button, rank, label: text, region, role, textCard, kind });
  }

  // A role element whose allow-looking buttons sit under different text blocks holds several
  // prompts, so one prompt's title never covers another prompt's button.
  const promptsIn = new Map<Element, Set<Element>>();
  for (const { region, role, textCard, kind } of entries) {
    if (!role || kind === "prompt" || textCard === region) continue;
    const set = promptsIn.get(region) ?? new Set<Element>();
    set.add(textCard);
    promptsIn.set(region, set);
  }
  const titleCache = new Map<Element, string>();
  const titleOf = (card: Element, region: Element, exclude: readonly Element[] = []): string => {
    const cached = titleCache.get(card);
    if (cached !== undefined) return cached;
    const title = titlesOf(card, region, exclude)[0] ?? "";
    titleCache.set(card, title);
    return title;
  };
  /**
   * The card an entry belongs to and its title. In a role element holding several prompts, a
   * block whose own title names an app (an allowed one or any other) is its own card; the other
   * blocks are parts of the role element's prompt, titled by what lies outside the blocks.
   */
  const cardOfEntry = (entry: Entry): { card: Element; title: string } => {
    if (!entry.role) return { card: entry.textCard, title: titleOf(entry.textCard, entry.region) };
    const blocks = promptsIn.get(entry.region);
    if (!blocks || blocks.size < 2) {
      return { card: entry.region, title: titleOf(entry.region, entry.region) };
    }
    if (entry.textCard !== entry.region) {
      const own = titleOf(entry.textCard, entry.region);
      if (names(own) || namesSomeApp(own)) return { card: entry.textCard, title: own };
    }
    return { card: entry.region, title: titleOf(entry.region, entry.region, [...blocks]) };
  };

  const byCard = new Map<
    Element,
    { region: Element; title: string; best: Element; rank: number; label: string }
  >();
  for (const entry of entries) {
    if (entry.kind !== "accepted") continue;
    const { card, title } = cardOfEntry(entry);
    const current = byCard.get(card);
    if (!current || entry.rank < current.rank) {
      byCard.set(card, {
        region: entry.region,
        title,
        best: entry.button,
        rank: entry.rank,
        label: entry.label,
      });
    }
  }
  const cards: AppApprovalCard[] = [];
  const buttons: Element[] = [];
  for (const [card, { title, best, rank, label: bestLabel }] of byCard.entries()) {
    // The title is the first candidate present; a later line naming the app does not count.
    const text = textOf(card, `${BUTTON}, ${PROSE}, ${USER}`);
    buttons.push(best);
    cards.push({
      key: `${title}\n${text}`.slice(0, 400),
      app: names(title),
      title: title.slice(0, 200),
      toolText: text.slice(0, 500),
      button: { label: bestLabel, rank, index: buttons.length - 1 },
      subject: subjectFor(card, best),
    });
  }

  const takenCards = Array.from(byCard.keys());
  const related = (a: Element, b: Element) => a === b || a.contains(b) || b.contains(a);

  // Approval prompts that are in the page but not shown. ChatGPT has left a pending prompt
  // hidden (or never rendered it) while its server waited for the answer; a reload renders it.
  // Found by the approval-surface marker, a class that names an approval card, or an alert or
  // dialog that asks "Allow ChatGPT to use <app>?"; text is read whether it renders or not.
  const SURFACE = '[data-codex-approval-surface="true"], [class*="approval-card"]';
  const QUESTIONS = [
    /\ballow\s+chatgpt\s+to\s+use\s+\S.*\?/i,
    /chatgpt\s*가\s*\S.*?(?:을\(를\)|를\(을\)|을|를)\s*사용하도록/i,
  ];
  const rawLines = (root: Element): string[] => {
    const lines: string[] = [""];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        lines[lines.length - 1] += node.nodeValue ?? "";
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (
        element !== root &&
        element.matches(`${BUTTON}, ${NOT_LABEL}, ${ARGUMENTS}, script, style`)
      ) {
        return;
      }
      const block = element !== root && BLOCK_TAGS.test(element.tagName);
      if (block) lines.push("");
      for (const child of Array.from(element.childNodes)) walk(child);
      if (block) lines.push("");
    };
    walk(root);
    return lines.map((line) => normalize(line)).filter(Boolean);
  };
  /** A button's label from its text whether it renders or not (no computed styles). */
  const rawLabel = (button: Element): string => {
    const parts: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (element !== button && element.matches(NOT_LABEL)) return;
      for (const child of Array.from(element.childNodes)) walk(child);
    };
    walk(button);
    return (
      withoutShortcut(normalize(parts.join(""))) || normalize(button.getAttribute("aria-label"))
    );
  };
  const asksForApp = (role: Element): boolean =>
    rawLines(role).some((line) => QUESTIONS.some((question) => question.test(line)));
  const surfaces = [
    ...Array.from(doc.querySelectorAll(SURFACE)),
    ...Array.from(doc.querySelectorAll(ROLE_CARD)).filter(
      // A chat surface (the chat frame holds the whole thread) is never read for its question.
      (role) => !role.matches(SURFACE) && !chatSurface(role) && asksForApp(role),
    ),
  ].filter((surface) => {
    if (chatSurface(surface)) return false;
    for (let node: Element | null = surface; node; node = node.parentElement) {
      if (node.matches(USER) || node.matches(EDITABLE)) return false;
    }
    return true;
  });
  const hidden: AppApprovalHidden[] = [];
  const hiddenSurfaces: Element[] = [];
  for (const surface of surfaces) {
    // The outermost surface speaks for the ones inside it (the card's text-only alert).
    if (surfaces.some((other) => other !== surface && other.contains(surface))) continue;
    if (takenCards.some((card) => related(card, surface))) continue;
    const allowButtons = Array.from(surface.querySelectorAll(BUTTON)).filter(
      (button) => enabled(button) && rankOf(button, rawLabel(button)) >= 0,
    );
    // A shown allow button is the scan's own business above (taken, or reported as a skip).
    if (allowButtons.some(shown)) continue;
    const surfaceState = hiddenState(surface, true);
    // A shown surface without allow buttons (an answered prompt) is not hidden.
    if (!surfaceState && allowButtons.length === 0) continue;
    const lines = rawLines(surface);
    const title =
      lines.find((line) => QUESTIONS.some((question) => question.test(line))) ??
      lines[0] ??
      normalize(surface.getAttribute("aria-label"));
    const app = names(title);
    if (!app) continue;
    const state =
      surfaceState ||
      (allowButtons[0] ? hiddenState(allowButtons[0], true) : "") ||
      "its allow buttons are not shown";
    hiddenSurfaces.push(surface);
    hidden.push({
      app,
      title: title.slice(0, 200),
      state,
      pending: allowButtons.length > 0,
      subject: subjectFor(surface, allowButtons[0] ?? surface),
    });
  }

  const skipped: AppApprovalSkip[] = [...placeSkips];
  // Role cards with no allow button: reported when their title names an allowed app (its
  // buttons were renamed, e.g. "Continue") or when one of them looks like an allow button.
  const takenRegions = new Set(
    entries.filter((entry) => entry.role && entry.kind === "accepted").map((entry) => entry.region),
  );
  // A role element inside a taken card (the approval card's text-only alert) is part of it.
  for (const role of Array.from(doc.querySelectorAll(ROLE_CARD))) {
    if (takenRegions.has(role) || !visible(role) || chatSurface(role)) continue;
    if (takenCards.some((card) => card !== role && card.contains(role))) continue;
    // A prompt that is in the page but hidden is reported as hidden, not as a card.
    if (hiddenSurfaces.some((surface) => related(surface, role))) continue;
    let placeable = true;
    for (let node: Element | null = role; node; node = node.parentElement) {
      if (node.matches(USER) || node.matches(EDITABLE)) placeable = false;
    }
    if (!placeable) continue;
    const own = Array.from(role.querySelectorAll(BUTTON)).filter(
      (button) => button.closest(ROLE_CARD) === role && shown(button) && enabled(button),
    );
    // An allowed app's prompt with no enabled button at all is reported too: its controls may be
    // links or plain elements now, and the diagnostic shows which.
    const labels = own.map((button) => label(button));
    const title = titlesOf(role, role)[0] ?? "";
    const app = names(title);
    if (!app && !labels.some(allowLike)) continue;
    skipped.push({
      reason: "label",
      labels,
      title: title.slice(0, 200),
      app,
      detail: "",
      subject: subjectFor(role, own[0] ?? role),
    });
  }
  // Every other card that is not taken, one report each: one with an allow-looking button that
  // is not in the list, or an allowed app's prompt (by its title) whose buttons are all unknown.
  const untaken = new Map<
    Element,
    { title: string; labels: string[]; unknown: boolean; button: Element }
  >();
  for (const entry of entries) {
    if (entry.kind === "accepted") continue;
    // A role element nothing was taken from is reported whole above.
    if (entry.role && !takenRegions.has(entry.region)) continue;
    const { card, title } = cardOfEntry(entry);
    if (byCard.has(card)) continue;
    const group = untaken.get(card) ?? { title, labels: [], unknown: false, button: entry.button };
    if (!group.labels.includes(entry.label)) group.labels.push(entry.label);
    group.unknown ||= entry.kind === "unknown";
    untaken.set(card, group);
  }
  for (const [card, { title, labels, unknown, button }] of untaken.entries()) {
    const app = names(title);
    if (!unknown && !app) continue;
    skipped.push({
      reason: "label",
      labels,
      title: title.slice(0, 200),
      app,
      detail: "",
      subject: subjectFor(card, button),
    });
  }
  return { cards, buttons, skipped, hidden, subjects, labelOf: label };
}

export function buildAppApprovalScanExpression(
  allowApps: readonly string[],
  token: string,
): string {
  return `(() => {
    const scan = ${scanAppApprovalCards.toString()};
    const { cards, buttons, skipped, hidden, subjects, labelOf } = scan(document, ${JSON.stringify(allowApps)}, ${JSON.stringify(APP_APPROVAL_VOCABULARY)});
    window.__oracleApprovalButtons = { token: ${JSON.stringify(token)}, nodes: buttons, subjects, labelOf };
    // A card's identity across polls, kept beside the page (the DOM is never marked).
    // Per document: a reload gives the page a new token, so its numbers start again unmistaken.
    const ids = window.__oracleApprovalIds || (window.__oracleApprovalIds = {
      map: new WeakMap(),
      next: 1,
      page: globalThis.crypto?.randomUUID?.() ?? (Math.random().toString(36).slice(2) + Date.now().toString(36)),
    });
    const idOf = (node) => {
      let id = ids.map.get(node);
      if (id === undefined) { id = ids.page + ':' + ids.next++; ids.map.set(node, id); }
      return id;
    };
    return {
      cards: cards.map((card) => ({ ...card, id: idOf(subjects[card.subject]) })),
      skipped: skipped.map((skip) => ({ ...skip, id: idOf(subjects[skip.subject]) })),
      hidden: hidden.map((surface) => ({ ...surface, id: idOf(subjects[surface.subject]) })),
    };
  })()`;
}

/**
 * Reads what a diagnostic file needs about subject `subject` of the scan stored under `token`:
 * its outerHTML (cut at about 30 KB), its buttons and its ancestors up to body. Null when the
 * element is gone.
 */
export function buildAppApprovalDiagnosticExpression(token: string, subject: number): string {
  return `(() => {
    const store = window.__oracleApprovalButtons;
    if (!store || store.token !== ${JSON.stringify(token)}) return null;
    const node = store.subjects?.[${subject}];
    if (!node || !node.isConnected) return null;
    const ancestors = [];
    for (let current = node; current; current = current.parentElement) {
      ancestors.push({
        tag: String(current.tagName || '').toLowerCase(),
        id: current.getAttribute('id') || '',
        className: current.getAttribute('class') || '',
        role: current.getAttribute('role') || '',
        testId: current.getAttribute('data-testid') || '',
      });
      if (current === document.body) break;
    }
    // The scan picks card-sized subjects; this is the last guard that a file never holds the
    // page's main area, the composer or the conversation.
    const wide = node.matches('html, body, main') || Boolean(node.querySelector(${JSON.stringify(DIAGNOSTIC_WIDE_SELECTOR)}));
    if (wide) return { url: location.href, html: '', htmlLength: 0, ancestors, buttons: [], withheld: true };
    const buttons = Array.from(node.querySelectorAll('button, [role="button"]')).map((button) => ({
      label: typeof store.labelOf === 'function' ? store.labelOf(button) : '',
      text: String(button.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      ariaLabel: button.getAttribute('aria-label'),
      disabled: button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true',
    }));
    const html = String(node.outerHTML || '');
    return { url: location.href, html: html.slice(0, ${DIAGNOSTIC_HTML_CHARS}), htmlLength: html.length, ancestors, buttons };
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

/** Scrolls the card remembered under `token` (or else its button) to the end of the view. */
export function buildAppApprovalScrollToEndExpression(
  token: string,
  card: Pick<AppApprovalCard, "button" | "subject">,
): string {
  return `(() => {
    const store = window.__oracleApprovalButtons;
    if (!store || store.token !== ${JSON.stringify(token)}) return false;
    const node = store.subjects?.[${card.subject ?? -1}] ?? store.nodes?.[${card.button.index}] ?? null;
    if (!node || !node.isConnected) return false;
    node.scrollIntoView({ block: 'end', inline: 'nearest' });
    return true;
  })()`;
}

/**
 * Last resort for a button that trusted clicks cannot reach (covered or moving): click() from
 * inside the page, on the button only while a fresh scan verifies it as the same app's allow
 * button.
 */
export function buildAppApprovalInPageClickExpression(
  allowApps: readonly string[],
  token: string,
  card: Pick<AppApprovalCard, "app" | "button">,
): string {
  return `(() => {
    const locate = ${buildAppApprovalLocate(allowApps, token, card)};
    const target = locate();
    if (!target) return { status: 'missing' };
    if (target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true') return { status: 'disabled' };
    // Never a button the user cannot see, even one the scan still takes (skipped off-screen).
    if (typeof target.checkVisibility === 'function' && !target.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return { status: 'hidden' };
    if (typeof target.click === 'function') target.click();
    else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { status: 'clicked' };
  })()`;
}

export interface AppApprovalMonitorOptions {
  allowApps: readonly string[];
  logger: BrowserLogger;
  intervalMs?: number;
  onApproval?: (record: BrowserAppApprovalRecord) => void | Promise<void>;
  /**
   * Saves a diagnostic of a card that was not taken or whose click did not happen, once per card
   * (the run writes it into its session directory). Returns where it went, if anywhere.
   */
  saveDiagnostic?: (diagnostic: AppApprovalDiagnostic) => Promise<string | undefined | void>;
  /** Run-level set of stop functions, so the run's cleanup can stop a monitor it raced past. */
  registry?: Set<() => Promise<void>>;
  /**
   * Told on every poll while an allowed app's pending prompt has stayed hidden for
   * `hiddenSettleMs`; the response wait reloads the conversation so the prompt renders.
   */
  onHiddenSurface?: (surface: AppApprovalHidden) => void;
  /** How long a prompt must stay hidden before it counts (a card may mount hidden and fade in). */
  hiddenSettleMs?: number;
  /**
   * Shared with the run's conversation reloads: each poll (its scan and its clicks) holds the page,
   * so a reload waits for a click in flight and no click starts during a reload; the next poll
   * reads the new document.
   */
  gate?: { exclusive<T>(action: () => Promise<T>): Promise<T> };
  /**
   * How long one page call of a check may go unanswered before the check counts as frozen and is
   * given up (default 60 s, see POLL_FROZEN_MS).
   */
  frozenMs?: number;
  /** When the run's time for the answer is spent: stop() never waits past it for a check. */
  deadline?: () => number;
}

const HIDDEN_SETTLE_MS = 5_000;

const quote = (labels: readonly string[]) =>
  labels.map((label) => `"${label.slice(0, 80)}"`).join(", ") || "(no label)";

/** The log line for a button or prompt the scan does not take. */
export function describeAppApprovalSkip(skip: AppApprovalSkip): string {
  const card = skip.title ? ` in "${skip.title.slice(0, 160)}"` : "";
  if (skip.reason === "excluded") {
    return `[browser] App approval left for the user: ${quote(skip.labels)} sits inside ${skip.detail || "an excluded place"}, where approval cards are not taken from.`;
  }
  if (skip.reason === "no-card") {
    return `[browser] App approval left for the user: ${quote(skip.labels)} has no card around it.`;
  }
  if (skip.labels.length === 0) {
    return `[browser] App approval left for the user: "${skip.title.slice(0, 160)}" shows no enabled button Oracle can click.`;
  }
  return `[browser] App approval left for the user: no known allow label among ${quote(skip.labels)}${card}.`;
}

// Unref'd so a monitor can never keep the process alive on its own.
const idle = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

const RECLICK_AFTER_MS = 3_000;
/**
 * A check's page call (a scan, a click's measurement or its input events) normally answers in
 * milliseconds and even a busy ChatGPT page answers within a few seconds; one minute without an
 * answer is a renderer that stopped (an endless script), not a slow page.
 */
const POLL_FROZEN_MS = 60_000;

/** A check whose page call got no answer for the frozen time. */
class ApprovalCheckFrozen extends Error {}
/** A call of a check that was given up (frozen, or past the run's time at stop). */
class ApprovalCheckAbandoned extends Error {}

/**
 * Watches the tab for tool-permission prompts of the allowed apps and approves them with a
 * guarded trusted click. Cards that name no allowed app are left for the user (logged once).
 * Returns a stop function that waits for an in-flight poll.
 */
export function startAppApprovalMonitor(
  pageRuntime: ChromeClient["Runtime"],
  pageInput: ChromeClient["Input"] | undefined,
  options: AppApprovalMonitorOptions,
): () => Promise<void> {
  const allowApps = options.allowApps.map((app) => app.trim()).filter(Boolean);
  if (allowApps.length === 0) return async () => {};
  const intervalMs = Math.max(250, options.intervalMs ?? 1_500);
  const frozenMs = Math.max(1, options.frozenMs ?? POLL_FROZEN_MS);
  // The page as one check sees it: every call is watched (see pollOnce).
  let runtime = pageRuntime;
  let input = pageInput;
  // The check in flight; aborting it makes its pending and later calls reject without sending.
  let current: AbortController | null = null;
  // Each distinct outcome is logged once per card, and again only when it changes.
  const reported = new Set<string>();
  const diagnosed = new Set<string>();
  const lastClick = new Map<string, number>();
  const failures = new Map<string, { attempts: number; outcome: string }>();
  const reportedErrors = new Set<string>();
  // Cards this monitor approved: a card that stays in the page hidden afterwards is answered.
  const approved = new Set<string>();
  const hiddenSince = new Map<string, number>();
  const hiddenSettleMs = Math.max(0, options.hiddenSettleMs ?? HIDDEN_SETTLE_MS);
  let stopped = false;

  const reportOnce = (key: string, line: string): boolean => {
    if (reported.has(key)) return false;
    reported.add(key);
    options.logger(line);
    return true;
  };
  // A diagnostic never stops the watch: failures to read or save it are logged and dropped.
  const diagnose = async (
    cardKey: string,
    reason: string,
    token: string,
    subject: number | undefined,
  ): Promise<void> => {
    if (!options.saveDiagnostic || diagnosed.has(cardKey)) return;
    diagnosed.add(cardKey);
    try {
      let page: AppApprovalDiagnosticPage | null = null;
      if (typeof subject === "number") {
        const evaluated = await runtime.evaluate({
          expression: buildAppApprovalDiagnosticExpression(token, subject),
          returnByValue: true,
        });
        page = (evaluated?.result?.value as AppApprovalDiagnosticPage | null | undefined) ?? null;
      }
      const saved = await options.saveDiagnostic({
        reason,
        capturedAt: new Date().toISOString(),
        page,
      });
      if (saved) options.logger(`[browser] App approval diagnostic saved: ${saved}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger(`[browser] App approval diagnostic could not be saved: ${message}`);
    }
  };

  /** A trusted click on the card's button; a click the guard cancelled counts as not happened. */
  const tryTrustedClick = async (
    card: AppApprovalCard,
    token: string,
    scrollBlock: "center" | "end" = "center",
  ): Promise<GuardedTrustedClickResult | { status: "cancelled"; detail: string }> => {
    try {
      return await guardedTrustedClick(runtime, input, {
        locate: buildAppApprovalLocate(allowApps, token, card),
        stage: "app-approval",
        target: `The "${card.button.label}" button for ${card.app}`,
        settleTimeoutMs: 1_500,
        scrollBlock,
      });
    } catch (error) {
      if (
        error instanceof BrowserAutomationError &&
        error.details?.code === "trusted-click-cancelled"
      ) {
        return { status: "cancelled", detail: "the button moved or was covered at delivery" };
      }
      throw error;
    }
  };

  const poll = async (): Promise<void> => {
    const token = randomUUID();
    const evaluated = await runtime.evaluate({
      expression: buildAppApprovalScanExpression(allowApps, token),
      returnByValue: true,
    });
    if (evaluated?.exceptionDetails) {
      const details = evaluated.exceptionDetails;
      throw new Error(
        `the page scan threw: ${details.exception?.description ?? details.text ?? "unknown error"}`,
      );
    }
    const value = evaluated?.result?.value as
      | AppApprovalCard[]
      | { cards?: AppApprovalCard[]; skipped?: AppApprovalSkip[]; hidden?: AppApprovalHidden[] }
      | undefined;
    const cards = Array.isArray(value) ? value : Array.isArray(value?.cards) ? value.cards : [];
    const skipped = !Array.isArray(value) && Array.isArray(value?.skipped) ? value.skipped : [];
    const hidden = !Array.isArray(value) && Array.isArray(value?.hidden) ? value.hidden : [];
    // A hidden prompt is never clicked. Once it has stayed hidden for a moment it is reported
    // once (with a diagnostic) and, while it waits for an answer, the run is told so it can
    // reload the conversation, after which the prompt renders and is taken as usual.
    const hiddenNow = new Set<string>();
    for (const surface of hidden) {
      const identity = surface.id !== undefined ? `card:${surface.id}` : `hidden\n${surface.title}`;
      if (approved.has(identity)) continue;
      hiddenNow.add(identity);
      const since = hiddenSince.get(identity) ?? Date.now();
      hiddenSince.set(identity, since);
      if (Date.now() - since < hiddenSettleMs) continue;
      const title = surface.title.slice(0, 160);
      const line = !surface.pending
        ? `[browser] App approval for ${surface.app} is in the page but hidden (${surface.state}) and shows no allow button: "${title}".`
        : options.onHiddenSurface
          ? `[browser] App approval for ${surface.app} is in the page but hidden (${surface.state}): "${title}". Hidden buttons are never clicked; the conversation will be reloaded so it renders.`
          : `[browser] App approval for ${surface.app} is in the page but hidden (${surface.state}): "${title}". Hidden buttons are never clicked; left for the user.`;
      if (reportOnce(`${identity}\nhidden\n${surface.state}\n${surface.pending}`, line)) {
        await diagnose(`${identity}\nhidden`, line, token, surface.subject);
      }
      if (surface.pending) options.onHiddenSurface?.(surface);
    }
    for (const key of hiddenSince.keys()) if (!hiddenNow.has(key)) hiddenSince.delete(key);
    // Cards are told apart by their identity in the page (two cards with the same text, or two
    // places with no title, stay two); without one, by their text.
    const cardIdentity = (card: AppApprovalCard) =>
      card.id !== undefined ? `card:${card.id}` : card.key;
    const skipIdentity = (skip: AppApprovalSkip) =>
      skip.id !== undefined ? `card:${skip.id}` : `skip\n${skip.title}\n${skip.labels.join("\n")}`;
    const visibleKeys = new Set(cards.map(cardIdentity));
    for (const key of lastClick.keys()) if (!visibleKeys.has(key)) lastClick.delete(key);
    for (const key of failures.keys()) if (!visibleKeys.has(key)) failures.delete(key);
    for (const skip of skipped) {
      const identity = skipIdentity(skip);
      const line = describeAppApprovalSkip(skip);
      const outcome = `${skip.reason}\n${skip.detail}\n${skip.labels.join("\n")}`;
      if (reportOnce(`${identity}\n${outcome}`, line)) {
        await diagnose(identity, line, token, skip.subject);
      }
    }
    for (const card of cards) {
      const identity = cardIdentity(card);
      if (!card.app) {
        const line = `[browser] App approval for "${(card.title || card.toolText).slice(0, 160)}" left for the user (its title names no app in --browser-allow-app).`;
        if (reportOnce(`${identity}\ntitle\n${card.title}`, line)) {
          await diagnose(identity, line, token, card.subject);
        }
        continue;
      }
      const previous = lastClick.get(identity);
      if (previous !== undefined && Date.now() - previous < RECLICK_AFTER_MS) continue;
      if (previous !== undefined) {
        options.logger(
          `[browser] App approval for ${card.app} is still shown; clicking "${card.button.label}" again.`,
        );
      }
      lastClick.set(identity, Date.now());
      const first = await tryTrustedClick(card, token);
      let method: NonNullable<BrowserAppApprovalRecord["method"]> | null =
        first.status === "clicked" ? first.method : null;
      let how = method === "synthetic" ? "synthetic click" : "trusted click";
      if (first.status !== "clicked") {
        const state = failures.get(identity) ?? { attempts: 0, outcome: "" };
        state.attempts += 1;
        failures.set(identity, state);
        const outcome = `${first.status}${first.detail ? `: ${first.detail}` : ""}`;
        if (outcome !== state.outcome || state.attempts % 10 === 0) {
          const line = `[browser] App approval for ${card.app}: the "${card.button.label}" click did not happen (${outcome}; attempt ${state.attempts}); will retry.`;
          options.logger(line);
          await diagnose(identity, line, token, card.subject);
        }
        state.outcome = outcome;
        // Every third miss in a row: the card goes to the end of the view (a thread that keeps
        // itself at the bottom lets it stay there) for one more trusted click, and then the
        // button that a fresh scan verifies again is clicked from inside the page.
        if (state.attempts % 3 === 0) {
          options.logger(
            `[browser] App approval for ${card.app}: ${state.attempts} clicks on "${card.button.label}" did not happen; scrolling the card to the end of the view for one more.`,
          );
          await runtime
            .evaluate({
              expression: buildAppApprovalScrollToEndExpression(token, card),
              returnByValue: true,
            })
            .catch(() => undefined);
          const retried = await tryTrustedClick(card, token, "end");
          if (retried.status === "clicked") {
            method = retried.method;
            how = `${retried.method === "synthetic" ? "synthetic" : "trusted"} click after scrolling to the end`;
          } else {
            const evaluated = await runtime.evaluate({
              expression: buildAppApprovalInPageClickExpression(allowApps, token, card),
              returnByValue: true,
            });
            const inPage = evaluated?.result?.value as { status?: string } | undefined;
            if (inPage?.status === "clicked") {
              method = "in-page-click";
              how = "in-page click()";
            } else {
              options.logger(
                `[browser] App approval for ${card.app}: the scrolled click did not happen either (${retried.status}${retried.detail ? `: ${retried.detail}` : ""}), and the in-page click found no verified "${card.button.label}" button (${inPage?.status ?? "no answer"}); will retry.`,
              );
            }
          }
        }
      }
      if (!method) {
        lastClick.delete(identity);
        continue;
      }
      failures.delete(identity);
      approved.add(identity);
      const record: BrowserAppApprovalRecord = {
        app: card.app,
        button: card.button.label,
        toolText: card.toolText,
        approvedAt: new Date().toISOString(),
        method,
      };
      options.logger(
        `[browser] App approval: ${record.app} approved ("${record.button}") by ${how} at ${record.approvedAt}: ${record.toolText.slice(0, 200)}`,
      );
      await options.onApproval?.(record);
    }
  };

  /**
   * `start` (one page call of a check) raced against the frozen time: unanswered by then, the
   * whole check is given up (`abort`), so none of its calls answers into it and none of its later
   * calls is sent: a late answer never leads to a click.
   */
  const watched =
    (abort: AbortController) =>
    <T>(start: () => Promise<T>): Promise<T> => {
      if (abort.signal.aborted) return Promise.reject(new ApprovalCheckAbandoned("given up"));
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new ApprovalCheckAbandoned("given up"));
        };
        const timer = setTimeout(() => {
          abort.signal.removeEventListener("abort", onAbort);
          abort.abort();
          reject(new ApprovalCheckFrozen(`no answer for ${Math.round(frozenMs / 1000)}s`));
        }, frozenMs);
        timer.unref?.();
        abort.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(start)
          .then(
            (value) => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (error: unknown) => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
      });
    };

  /** One check with its own watch: a frozen one gives the page (the gate) back when given up. */
  const pollOnce = async (): Promise<void> => {
    if (stopped) return;
    const abort = new AbortController();
    current = abort;
    const call = watched(abort);
    runtime = {
      evaluate: (params: Parameters<ChromeClient["Runtime"]["evaluate"]>[0]) =>
        call(() => pageRuntime.evaluate(params)),
    } as ChromeClient["Runtime"];
    input = pageInput
      ? ({
          dispatchMouseEvent: (
            params: Parameters<ChromeClient["Input"]["dispatchMouseEvent"]>[0],
          ) => call(() => pageInput.dispatchMouseEvent(params)),
        } as ChromeClient["Input"])
      : undefined;
    try {
      await poll();
    } finally {
      if (current === abort) current = null;
    }
  };

  /** After a frozen check: waits for the page to answer at all, without holding the page. */
  const pageAnswers = async (): Promise<void> => {
    const abort = new AbortController();
    current = abort;
    try {
      await watched(abort)(() => pageRuntime.evaluate({ expression: "1", returnByValue: true }));
    } finally {
      if (current === abort) current = null;
    }
  };

  let silent = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        if (silent) {
          await pageAnswers();
          silent = false;
          options.logger("[browser] App approval check: the page answers again.");
        }
        await (options.gate ? options.gate.exclusive(pollOnce) : pollOnce());
      } catch (error) {
        if (error instanceof ApprovalCheckFrozen) {
          if (!silent) {
            options.logger(
              `[browser] App approval check got no answer from the page for ${Math.round(frozenMs / 1000)}s; it is given up (it never clicks) and the page is checked again.`,
            );
          }
          silent = true;
        } else if (!(error instanceof ApprovalCheckAbandoned)) {
          const message = error instanceof Error ? error.message : String(error);
          if (!reportedErrors.has(message)) {
            reportedErrors.add(message);
            options.logger(`[browser] App approval check failed (will keep watching): ${message}`);
          }
        }
      }
      if (stopped) break;
      await idle(intervalMs);
    }
  })();

  const stop = async () => {
    stopped = true;
    options.registry?.delete(stop);
    const until = options.deadline?.();
    if (until === undefined || !Number.isFinite(until)) {
      // A frozen check is given up within the frozen time, so this ends too.
      await loop.catch(() => undefined);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      loop.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, until - Date.now()));
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    // Past the run's time a check still running is given up: it never sends anything again.
    current?.abort();
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
