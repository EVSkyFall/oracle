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
 * Finds visible approval cards. A candidate is an allow-type button inside a dialog or the
 * conversation thread, and never inside page chrome (nav, aside, header), the composer, a user
 * message or assistant prose. Its card is the nearest ancestor with text of its own, and the
 * allowed app must be named in the card's title (heading, aria-labelledby/aria-label text, or
 * else its first line), so tool arguments shown in another app's card that mention an allowed
 * app cannot approve that card. Injected into the page with Function.prototype.toString.
 */
export function scanAppApprovalCards(
  doc: Document,
  allowApps: readonly string[],
  labels: ReadonlyArray<{ label: string; rank: number }>,
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
  const TURN =
    '[data-message-author-role], [data-turn], [data-testid^="conversation-turn"], article';
  const USER = '[data-message-author-role="user"], [data-turn="user"]';
  const PROSE = '.markdown, [class*="markdown"], [class*="prose"]';
  // Places that never hold a permission card of the current turn.
  const OFF_LIMITS = `${PROSE}, ${USER}, form, [contenteditable="true"], [role="textbox"], [data-composer-overlay-floating-ui], [data-testid*="composer" i]`;
  const PAGE_CHROME = 'nav, aside, header, [data-testid*="sidebar" i]';
  const ARGUMENTS = "code, pre, samp, kbd";
  // textContent avoids a layout pass per button on every poll.
  const label = (button: Element): string =>
    normalize(button.textContent) || normalize(button.getAttribute("aria-label"));
  const rankOf = (button: Element): number => {
    const text = label(button).toLowerCase();
    return labels.find((entry) => entry.label === text)?.rank ?? -1;
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
  const regionOf = (button: Element): Element | null => {
    // The whole ancestry up to the document: an article inside prose or a user message must not
    // end the check early.
    for (let node = button.parentElement; node; node = node.parentElement) {
      if (node.matches(OFF_LIMITS) || node.matches(PAGE_CHROME)) return null;
    }
    return button.closest(`${DIALOG}, ${TURN}`) ?? button.closest("main");
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
  const firstLineOf = (root: Element | null): string => {
    if (!root) return "";
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
   * heading, the aria-labelledby text, the aria-label (card, then dialog), the card's first
   * rendered line. The card's title is the first one present.
   */
  const titlesOf = (card: Element, region: Element): string[] => {
    const heading = Array.from(
      card.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6'),
    ).find((node) => !node.closest(PROSE));
    const candidates = [firstLineOf(heading ?? null)];
    for (const owner of region.matches(DIALOG) ? [card, region] : [card]) {
      candidates.push(labelledLine(owner.getAttribute("aria-labelledby")));
      candidates.push(normalize(owner.getAttribute("aria-label")));
    }
    candidates.push(firstLineOf(card));
    return candidates.filter(Boolean);
  };
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = (text: string): string | null =>
    allowApps.find((app) =>
      new RegExp(`(^|[^A-Za-z0-9_])${escape(app.trim())}($|[^A-Za-z0-9_])`, "i").test(text),
    ) ?? null;

  const byCard = new Map<Element, { region: Element; best: Element; rank: number }>();
  for (const button of Array.from(doc.querySelectorAll(BUTTON))) {
    if (!visible(button)) continue;
    if (button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true")
      continue;
    const rank = rankOf(button);
    if (rank < 0) continue;
    const region = regionOf(button);
    if (!region) continue;
    const card = cardOf(button, region);
    if (!card) continue;
    const current = byCard.get(card);
    if (!current || rank < current.rank) byCard.set(card, { region, best: button, rank });
  }
  const cards: AppApprovalCard[] = [];
  const buttons: Element[] = [];
  for (const [card, { region, best, rank }] of byCard.entries()) {
    // The title is the first candidate present; a later line naming the app does not count.
    const title = titlesOf(card, region)[0] ?? "";
    const text = textOf(card, `${BUTTON}, ${PROSE}, ${USER}`);
    buttons.push(best);
    cards.push({
      key: `${title}\n${text}`.slice(0, 400),
      app: names(title),
      title: title.slice(0, 200),
      toolText: text.slice(0, 500),
      button: { label: label(best), rank, index: buttons.length - 1 },
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
    const { cards, buttons } = scan(document, ${JSON.stringify(allowApps)}, ${JSON.stringify(APP_APPROVAL_ALLOW_LABELS)});
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
    const { cards, buttons } = scan(document, ${JSON.stringify(allowApps)}, ${JSON.stringify(APP_APPROVAL_ALLOW_LABELS)});
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
