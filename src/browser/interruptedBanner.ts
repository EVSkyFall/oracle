import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionArtifactsDir } from "./artifacts.js";

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
  /** It is being answered: shown on the last read, or reloaded for and not gone for long. */
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
        if (now - goneSince >= BANNER_GONE_MS) reloads = 0;
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
      return reads > 0 || reloads > 0;
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

/**
 * Page function: the banner when it is shown. Its text ("Connection interrupted" or "Waiting for
 * the complete answer", any case, whitespace folded) counts only on a visible element outside
 * anything a user or the model wrote: user messages, the answer's Markdown/prose, reasoning
 * panels, code, quotes and editors. A screen-reader-only copy (1 px) is not shown. With
 * `withNode`, the element holding the text is returned too. Injected into the page with
 * Function.prototype.toString, so it stays free of imports and closures.
 */
export function readInterruptedBanner(
  doc: Document,
  withNode = false,
): { text: string; node?: Element } | null {
  const PHRASES = ["connection interrupted", "waiting for the complete answer"];
  const CANDIDATE = /interrupted|waiting for the|complete answer/i;
  const CONTENT = [
    ':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"], [data-turn="user"])',
    "[data-user-message-bubble]",
    ".markdown",
    '[class*="markdown"]',
    ".prose",
    '[class*="MarkdownRoot"]',
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
    "pre",
    "code",
    "blockquote",
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
    "textarea",
    "input",
    "script",
    "style",
    "noscript",
    "template",
  ].join(", ");
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
  const body = doc.body;
  if (!body || typeof doc.createTreeWalker !== "function") return null;
  // 4: NodeFilter.SHOW_TEXT
  const walker = doc.createTreeWalker(body, 4);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!CANDIDATE.test(String((text as Text).data ?? ""))) continue;
    const parent = text.parentElement;
    if (!parent || parent.closest(CONTENT) || !shown(parent)) continue;
    // The smallest element around it that holds a whole phrase (it can be split over elements).
    let holder: Element | null = parent;
    for (let depth = 0; holder && depth < 4; depth += 1, holder = holder.parentElement) {
      if (holder !== parent && holder.querySelector(CONTENT)) break;
      const folded = fold(holder.textContent);
      if (folded.length > 300) break;
      if (PHRASES.some((phrase) => folded.includes(phrase))) {
        return withNode ? { text: folded, node: holder } : { text: folded };
      }
    }
  }
  return null;
}

export function buildInterruptedBannerExpression(): string {
  return `((found) => found ? { text: found.text } : null)((${readInterruptedBanner.toString()})(document))`;
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
  /** The banner's text as matched (folded). */
  text: string;
  /** The element holding the text, cut at about 30 KB. */
  bannerHtml: string;
  bannerHtmlLength: number;
  /** Up to three levels around it that hold no message, editor or main area, cut likewise. */
  html: string;
  htmlLength: number;
  /** The banner element and its ancestors up to body. */
  ancestors: DiagnosticNode[];
  /** True when the markup was not saved because it held a message, an editor or the main area. */
  withheld: boolean;
  stopVisible: boolean;
}

export interface InterruptedBannerDiagnostic {
  reason: string;
  capturedAt: string;
  /** Null when the banner was gone before it could be read. */
  page: InterruptedBannerDiagnosticPage | null;
}

/** Reads the diagnostic of the banner shown now (null when none is shown). */
export function buildInterruptedBannerDiagnosticExpression(): string {
  return `(() => {
    const found = (${readInterruptedBanner.toString()})(document, true);
    if (!found || !found.node) return null;
    const WIDE = ${JSON.stringify(DIAGNOSTIC_WIDE_SELECTOR)};
    const LIMIT = ${DIAGNOSTIC_HTML_CHARS};
    const ancestors = [];
    for (let current = found.node; current; current = current.parentElement) {
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
    const wide = (node) => node.matches('html, body') || node.matches(WIDE) || Boolean(node.querySelector(WIDE));
    let subject = found.node;
    for (let depth = 0; depth < 3; depth += 1) {
      const up = subject.parentElement;
      if (!up || wide(up)) break;
      subject = up;
    }
    const withheld = wide(found.node);
    const html = withheld ? '' : String(subject.outerHTML || '');
    const bannerHtml = withheld ? '' : String(found.node.outerHTML || '');
    const stop = document.querySelector('[data-testid="stop-button"]');
    const stopRect = stop && stop.getBoundingClientRect ? stop.getBoundingClientRect() : null;
    return {
      url: location.href,
      text: found.text,
      bannerHtml: bannerHtml.slice(0, LIMIT),
      bannerHtmlLength: bannerHtml.length,
      html: html.slice(0, LIMIT),
      htmlLength: html.length,
      ancestors,
      withheld,
      stopVisible: Boolean(stopRect && stopRect.width > 0 && stopRect.height > 0),
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
    page ? "" : "<p>The banner was gone before it could be read.</p>",
    page
      ? `<p>Matched text: ${escapeHtml(page.text)}. Stop button shown: ${page.stopVisible ? "yes" : "no"}.</p>`
      : "",
    page?.withheld
      ? "<p>The element held a message, an editor or the main area, so its markup was not saved.</p>"
      : "",
    "<h2>Ancestors (the banner first, up to body)</h2>",
    `<pre>${escapeHtml(ancestors.join("\n"))}</pre>`,
    `<h2>Banner outerHTML (${page?.bannerHtmlLength ?? 0} characters${cut(page?.bannerHtml.length ?? 0, page?.bannerHtmlLength ?? 0)})</h2>`,
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
 * Reads the shown banner's diagnostic through `evaluate`; a page that cannot be read gives a
 * diagnostic without a page.
 */
export async function readInterruptedBannerDiagnostic(
  evaluate: (expression: string) => Promise<unknown>,
  reason: string,
): Promise<InterruptedBannerDiagnostic> {
  const page = (await evaluate(buildInterruptedBannerDiagnosticExpression()).catch(
    () => null,
  )) as InterruptedBannerDiagnosticPage | null;
  return {
    reason,
    capturedAt: new Date().toISOString(),
    page: page && typeof page === "object" ? page : null,
  };
}
