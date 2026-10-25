import { randomUUID } from "node:crypto";
import { withoutBrowserCancellation } from "../cancellation.js";
import type { ChromeClient } from "../types.js";
import { INPUT_SELECTORS } from "../constants.js";
import { delay } from "../utils.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import {
  assertComposerNavigationSnapshot,
  assertComposerPlusStayedInPlace,
  buildComposerNavigationProbeExpression,
  buildComposerNavigationValidationExpression,
} from "./attachmentContext.js";
import { buildClickDispatcher } from "./domEvents.js";

/**
 * ChatGPT's composer "+" control. Current layouts expose it only as a composer navigation
 * target (no id, no test id); older layouts used the id/test id, kept as fallbacks.
 */
export const COMPOSER_PLUS_SELECTORS = [
  '[data-composer-navigation-target="add-context"]',
  'button[aria-label^="Add files"]',
  "#composer-plus-btn",
  'button[data-testid="composer-plus-btn"]',
];

/** App and plugin mentions (Deep research, connected apps), by any attribute ChatGPT has used. */
export const COMPOSER_MENTION_SELECTOR = ["app", "plugin"]
  .flatMap((kind) => ["name", "display-name", "path"].map((field) => `[${kind}-mention-${field}]`))
  .join(", ");

/** Tool pills and prompt links (Web search). */
export const COMPOSER_PILL_SELECTOR = [
  "[data-inline-selection-pill]",
  "[data-inline-selection-pill-cursor-target]",
  "[data-system-hint-type]",
  "[data-prompt-link-href]",
  "[data-prompt-link-label]",
].join(", ");

/**
 * Inline editor tokens that are not prompt text: tool pills and app or plugin mentions.
 * Staged-prompt comparisons drop them.
 */
export const COMPOSER_TOKEN_SELECTOR = `${COMPOSER_MENTION_SELECTOR}, ${COMPOSER_PILL_SELECTOR}`;

/**
 * Page function: the names a mention may go by, display names first, then names, then the
 * visible label without its "@"/"$" sigil.
 */
export function readMentionNames(node: Element): string[] {
  const attributes = [
    "app-mention-display-name",
    "plugin-mention-display-name",
    "app-mention-name",
    "plugin-mention-name",
    "data-prompt-link-label",
  ];
  const clean = (value: unknown) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[@$]\s*/, "");
  return [
    ...attributes.map((name) => clean(node.getAttribute(name))),
    clean(node.textContent),
  ].filter((value) => value.length > 0);
}

/** Page function: whether an editor token is the Web search pill (current or legacy markup). */
export function isWebSearchPill(node: Element): boolean {
  const hint = node.getAttribute("data-system-hint-type");
  return (
    hint === "search" ||
    node.getAttribute("data-prompt-link-href") === "chatgpt-system-hint://search" ||
    (hint === null && node.getAttribute("data-id") === "search")
  );
}

/** Page function: whether an editor token is the Deep research mention. */
export function isDeepResearchMention(node: Element): boolean {
  const ids = ["app", "plugin"]
    .flatMap((kind) => [`${kind}-mention-name`, `${kind}-mention-path`])
    .concat(["data-prompt-link-href", "data-prompt-link-label"])
    .map((name) =>
      String(node.getAttribute(name) ?? "")
        .trim()
        .toLowerCase(),
    );
  if (
    ids.some(
      (value) =>
        value === "deep-research" ||
        value === "$deep-research" ||
        value === "app://connector_openai_deep_research",
    )
  ) {
    return true;
  }
  const names = ["app-mention-display-name", "plugin-mention-display-name"]
    .map((name) => node.getAttribute(name))
    .concat(String(node.textContent ?? ""))
    .map((value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[@$]\s*/, "")
        .toLowerCase(),
    );
  return names.some((value) => value === "deep research" || value === "深度研究");
}

/**
 * Reads the editor's prompt text without inline tokens: hard breaks and block boundaries become
 * newlines and ProseMirror's decorative trailing break is ignored. Injected into the page with
 * Function.prototype.toString.
 */
