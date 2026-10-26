import fs from "node:fs/promises";
import path from "node:path";
import { buildStopButtonVisibilityPredicateJs } from "./actions/assistantResponse.js";
import { resolveSessionArtifactsDir } from "./artifacts.js";
import {
  APPROVAL_CARD_SELECTOR,
  ARGUMENTS_SELECTOR,
  DIALOG_SELECTOR,
  EDITABLE_SELECTOR,
  PAGE_CHROME_SELECTOR,
  PANEL_SELECTOR,
  PROSE_SELECTOR,
  USER_MESSAGE_SELECTOR,
} from "./pageSurfaces.js";
import { USER_TURN_SELECTOR } from "./promptFingerprint.js";

/**
 * ChatGPT's "Connection interrupted. Waiting for the complete answer" banner: the page lost the
 * answer's stream (seen 2026-10-26 on a Pro run whose work had finished; Stop stayed shown until a
 * reload). A fresh load of the conversation fetches the answer from the server, so the turn resync
 * and the --live tail reload as soon as it shows, on their own short backoff while it stays.
 */

/**
 * Before the n-th reload for a banner that is still (or again) there after the last one: none
 * for the first, then 30 s, 1, 2, 4 minutes, and from then on every 8 minutes. A reload costs
 * one page load and the answer is waiting on the server, so the first tries come quickly; the
 * doubling keeps a page that cannot reach chatgpt.com from reloading in a loop, and the 8-minute
 * ceiling (the stall resync's first wait) keeps a banner that stays from waiting an hour between
 * tries. Only the run's time ends it.
 */
export function interruptedBannerRetryMs(reloads: number): number {
  if (reloads <= 0) return 0;
  return Math.min(8 * 60_000, 30_000 * 2 ** Math.min(reloads - 1, 16));
}

export const INTERRUPTED_BANNER_REASON = 'ChatGPT shows "Connection interrupted"';
// It counts once two reads of the page in a row show it: a flicker while an answer streams is not
// a reason to reload.
const BANNER_READS = 2;
// Its backoff starts over once it has been gone this long: right after a reload the page can show
// no banner for a few seconds before it notices the lost stream again.
const BANNER_GONE_MS = 2 * 60_000;

/** When to reload for the banner, from the reads of one page (a run's wait or the --live tail). */
export interface InterruptedBannerTracker {
  /** A read of the page: the banner's text, or null; true on its first sighting here. */
  note(text: string | null, now?: number): boolean;
  /** A reload for it is due: two reads in a row showed it and its backoff has passed. */
  due(now?: number): boolean;
  /** It is shown, or its own reload has not been read yet: a stall reload waits meanwhile. */
  active(): boolean;
  /** A reload for it begins; its log line (the n-th since the banner was last gone). */
  reloading(): string;
  /** A reload of the page ended; for the banner's own, the next one waits its backoff. */
  reloaded(forBanner: boolean, now?: number): void;
}

export function createInterruptedBannerTracker(): InterruptedBannerTracker {
  let reads = 0;
  let reloads = 0;
  let notBefore = 0;
  let goneSince: number | null = null;
  let sighted = false;
  return {
    note(text, now = Date.now()) {
      if (!text) {
        reads = 0;
        goneSince ??= now;
        if (now - goneSince >= BANNER_GONE_MS) {
          // A banner that comes back after that is a new one: reloaded at once.
          reloads = 0;
          notBefore = 0;
        }
        return false;
      }
      goneSince = null;
      reads += 1;
      const first = !sighted;
      sighted = true;
      return first;
    },
    due(now = Date.now()) {
      return reads >= BANNER_READS && now >= notBefore;
    },
    active() {
      return reads > 0 || (reloads > 0 && goneSince === null);
    },
    reloading() {
      reloads += 1;
      return reloads === 1
        ? `[browser] ${INTERRUPTED_BANNER_REASON}; reloading the conversation now`
        : `[browser] ChatGPT still shows "Connection interrupted" after ${reloads - 1} reload${reloads === 2 ? "" : "s"}; reloading the conversation now`;
    },
    reloaded(forBanner, now = Date.now()) {
      // A new page: the banner has to be seen on two of its reads again.
      reads = 0;
      if (forBanner) notBefore = now + interruptedBannerRetryMs(reloads);
    },
  };
}

