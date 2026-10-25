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
}

export interface AppApprovalDiagnostic {
  /** The log line it belongs to. */
  reason: string;
  capturedAt: string;
  /** Null when the card was gone before it could be read. */
  page: AppApprovalDiagnosticPage | null;
}

const DIAGNOSTIC_HTML_CHARS = 30_000;

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
    ...vocabulary.allowLike,
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
      if (node.matches(OFF_LIMITS) || node.matches(PAGE_CHROME)) {
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
  const enabled = (button: Element): boolean =>
    !button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true";
  const subjects: Element[] = [];
  const subjectOf = (element: Element): number => {
    const index = subjects.indexOf(element);
    if (index >= 0) return index;
    subjects.push(element);
    return subjects.length - 1;
  };
  const skipped: AppApprovalSkip[] = [];
  // Allow-looking buttons outside any role card whose label is not in the list; reported below
  // unless their card is taken through another button.
  const unknown: Array<{ label: string; region: Element; textCard: Element }> = [];
  const candidates: Candidate[] = [];
  for (const button of Array.from(doc.querySelectorAll(BUTTON))) {
    if (!mayAllow(button) || !visible(button) || !enabled(button)) continue;
    const text = label(button);
    const rank = rankOf(button, text);
    if (rank < 0 && !allowLike(text)) continue;
    const { region, role, excludedBy } = placeOf(button);
    if (!region) {
      const around = roleCardOf(button) ?? cardOf(button, doc.body) ?? button;
      skipped.push({
        reason: excludedBy ? "excluded" : "no-card",
        labels: [text],
        title: "",
        app: null,
        detail: excludedBy ? describe(excludedBy) : "",
        subject: subjectOf(around),
      });
      continue;
    }
    // The nearest ancestor with text of its own; a role card counts even with only a label.
    const textCard = cardOf(button, region) ?? (role ? region : null);
    if (!textCard) {
      skipped.push({
        reason: "no-card",
        labels: [text],
        title: "",
        app: null,
        detail: "",
        subject: subjectOf(button.parentElement ?? button),
      });
      continue;
    }
    if (rank < 0) {
      // Role cards are reported whole by the pass over role cards below.
      if (!role) unknown.push({ label: text, region, textCard });
      continue;
    }
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
      subject: subjectOf(card),
    });
  }
  // Role cards with no allow button: reported when their title names an allowed app (its
  // buttons were renamed, e.g. "Continue") or when one of them looks like an allow button.
  const takenRegions = new Set(
    candidates.filter((entry) => entry.role).map((entry) => entry.region),
  );
  for (const role of Array.from(doc.querySelectorAll(ROLE_CARD))) {
    if (takenRegions.has(role) || !visible(role) || role.querySelector(EDITABLE)) continue;
    let placeable = true;
    for (let node: Element | null = role; node; node = node.parentElement) {
      if (node.matches(USER) || node.matches(EDITABLE)) placeable = false;
    }
    if (!placeable) continue;
    const own = Array.from(role.querySelectorAll(BUTTON)).filter(
      (button) => button.closest(ROLE_CARD) === role && visible(button) && enabled(button),
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
      subject: subjectOf(role),
    });
  }
  for (const { label: text, region, textCard } of unknown) {
    if (byCard.has(textCard)) continue;
    const title = titlesOf(textCard, region)[0] ?? "";
    skipped.push({
      reason: "label",
      labels: [text],
      title: title.slice(0, 200),
      app: names(title),
      detail: "",
      subject: subjectOf(textCard),
    });
  }
  return { cards, buttons, skipped, subjects, labelOf: label };
}

export function buildAppApprovalScanExpression(
  allowApps: readonly string[],
  token: string,
): string {
  return `(() => {
    const scan = ${scanAppApprovalCards.toString()};
    const { cards, buttons, skipped, subjects, labelOf } = scan(document, ${JSON.stringify(allowApps)}, ${JSON.stringify(APP_APPROVAL_VOCABULARY)});
    window.__oracleApprovalButtons = { token: ${JSON.stringify(token)}, nodes: buttons, subjects, labelOf };
    return { cards, skipped };
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
}

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
  // Each distinct outcome is logged once per card, and again only when it changes.
  const reported = new Set<string>();
  const diagnosed = new Set<string>();
  const lastClick = new Map<string, number>();
  const failures = new Map<string, { attempts: number; outcome: string }>();
  const reportedErrors = new Set<string>();
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
      | { cards?: AppApprovalCard[]; skipped?: AppApprovalSkip[] }
      | undefined;
    const cards = Array.isArray(value) ? value : Array.isArray(value?.cards) ? value.cards : [];
    const skipped = !Array.isArray(value) && Array.isArray(value?.skipped) ? value.skipped : [];
    const visibleKeys = new Set(cards.map((card) => card.key));
    for (const key of lastClick.keys()) if (!visibleKeys.has(key)) lastClick.delete(key);
    for (const key of failures.keys()) if (!visibleKeys.has(key)) failures.delete(key);
    for (const skip of skipped) {
      const cardKey = `skip\n${skip.title}\n${skip.labels.join("\n")}`;
      const line = describeAppApprovalSkip(skip);
      if (reportOnce(`${cardKey}\n${skip.reason}\n${skip.detail}`, line)) {
        await diagnose(cardKey, line, token, skip.subject);
      }
    }
    for (const card of cards) {
      if (!card.app) {
        const line = `[browser] App approval for "${(card.title || card.toolText).slice(0, 160)}" left for the user (its title names no app in --browser-allow-app).`;
        if (reportOnce(`${card.key}\ntitle`, line)) {
          await diagnose(card.key, line, token, card.subject);
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
      const first = await tryTrustedClick(card, token);
      let method: NonNullable<BrowserAppApprovalRecord["method"]> | null =
        first.status === "clicked" ? first.method : null;
      let how = method === "synthetic" ? "synthetic click" : "trusted click";
      if (first.status !== "clicked") {
        const state = failures.get(card.key) ?? { attempts: 0, outcome: "" };
        state.attempts += 1;
        failures.set(card.key, state);
        const outcome = `${first.status}${first.detail ? `: ${first.detail}` : ""}`;
        if (outcome !== state.outcome || state.attempts % 10 === 0) {
          const line = `[browser] App approval for ${card.app}: the "${card.button.label}" click did not happen (${outcome}; attempt ${state.attempts}); will retry.`;
          options.logger(line);
          await diagnose(card.key, line, token, card.subject);
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
        lastClick.delete(card.key);
        continue;
      }
      failures.delete(card.key);
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