export function readComposerPromptText(
  editor: Element,
  tokenSelector: string,
): { text: string; tokens: number } {
  if (typeof HTMLTextAreaElement !== "undefined" && editor instanceof HTMLTextAreaElement) {
    return { text: editor.value ?? "", tokens: 0 };
  }
  const copy = editor.cloneNode(true) as Element;
  const tokens = Array.from(copy.querySelectorAll(tokenSelector));
  for (const token of tokens) token.remove();
  const isBlock = (node: Node | undefined) => /^(P|DIV|PRE|LI)$/.test(node?.nodeName || "");
  const readText = (node: Node): string => {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeName === "BR") {
      return (node as Element).classList?.contains("ProseMirror-trailingBreak") ? "" : "\n";
    }
    const children = Array.from(node.childNodes || []);
    return children
      .map(
        (child, index) =>
          (index > 0 && (isBlock(child) || isBlock(children[index - 1])) ? "\n" : "") +
          readText(child),
      )
      .join("");
  };
  return { text: readText(copy), tokens: tokens.length };
}

/** Rows of the "+" panel and of the "@" mention picker share this list item. */
export const COMPOSER_PANEL_ROW_SELECTOR = "button[data-list-navigation-item]";
const LEGACY_PANEL_ROOT_SELECTOR =
  'main .popover, [data-radix-popper-content-wrapper], [data-floating-ui-portal], [role="menu"], [role="listbox"]';
const LEGACY_PANEL_ITEM_SELECTOR =
  '[data-radix-collection-item], [role="menuitem"], [role="menuitemradio"], [role="option"], .__menu-item, [class*="menu-item"]';

/**
 * Finds the "+" control that belongs to the visible editor's composer, never a sidebar or
 * header control. Injected into the page with Function.prototype.toString.
 */