/** Where on the page the banner may count, as selectors (see readInterruptedBanner). */
export interface InterruptedBannerSurfaces {
  /** The conversation thread (the page's body when none of these is there). */
  thread: string;
  /** User turns: the banner belongs below the latest one. */
  user: string;
  /** What a user or the model wrote. */
  body: string;
  /** Never the banner: those, editors, and surfaces whose text stays across reloads. */
  excluded: string;
  /**
   * A banner's row never holds these: disclosure controls, activity and reasoning surfaces,
   * approval cards, dialogs and page chrome.
   */
  disqualifying: string;
  /** Editors; a form that holds one is the composer. */
  editable: string;
  /** The composer: its own controls (model picker, attachments) are not disclosures of a row. */
  composer: string;
}

const MESSAGE_BODY_SELECTOR = [
  USER_TURN_SELECTOR,
  USER_MESSAGE_SELECTOR,
  "[data-user-message-bubble]",
  PROSE_SELECTOR,
  '[class*="MarkdownRoot"]',
  PANEL_SELECTOR,
  ARGUMENTS_SELECTOR,
  "blockquote",
].join(", ");

const DISQUALIFYING_SELECTOR = [
  "[aria-expanded]",
  "details",
  "summary",
  PANEL_SELECTOR,
  APPROVAL_CARD_SELECTOR,
  DIALOG_SELECTOR,
  PAGE_CHROME_SELECTOR,
  '[role="navigation"]',
].join(", ");

export const INTERRUPTED_BANNER_SURFACES: InterruptedBannerSurfaces = {
  thread: 'main, [role="main"], [data-app-shell-focus-area="main"]',
  user: `${USER_TURN_SELECTOR}, ${USER_MESSAGE_SELECTOR}`,
  body: MESSAGE_BODY_SELECTOR,
  excluded: [
    MESSAGE_BODY_SELECTOR,
    // Page chrome (a conversation titled "Connection interrupted"), approval cards and dialogs,
    // activity rows and disclosures: their text stays across reloads.
    PAGE_CHROME_SELECTOR,
    '[role="navigation"]',
    DIALOG_SELECTOR,
    APPROVAL_CARD_SELECTOR,
    "details",
    "summary",
    "[aria-expanded]",
    EDITABLE_SELECTOR,
    "input",
    "script",
    "style",
    "noscript",
    "template",
  ].join(", "),
  disqualifying: DISQUALIFYING_SELECTOR,
  editable: EDITABLE_SELECTOR,
  composer:
    '[data-testid*="composer" i], [data-composer-overlay-floating-ui], [data-composer-navigation-target]',
};

/**
 * Page function: the banner when it is shown. Its words ("Connection interrupted" or "Waiting for
 * the complete answer", any case, whitespace folded) open the text of a small visible element and
 * of its row, every element around it up to the banner's size or its status region (a sentence
 * or caption that mentions or quotes them, nested spans included, is not the banner), that sits
 * in the conversation
 * thread below the latest user turn, the turn the banner belongs to, and outside anything a user
 * or the model wrote (user turns, Markdown/prose, reasoning panels, code, quotes), editors, and
 * surfaces whose text stays across reloads (sidebar and header, approval cards and dialogs,
 * activity rows and disclosures). A screen-reader-only copy (1 px) is not shown. With
 * `withNode`, the element holding the words is returned too. Injected into the page with
 * Function.prototype.toString, so it stays free of imports and closures.
 */
