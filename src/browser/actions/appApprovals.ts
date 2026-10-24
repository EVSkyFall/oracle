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
  /** The allowed app the card names, or null when it names none of them. */
  app: string | null;
  /** Card text without its buttons: what ChatGPT asks to run. */
  toolText: string;
  /** Best allow-type button (lowest rank) and its index in the remembered button list. */
  button: { label: string; rank: number; index: number };
}

/**
 * Finds visible approval cards: the nearest ancestor of an allow-type button that has text of
 * its own (the card), never climbing past a dialog or a conversation turn. Assistant prose and
 * user messages inside that region do not count, so a prompt that names an app cannot make
 * another app's card look approved. Injected into the page with Function.prototype.toString.
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
  // textContent avoids a layout pass per button on every poll.
  const label = (button: Element): string =>
    normalize(button.textContent) || normalize(button.getAttribute("aria-label"));
  const rankOf = (button: Element): number => {
    const text = label(button).toLowerCase();
    return labels.find((entry) => entry.label === text)?.rank ?? -1;
  };
  const textOf = (root: Element, keep: Element): string => {
    const parts: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (element.matches(BUTTON)) return;
      if (element.getAttribute("aria-hidden") === "true") return;
      if (
        element !== root &&
        !element.contains(keep) &&
        element.matches(
          '.markdown, [class*="markdown"], [class*="prose"], [data-message-author-role="user"], [data-turn="user"]',
        )
      ) {
        return;
      }
      for (const child of Array.from(element.childNodes)) walk(child);
    };
    walk(root);
    return normalize(parts.join(" "));
  };
  const DIALOG = '[role="dialog"], [role="alertdialog"]';
  const TURN =
    '[data-message-author-role], [data-turn], [data-testid^="conversation-turn"], article, main, body';
  const cardOf = (button: Element): { card: Element; text: string } | null => {
    for (let node = button.parentElement; node; node = node.parentElement) {
      if (node.matches(TURN) && !node.matches(DIALOG)) return null;
      const text = textOf(node, button);
      if (text || node.matches(DIALOG)) return { card: node, text };
    }
    return null;
  };
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = (text: string): string | null =>
    allowApps.find((app) =>
      new RegExp(`(^|[^A-Za-z0-9_])${escape(app.trim())}($|[^A-Za-z0-9_])`, "i").test(text),
    ) ?? null;

  const byCard = new Map<Element, { text: string; best: Element; rank: number }>();
  for (const button of Array.from(doc.querySelectorAll(BUTTON))) {
    if (!visible(button)) continue;
    if (button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true")
      continue;
    const rank = rankOf(button);
    if (rank < 0) continue;
    const found = cardOf(button);
    if (!found) continue;
    const current = byCard.get(found.card);
    if (!current || rank < current.rank)
      byCard.set(found.card, { text: found.text, best: button, rank });
  }
  const cards: AppApprovalCard[] = [];
  const buttons: Element[] = [];
  for (const { text, best, rank } of byCard.values()) {
    buttons.push(best);
    cards.push({
      key: text.slice(0, 300),
      app: names(text),
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
            `[browser] App approval for "${card.toolText.slice(0, 160)}" left for the user (it names no app in --browser-allow-app).`,
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
        locate: `() => window.__oracleApprovalButtons?.token === ${JSON.stringify(token)} ? window.__oracleApprovalButtons.nodes[${card.button.index}] ?? null : null`,
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