export function findComposerPlusButton(
  doc: Document,
  editorSelectors: string[],
  plusSelectors: string[],
): Element | null {
  const visible = (node: Element | null | undefined): boolean => {
    if (!node || typeof node.getBoundingClientRect !== "function") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const editor =
    editorSelectors
      .flatMap((selector) => Array.from(doc.querySelectorAll(selector)))
      .find(visible) ?? null;
  if (!editor) return null;
  const candidates: Element[] = [];
  for (const selector of plusSelectors) {
    for (const node of Array.from(doc.querySelectorAll(selector))) {
      if (candidates.includes(node) || !visible(node)) continue;
      if (node.closest('nav, aside, header, [data-testid*="sidebar" i]')) continue;
      candidates.push(node);
    }
  }
  for (let ancestor = editor.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const scope = ancestor;
    const match = candidates.find((candidate) => scope.contains(candidate));
    if (match) return match;
  }
  return null;
}

export interface ComposerRowLabels {
  /** First rendered line: the row title in the current panel (title and description are separate lines). */
  title: string;
  /** First leaf element with text, which is the title span when innerText is unavailable. */
  leaf: string;
  text: string;
  aria: string;
}

/** Reads a panel row's title candidates. Injected into the page with Function.prototype.toString. */
export function readComposerRowLabels(row: Element): ComposerRowLabels {
  // Zero-width space and BOM, spelled as char codes so formatters keep them visible in source.
  const invisible = new RegExp(`[${String.fromCharCode(0x200b, 0xfeff)}]`, "g");
  const normalize = (value: unknown): string =>
    String(value ?? "")
      .replace(invisible, "")
      .replace(/\s+/g, " ")
      .trim();
  const rendered = (row as HTMLElement).innerText ?? row.textContent ?? "";
  const title = String(rendered).split("\n").map(normalize).find(Boolean) ?? "";
  let leaf = "";
  const visit = (node: Element): boolean => {
    for (const child of Array.from(node.children ?? [])) {
      if (child.getAttribute?.("aria-hidden") === "true") continue;
      const text = normalize(child.textContent);
      if (!text) continue;
      const textChildren = Array.from(child.children ?? []).filter((grandchild) =>
        normalize(grandchild.textContent),
      );
      if (textChildren.length === 0) {
        leaf = text;
        return true;
      }
      if (visit(child)) return true;
    }
    return false;
  };
  visit(row.querySelector?.("[data-menu-row-content]") ?? row);
  return {
    title,
    leaf,
    text: normalize(row.textContent),
    aria: normalize(row.getAttribute?.("aria-label")),
  };
}

export interface ComposerPanelRow extends ComposerRowLabels {
  index: number;
  impression: string | null;
  current: boolean;
}

/** True when a row's title (not its description) equals one of the names, ignoring case. */
export function composerRowTitleEquals(row: ComposerRowLabels, names: readonly string[]): boolean {
  const wanted = names
    .map((name) => name.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  return [row.title, row.leaf, row.aria]
    .map((value) => value.toLowerCase())
    .some((value) => value.length > 0 && wanted.includes(value));
}

const ESCAPE_KEY = {
  key: "Escape",
  code: "Escape",
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27,
} as const;

function buildPageHelpers(): string {
  return `
    const __visible = node => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const __findPlus = () => (${findComposerPlusButton.toString()})(document, ${JSON.stringify(INPUT_SELECTORS)}, ${JSON.stringify(COMPOSER_PLUS_SELECTORS)});
    const __readRowLabels = ${readComposerRowLabels.toString()};
    const __enabled = node => !node.hasAttribute?.('disabled') && node.getAttribute?.('aria-disabled') !== 'true';
    const __panelRows = () => {
      const rows = Array.from(document.querySelectorAll(${JSON.stringify(COMPOSER_PANEL_ROW_SELECTOR)})).filter(__visible);
      if (rows.length) return rows;
      const roots = Array.from(document.querySelectorAll(${JSON.stringify(LEGACY_PANEL_ROOT_SELECTOR)})).filter(__visible);
      const seen = new Set();
      return roots.flatMap(root => Array.from(root.querySelectorAll(${JSON.stringify(LEGACY_PANEL_ITEM_SELECTOR)})))
        .filter(node => { if (seen.has(node) || !__visible(node)) return false; seen.add(node); return true; });
    };
    const __describe = node => node ? String(node.tagName || '').toLowerCase() +
      (node.getAttribute?.('id') ? '#' + node.getAttribute('id') : '') +
      String(node.getAttribute?.('class') || '').split(/\\s+/).filter(Boolean).slice(0, 3).map(name => '.' + name).join('') +
      (node.getAttribute?.('aria-label') ? '[aria-label="' + node.getAttribute('aria-label') + '"]' : '') +
      (node.getAttribute?.('data-testid') ? '[data-testid="' + node.getAttribute('data-testid') + '"]' : '') : 'nothing';
  `;
}

export function buildComposerPanelStateExpression(): string {
  return `(() => {
    ${buildPageHelpers()}
    const plus = __findPlus();
    const expanded = plus?.getAttribute('aria-expanded') === 'true' || plus?.getAttribute('data-state') === 'open';
    return { plus: Boolean(plus), expanded, rows: __panelRows().length };
  })()`;
}

async function readComposerPanelState(
  runtime: ChromeClient["Runtime"],
): Promise<{ plus: boolean; open: boolean }> {
  const { result } = await runtime.evaluate({
    expression: buildComposerPanelStateExpression(),
    returnByValue: true,
  });
  const value = result?.value as { plus?: boolean; expanded?: boolean; rows?: number } | undefined;
  return { plus: Boolean(value?.plus), open: Boolean(value?.expanded || (value?.rows ?? 0) > 0) };
}

export interface GuardedTrustedClickOptions {
  /** Page function source `() => Element | null`; it runs again at event delivery. */
  locate: string;
  /** When set, the click is cancelled unless the page is still this ChatGPT context. */
  navigationUrl?: string;
  stage: string;
  /** Human-readable target name for errors. */
  target: string;
  settleTimeoutMs?: number;
  /**
   * Where a target outside the view (or covered) is scrolled to: the centre by default, or the
   * end of the view, which suits a thread that keeps itself scrolled to the bottom.
   */
  scrollBlock?: "center" | "end";
}

export type GuardedTrustedClickResult =
  | { status: "clicked"; method: "trusted-click" | "synthetic"; reached: boolean }
  | { status: "missing" | "disabled" | "obscured" | "unreached"; detail?: string };

type ClickMeasurement = {
  status?: "ready" | "settling" | "missing" | "disabled" | "obscured" | "context-changed";
  x?: number;
  y?: number;
  detail?: string;
  navigation?: unknown;
};

/**
 * Clicks one element with a real (trusted) CDP mouse click at its centre, after checking that
 * the element owns that point. Capture-phase listeners cancel the click if, at delivery, the
 * target moved, the point hit something else, or the ChatGPT context changed.
 */
export async function guardedTrustedClick(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  options: GuardedTrustedClickOptions,
): Promise<GuardedTrustedClickResult> {
  const navigationCheck = options.navigationUrl
    ? `() => ${buildComposerNavigationValidationExpression(options.navigationUrl)}`
    : `() => ({ contextMatches: true })`;
  const scrollBlock = JSON.stringify(options.scrollBlock ?? "center");
  const measure = `(() => {
    ${buildPageHelpers()}
    const locate = ${options.locate};
    const navigation = (${navigationCheck})();
    if (!navigation.contextMatches) return { status: 'context-changed', navigation };
    const target = locate();
    if (!__visible(target)) return { status: 'missing' };
    if (!__enabled(target)) return { status: 'disabled' };
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (!(x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight)) {
      target.scrollIntoView?.({ block: ${scrollBlock}, inline: 'nearest' });
      return { status: 'settling' };
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === target || target.contains(hit))) return { status: 'obscured', x, y, detail: __describe(hit) };
    return { status: 'ready', x, y };
  })()`;
  const settleDeadline = Date.now() + Math.max(0, options.settleTimeoutMs ?? 2_000);
  let previous: { x: number; y: number } | null = null;
  let point: { x: number; y: number } | null = null;
  let last: ClickMeasurement | undefined;
  let scrolledForCover = false;
  for (;;) {
    const evaluated = await runtime.evaluate({ expression: measure, returnByValue: true });
    last = evaluated?.result?.value as ClickMeasurement | undefined;
    if (last?.status === "context-changed") {
      assertComposerNavigationSnapshot(options.navigationUrl ?? "", last.navigation, {
        stage: options.stage,
      });
    }
    if (last?.status === "ready" && typeof last.x === "number" && typeof last.y === "number") {
      // Panels animate in; only a point that stayed put across two reads is trusted.
      if (previous && Math.abs(previous.x - last.x) <= 1 && Math.abs(previous.y - last.y) <= 1) {
        point = { x: last.x, y: last.y };
        break;
      }
      previous = { x: last.x, y: last.y };
    } else {
      previous = null;
      if (last?.status === "obscured" && !scrolledForCover) {
        scrolledForCover = true;
        await runtime
          .evaluate({
            expression: `(() => { ${buildPageHelpers()} const target = (${options.locate})(); target?.scrollIntoView?.({ block: ${scrollBlock}, inline: 'nearest' }); return true; })()`,
            returnByValue: true,
          })
          .catch(() => undefined);
      }
    }
    if (Date.now() >= settleDeadline) break;
    await delay(100);
  }
  if (!point) {
    const status =
      last?.status === "disabled" || last?.status === "obscured" ? last.status : "missing";
    return { status, detail: last?.detail };
  }

  const trusted = Boolean(input && typeof input.dispatchMouseEvent === "function");
  const guardId = randomUUID();
  let summary: { reached?: boolean; blocked?: unknown } | undefined;
  try {
    const armed = await runtime.evaluate({
      expression: `(() => {
        ${buildPageHelpers()}
        ${buildClickDispatcher()}
        const locate = ${options.locate};
        const navigationCheck = ${navigationCheck};
        const target = locate();
        const point = ${JSON.stringify(point)};
        const check = (event) => {
          const navigation = navigationCheck();
          const current = locate();
          const x = event ? event.clientX : point.x;
          const y = event ? event.clientY : point.y;
          const hit = document.elementFromPoint(x, y);
          return { ...navigation, ready: Boolean(target) && current === target && target.isConnected &&
            __visible(target) && __enabled(target) && Boolean(hit) && (hit === target || target.contains(hit)) };
        };
        const safeCheck = (event) => { try { return check(event); } catch { return { currentUrl: location.href, contextMatches: false, ready: false }; } };
        const guard = { reached: false, pressed: false, blocked: null, removed: false };
        const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        const swallow = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
        const cancel = (event, state) => { swallow(event); guard.blocked = state; };
        const onEvent = event => {
          if (!event.isTrusted) return;
          const inside = event.target instanceof Node && target.contains(event.target);
          if (guard.blocked) {
            cancel(event, guard.blocked);
          } else if (guard.pressed) {
            // The press reached the target; menus and cards act on it and may close before the
            // release. A later event that no longer lands on the live target is swallowed, so it
            // cannot activate whatever is underneath, without reporting the click as blocked.
            if (!inside || !safeCheck(event).ready) swallow(event);
          } else {
            const state = safeCheck(event);
            if (!inside || !state.contextMatches || !state.ready) cancel(event, { ...state, inside });
            else {
              guard.reached = true;
              if (event.type === 'pointerdown' || event.type === 'mousedown') guard.pressed = true;
            }
          }
          // The release ends the sequence; click (if any) is dispatched in the same task.
          if (event.type === 'mouseup' || event.type === 'click') setTimeout(guard.cleanup, 0);
        };
        guard.cleanup = () => {
          if (guard.removed) return;
          guard.removed = true;
          types.forEach(type => window.removeEventListener(type, onEvent, true));
        };
        // Page-side safety net: the guard never outlives the click, even if Oracle's own cleanup
        // call cannot reach the page.
        setTimeout(guard.cleanup, 30000);
        setTimeout(() => { delete window.__oracleTrustedClickGuards?.[${JSON.stringify(guardId)}]; }, 120000);
        (window.__oracleTrustedClickGuards ??= Object.create(null))[${JSON.stringify(guardId)}] = guard;
        const state = safeCheck(null);
        if (!state.contextMatches || !state.ready) { guard.blocked = state; return state; }
        types.forEach(type => window.addEventListener(type, onEvent, true));
        if (!${trusted}) { dispatchClickSequence(target); guard.reached = true; }
        return state;
      })()`,
      returnByValue: true,
    });
    const state = armed?.result?.value as { ready?: boolean; contextMatches?: boolean } | undefined;
    if (!state?.ready || state.contextMatches === false) {
      if (options.navigationUrl)
        assertComposerNavigationSnapshot(options.navigationUrl, state, { stage: options.stage });
      return { status: "obscured", detail: "target moved before the click" };
    }
    if (trusted && input) {
      const { x, y } = point;
      // A transport failure can follow a delivered press; never click twice here.
      await input.dispatchMouseEvent({ type: "mouseMoved", x, y });
      await input.dispatchMouseEvent({
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await input.dispatchMouseEvent({
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
  } finally {
    const observed = await withoutBrowserCancellation(() =>
      runtime
        .evaluate({
          expression: `(() => {
            const guards = window.__oracleTrustedClickGuards;
            const guard = guards?.[${JSON.stringify(guardId)}];
            if (!guard) return null;
            const summary = { reached: guard.reached, blocked: guard.blocked };
            guard.cleanup(); delete guards[${JSON.stringify(guardId)}]; return summary;
          })()`,
          returnByValue: true,
        })
        .catch(() => undefined),
    );
    summary = observed?.result?.value as typeof summary;
  }
  if (summary?.blocked) {
    if (options.navigationUrl)
      assertComposerNavigationSnapshot(options.navigationUrl, summary.blocked, {
        stage: options.stage,
      });
    throw new BrowserAutomationError(
      `${options.target} moved or was covered while Oracle clicked it; the click was cancelled and nothing was sent.`,
      { stage: options.stage, code: "trusted-click-cancelled" },
    );
  }
  if (!summary?.reached) {
    // Nothing reached the target (or the outcome could not be read): the click did not happen.
    return {
      status: "unreached",
      detail: summary
        ? "the click did not reach the target"
        : "the click outcome could not be read",
    };
  }
  return {
    status: "clicked",
    method: trusted ? "trusted-click" : "synthetic",
    reached: true,
  };
}

export interface ComposerPlusOpenResult {
  status: "opened" | "already-open" | "not-needed" | "unavailable";
  method: "trusted-click" | "synthetic" | "none";
  startUrl: string;
  reason?: string;
}

type ComposerPlusProbe = {
  status?:
    | "ready"
    | "open"
    | "missing"
    | "not-needed"
    | "work-selected"
    | "mode-unverified"
    | "context-changed";
  navigation?: unknown;
  startUrl?: string;
};

const PLUS_LOCATE_SOURCE = `() => (${findComposerPlusButton.toString()})(document, ${JSON.stringify(INPUT_SELECTORS)}, ${JSON.stringify(COMPOSER_PLUS_SELECTORS)})`;

/**
 * Opens the composer "+" panel with a trusted click. Work suggestions sit next to the composer
 * and one stray click opens a Work task, so the page identity, Work mode and the exact control
 * are checked before and at delivery.
 */
export async function openComposerPlusPanel(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  options: { navigationUrl?: string; stage?: string; skipWhenFileInputPresent?: boolean } = {},
): Promise<ComposerPlusOpenResult> {
  const stage = options.stage ?? "upload-attachment";
  const probe = await Promise.resolve(
    runtime.evaluate({
      expression: `(() => {
        ${buildPageHelpers()}
        const navigation = ${options.navigationUrl ? buildComposerNavigationValidationExpression(options.navigationUrl) : buildComposerNavigationProbeExpression()};
        const startUrl = navigation.currentUrl;
        if (navigation.contextMatches === false) return { status: 'context-changed', startUrl, navigation };
        if (navigation.workSelected) return { status: 'work-selected', startUrl };
        if (navigation.modeUnverified) return { status: 'mode-unverified', startUrl };
        if (${Boolean(options.skipWhenFileInputPresent)} && document.querySelector('input[type="file"]')) return { status: 'not-needed', startUrl };
        const plus = __findPlus();
        if (!plus) return { status: 'missing', startUrl };
        if (plus.getAttribute('aria-expanded') === 'true' || plus.getAttribute('data-state') === 'open') return { status: 'open', startUrl };
        return { status: 'ready', startUrl };
      })()`,
      returnByValue: true,
    }),
  ).then((result) => result?.result?.value as ComposerPlusProbe | undefined);

  const startUrl =
    options.navigationUrl ?? (typeof probe?.startUrl === "string" ? probe.startUrl : "");
  if (probe?.status === "context-changed") {
    assertComposerNavigationSnapshot(startUrl, probe.navigation, { stage });
  }
  if (probe?.status === "mode-unverified") {
    throw new BrowserAutomationError(
      "ChatGPT mode could not be verified; the composer menu was not opened.",
      { stage, code: "attachment-control-mode-unverified", startUrl },
    );
  }
  if (probe?.status === "work-selected") {
    throw new BrowserAutomationError(
      "Oracle refused to open the composer menu because ChatGPT is in Work mode.",
      { stage, code: "attachment-control-work-mode", startUrl },
    );
  }
  if (probe?.status === "not-needed") return { status: "not-needed", method: "none", startUrl };
  if (probe?.status === "open") return { status: "already-open", method: "none", startUrl };
  if (probe?.status !== "ready") {
    return {
      status: "unavailable",
      method: "none",
      startUrl,
      reason: "composer + button not found",
    };
  }

  let reason = "composer + panel did not open";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clicked = await guardedTrustedClick(runtime, input, {
      locate: PLUS_LOCATE_SOURCE,
      navigationUrl: startUrl,
      stage,
      target: "The ChatGPT composer + button",
    });
    if (clicked.status === "unreached") {
      // Nothing reached the button, so another click cannot toggle anything twice.
      reason = `the click did not reach the composer + button (${clicked.detail ?? "unknown"})`;
      continue;
    }
    if (clicked.status !== "clicked") {
      reason = `composer + button ${clicked.status}${clicked.detail ? ` (${clicked.detail})` : ""}`;
      break;
    }
    const deadline = Date.now() + 2_000;
    do {
      await delay(100);
      await assertComposerPlusStayedInPlace(runtime, startUrl);
      if ((await readComposerPanelState(runtime)).open) {
        return { status: "opened", method: clicked.method, startUrl };
      }
    } while (Date.now() < deadline);
    // The click landed but nothing opened (no toggle happened), so one more click is safe.
  }
  return { status: "unavailable", method: "none", startUrl, reason };
}

/** Closes the "+" panel or "@" picker with Escape. Returns whether it is closed afterwards. */
export async function closeComposerPlusPanel(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await readComposerPanelState(runtime)).open) return true;
    if (input && typeof input.dispatchKeyEvent === "function") {
      await input.dispatchKeyEvent({ type: "keyDown", ...ESCAPE_KEY });
      await input.dispatchKeyEvent({ type: "keyUp", ...ESCAPE_KEY });
    } else {
      await runtime.evaluate({
        expression: `(() => { const target = document.activeElement || document.body; target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); return true; })()`,
        returnByValue: true,
      });
    }
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await delay(100);
      if (!(await readComposerPanelState(runtime)).open) return true;
    }
  }
  return !(await readComposerPanelState(runtime)).open;
}

/** Lists the visible rows of the open "+" panel or "@" picker and remembers them under `token`. */
export async function readComposerPanelRows(
  runtime: ChromeClient["Runtime"],
  token: string,
): Promise<ComposerPanelRow[]> {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      ${buildPageHelpers()}
      const rows = __panelRows().filter(__enabled);
      window.__oracleComposerRows = { token: ${JSON.stringify(token)}, nodes: rows };
      return rows.map((row, index) => ({
        index,
        ...__readRowLabels(row),
        impression: row.getAttribute('data-plugin-impression-id'),
        current: row.getAttribute('aria-current') === 'true' || row.getAttribute('aria-selected') === 'true' || row.getAttribute('data-highlighted') != null,
      }));
    })()`,
    returnByValue: true,
  });
  return Array.isArray(result?.value) ? (result.value as ComposerPanelRow[]) : [];
}

export type ComposerPanelRowClick =
  | { status: "clicked"; row: ComposerPanelRow; rows: ComposerPanelRow[] }
  | { status: "missing"; rows: ComposerPanelRow[] };

/** Waits for the row chosen by `pick` in the open panel and clicks it with a guarded trusted click. */
export async function clickComposerPanelRow(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  options: {
    pick: (rows: ComposerPanelRow[]) => number;
    navigationUrl?: string;
    stage: string;
    target: string;
    timeoutMs?: number;
  },
): Promise<ComposerPanelRowClick> {
  const token = randomUUID();
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 5_000);
  let rows: ComposerPanelRow[] = [];
  for (;;) {
    rows = await readComposerPanelRows(runtime, token);
    const index = options.pick(rows);
    const row = index >= 0 ? rows[index] : undefined;
    if (row) {
      const clicked = await guardedTrustedClick(runtime, input, {
        locate: `() => window.__oracleComposerRows?.token === ${JSON.stringify(token)} ? window.__oracleComposerRows.nodes[${row.index}] ?? null : null`,
        navigationUrl: options.navigationUrl,
        stage: options.stage,
        target: options.target,
        settleTimeoutMs: 1_500,
      });
      if (clicked.status === "clicked") return { status: "clicked", row, rows };
    }
    if (Date.now() >= deadline) return { status: "missing", rows };
    await delay(150);
  }
}