export function readInterruptedBanner(
  doc: Document,
  surfaces: InterruptedBannerSurfaces,
  withNode = false,
): { text: string; node?: Element } | null {
  const PHRASES = ["connection interrupted", "waiting for the complete answer"];
  const CANDIDATE = /interrupted|waiting for the|complete answer/i;
  const fold = (value: unknown) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const shown = (node: Element) => {
    const rect = node.getBoundingClientRect?.();
    if (!rect || rect.width <= 4 || rect.height <= 4) return false;
    const check = (node as { checkVisibility?: (options: object) => boolean }).checkVisibility;
    return (
      typeof check !== "function" ||
      check.call(node, { visibilityProperty: true, opacityProperty: true })
    );
  };
  const root = doc.querySelector(surfaces.thread) ?? doc.body;
  if (!root || typeof doc.createTreeWalker !== "function") return null;
  const users = root.querySelectorAll(surfaces.user);
  const latestUser = users.length > 0 ? users[users.length - 1]! : null;
  if (!latestUser) return null;
  // 4: Node.DOCUMENT_POSITION_FOLLOWING
  const below = (node: Node) =>
    !latestUser.contains(node) && (latestUser.compareDocumentPosition(node) & 4) !== 0;
  // Whether the banner's words open `folded`: at most one short word (an icon's label such as
  // "Warning:") may come first, and no quote mark. Null when the words are not in it.
  const opens = (folded: string): boolean | null => {
    const at = PHRASES.map((phrase) => folded.indexOf(phrase))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (at === undefined) return null;
    const lead = folded.slice(0, at);
    return lead.length <= 15 && !/["'“”‘’«»([]/.test(lead) && lead.trim().split(" ").length <= 1;
  };
  // Inside the thread, below the latest user turn, and holding no message body.
  const inScope = (node: Element) =>
    node !== root &&
    root.contains(node) &&
    !node.contains(latestUser) &&
    !node.querySelector(surfaces.excluded);
  const REGION = '[role="status"], [role="alert"], [aria-live]';
  const composerControl = (node: Element) =>
    Boolean(node.closest(surfaces.composer)) ||
    Boolean(node.closest("form")?.querySelector(surfaces.editable));
  // A banner's row holds no disclosure control, activity or reasoning surface, approval card or
  // dialog (the composer's own controls do not count): an activity caption with its disclosure
  // button is never the banner. A plain button (Retry) is fine.
  const disqualified = (node: Element) =>
    Array.from(node.querySelectorAll(surfaces.disqualifying)).some(
      (found) => !composerControl(found),
    );
  // Its text without what a user or the model wrote, editors and disclosures.
  const ownText = (node: Element) => {
    let out = "";
    const inner = doc.createTreeWalker(node, 4);
    for (let part = inner.nextNode(); part; part = inner.nextNode()) {
      const skipped = part.parentElement?.closest(surfaces.excluded);
      if (skipped && node.contains(skipped)) continue;
      out += String((part as Text).data ?? "");
    }
    return fold(out);
  };
  // 4: NodeFilter.SHOW_TEXT
  const walker = doc.createTreeWalker(root, 4);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!CANDIDATE.test(String((text as Text).data ?? ""))) continue;
    const parent = text.parentElement;
    if (!parent || !below(parent) || parent.closest(surfaces.excluded) || !shown(parent)) continue;
    // The smallest element around it that holds a whole phrase (it can be split over elements).
    let holder: Element | null = parent;
    for (
      let depth = 0;
      holder && holder !== root && depth < 4;
      depth += 1, holder = holder.parentElement
    ) {
      if (holder !== parent && !inScope(holder)) break;
      const folded = fold(holder.textContent);
      if (folded.length > 300) break;
      const verdict = opens(folded);
      if (verdict === null) continue;
      if (!verdict) break;
      // Its row too: every element around it up to the banner's size (or its status or alert
      // region, the banner's own box) must hold no disclosure or activity surface and, without
      // what a user or the model wrote, open with the words. So a caption that mentions them in
      // nested spans ('Searching for "<span>Connection interrupted</span>"'), with or without its
      // disclosure button next to it, is not the banner. The check is never skipped.
      let row: Element = holder;
      let isBanner = true;
      while (!row.matches(REGION)) {
        const up: Element | null = row.parentElement;
        if (!up || up === root || !root.contains(up) || up.contains(latestUser)) break;
        if (fold(up.textContent).length > 300) break;
        if (disqualified(up) || opens(ownText(up)) === false) {
          isBanner = false;
          break;
        }
        row = up;
      }
      if (!isBanner) break;
      return withNode ? { text: folded, node: holder } : { text: folded };
    }
  }
  return null;
}

/**
 * Page function: the first visible element anywhere in the page whose text holds one of the
 * banner's phrases, message bodies included. Only for the diagnostic: it never decides a reload.
 */
export function findInterruptedPhrase(doc: Document): { node: Element; phrase: string } | null {
  const PHRASES = ["connection interrupted", "waiting for the complete answer"];
  const CANDIDATE = /interrupted|waiting for the|complete answer/i;
  const fold = (value: unknown) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const shown = (node: Element) => {
    const rect = node.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const check = (node as { checkVisibility?: (options: object) => boolean }).checkVisibility;
    return (
      typeof check !== "function" ||
      check.call(node, { visibilityProperty: true, opacityProperty: true })
    );
  };
  const body = doc.body;
  if (!body || typeof doc.createTreeWalker !== "function") return null;
  const walker = doc.createTreeWalker(body, 4);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!CANDIDATE.test(String((text as Text).data ?? ""))) continue;
    const parent = text.parentElement;
    if (!parent || parent.closest("script, style, noscript, template") || !shown(parent)) continue;
    let holder: Element | null = parent;
    for (let depth = 0; holder && depth < 4; depth += 1, holder = holder.parentElement) {
      const folded = fold(holder.textContent);
      const phrase = PHRASES.find((candidate) => folded.includes(candidate));
      if (phrase) return { node: holder, phrase };
    }
  }
  return null;
}

export function buildInterruptedBannerExpression(): string {
  return `((found) => found ? { text: found.text } : null)((${readInterruptedBanner.toString()})(document, ${JSON.stringify(INTERRUPTED_BANNER_SURFACES)}))`;
}

const DIAGNOSTIC_HTML_CHARS = 30_000;
// Markup a diagnostic never holds: the main area, an editor, a conversation turn or a message.
const DIAGNOSTIC_WIDE_SELECTOR =
  'main, [contenteditable="true"], [role="textbox"], textarea, [data-message-author-role], [data-turn], [data-testid^="conversation-turn"], [data-turn-key], [data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-user-message-bubble], .markdown';

interface DiagnosticNode {
  tag: string;
  id: string;
  className: string;
  role: string;
  testId: string;
  ariaLive: string;
}

export interface InterruptedBannerDiagnosticPage {
  url: string;
  /**
   * The banner's text (folded); for words found inside a message, only the phrase, never the
   * message's text.
   */
  text: string;
  /** Whether the reload rule counts it as the banner (readInterruptedBanner). */
  detected: boolean;
  /** Whether it sits inside what a user or the model wrote. */
  insideMessageBody: boolean;
  /** The element holding the text, cut at about 30 KB. */
  bannerHtml: string;
  bannerHtmlLength: number;
  /** For the banner, up to three levels around it that hold no message, editor or main area. */
  html: string;
  htmlLength: number;
  /** The element and its ancestors up to body: tags, ids, classes, roles, test ids. */
  ancestors: DiagnosticNode[];
  /** True when the markup was not saved: it held or sat in a message, an editor or the main area. */
  withheld: boolean;
  /** The run's own stop-control check. */
  stopVisible: boolean;
}

export interface InterruptedBannerDiagnostic {
  reason: string;
  capturedAt: string;
  /** Null when no phrase was shown when it was read. */
  page: InterruptedBannerDiagnosticPage | null;
}

/**
 * Reads the diagnostic of the banner shown now, or else of the banner's words wherever they are
 * visible (message bodies included, their text withheld); null when neither is shown.
 */
export function buildInterruptedBannerDiagnosticExpression(): string {
  return `(() => {
    const surfaces = ${JSON.stringify(INTERRUPTED_BANNER_SURFACES)};
    const detected = (${readInterruptedBanner.toString()})(document, surfaces, true);
    const found = detected && detected.node
      ? { node: detected.node, phrase: null }
      : (${findInterruptedPhrase.toString()})(document);
    if (!found || !found.node) return null;
    const node = found.node;
    const WIDE = ${JSON.stringify(DIAGNOSTIC_WIDE_SELECTOR)};
    const LIMIT = ${DIAGNOSTIC_HTML_CHARS};
    ${buildStopButtonVisibilityPredicateJs("isStopControlVisible")}
    const ancestors = [];
    for (let current = node; current; current = current.parentElement) {
      ancestors.push({
        tag: String(current.tagName || '').toLowerCase(),
        id: current.getAttribute('id') || '',
        className: current.getAttribute('class') || '',
        role: current.getAttribute('role') || '',
        testId: current.getAttribute('data-testid') || '',
        ariaLive: current.getAttribute('aria-live') || '',
      });
      if (current === document.body) break;
    }
    const insideMessageBody = Boolean(node.closest(surfaces.body));
    const wide = (element) => element.matches('html, body') || element.matches(WIDE) || Boolean(element.querySelector(WIDE));
    const withheld = insideMessageBody || wide(node);
    // Around the banner only: the words found elsewhere (a sidebar list, say) are saved alone.
    let subject = node;
    for (let depth = 0; detected && depth < 3; depth += 1) {
      const up = subject.parentElement;
      if (!up || wide(up)) break;
      subject = up;
    }
    const html = withheld || !detected ? '' : String(subject.outerHTML || '');
    const bannerHtml = withheld ? '' : String(node.outerHTML || '');
    const text = detected
      ? detected.text
      : insideMessageBody
        ? found.phrase
        : String(node.textContent || '').toLowerCase().replace(/\\s+/g, ' ').trim().slice(0, 300);
    return {
      url: location.href,
      text,
      detected: Boolean(detected),
      insideMessageBody,
      bannerHtml: bannerHtml.slice(0, LIMIT),
      bannerHtmlLength: bannerHtml.length,
      html: html.slice(0, LIMIT),
      htmlLength: html.length,
      ancestors,
      withheld,
      stopVisible: isStopControlVisible(),
    };
  })()`;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A self-contained, inert page: the banner's markup is shown as text, never rendered. */
export function renderInterruptedBannerDiagnostic(diagnostic: InterruptedBannerDiagnostic): string {
  const page = diagnostic.page;
  const ancestors = (page?.ancestors ?? []).map((node) =>
    [
      node.tag,
      node.id ? `#${node.id}` : "",
      node.className ? ` class="${node.className}"` : "",
      node.role ? ` role="${node.role}"` : "",
      node.testId ? ` data-testid="${node.testId}"` : "",
      node.ariaLive ? ` aria-live="${node.ariaLive}"` : "",
    ].join(""),
  );
  const cut = (shown: number, length: number) => (length > shown ? ", cut" : "");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Oracle "Connection interrupted" diagnostic</title></head><body>',
    `<h1>${escapeHtml(diagnostic.reason)}</h1>`,
    `<p>Captured ${escapeHtml(diagnostic.capturedAt)}${page ? ` on ${escapeHtml(page.url)}` : ""}.</p>`,
    page ? "" : "<p>The banner's words were not shown when the page was read.</p>",
    page
      ? `<p>Matched text: ${escapeHtml(page.text)}. Counted as the banner: ${page.detected ? "yes" : "no"}. Inside a message: ${page.insideMessageBody ? "yes" : "no"}. Stop button shown: ${page.stopVisible ? "yes" : "no"}.</p>`
      : "",
    page?.withheld
      ? "<p>The element held or sat in a message, an editor or the main area, so its markup was not saved.</p>"
      : "",
    "<h2>Ancestors (the element first, up to body)</h2>",
    `<pre>${escapeHtml(ancestors.join("\n"))}</pre>`,
    `<h2>Element outerHTML (${page?.bannerHtmlLength ?? 0} characters${cut(page?.bannerHtml.length ?? 0, page?.bannerHtmlLength ?? 0)})</h2>`,
    `<pre>${escapeHtml(page?.bannerHtml ?? "")}</pre>`,
    `<h2>Surroundings outerHTML (${page?.htmlLength ?? 0} characters${cut(page?.html.length ?? 0, page?.htmlLength ?? 0)})</h2>`,
    `<pre>${escapeHtml(page?.html ?? "")}</pre>`,
    "</body></html>",
    "",
  ].join("\n");
}

const FILE_PATTERN = /^interrupted-banner-diag-(\d+)\.html$/;

/**
 * Writes the diagnostic as `artifacts/interrupted-banner-diag-<n>.html` in the session's
 * directory and returns its path; nothing is written without a session id.
 */
export async function saveInterruptedBannerDiagnostic(
  sessionId: string | undefined,
  diagnostic: InterruptedBannerDiagnostic,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const dir = resolveSessionArtifactsDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const used = (await fs.readdir(dir).catch(() => [] as string[]))
    .map((name) => Number(FILE_PATTERN.exec(name)?.[1] ?? 0))
    .filter((value) => value > 0);
  let next = used.length > 0 ? Math.max(...used) + 1 : 1;
  const contents = renderInterruptedBannerDiagnostic(diagnostic);
  for (;;) {
    const target = path.join(dir, `interrupted-banner-diag-${next}.html`);
    try {
      await fs.writeFile(target, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      next += 1;
    }
  }
}

/**
 * Reads the banner's diagnostic through `evaluate`; null when the page shows none of its words
 * (or cannot be read).
 */
export async function readInterruptedBannerDiagnostic(
  evaluate: (expression: string) => Promise<unknown>,
  reason: string,
): Promise<InterruptedBannerDiagnostic | null> {
  const page = (await evaluate(buildInterruptedBannerDiagnosticExpression()).catch(
    () => null,
  )) as InterruptedBannerDiagnosticPage | null;
  if (!page || typeof page !== "object") return null;
  return { reason, capturedAt: new Date().toISOString(), page };
}
