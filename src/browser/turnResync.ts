import { randomUUID } from "node:crypto";
import { buildConversationTurnCountExpression } from "./conversationTurns.js";
import { conversationIdFromUrl } from "./actions/navigation.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

/** No change in the thread for this long means the turn looks stalled (then 16, 32, … minutes). */
export const TURN_STALL_MS = 8 * 60_000;
const PROGRESS_POLL_MS = 5_000;
// A hidden prompt is answered by a reload once the thread is quiet: a card that stays in the page
// hidden after it was answered must not reload a turn that is still streaming.
const HIDDEN_PROMPT_QUIET_MS = 20_000;
// A hidden prompt counts while the approval monitor keeps reporting it (it polls every 1.5 s).
const HIDDEN_PROMPT_FRESH_MS = 10_000;
const RELOAD_SETTLE_MS = 30_000;
const PAGE_COMMAND_MS = 15_000;

/** One sample of the thread: changes in `key` are progress. */
export interface TurnProgressSample {
  key: string;
  length: number;
  url: string;
}

/**
 * Page function: what the thread shows. The visible text of the main area (activity rows such as
 * "Running command" included, editors left out) with digit runs folded, so a ticking timer is not
 * progress, a reasoning or thinking panel that sits outside it, and the approval prompts that are
 * shown anywhere in the page. Injected into the page with Function.prototype.toString.
 */
export function readTurnProgress(doc: Document): TurnProgressSample {
  const EDITABLE =
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], textarea';
  const SURFACE =
    '[data-codex-approval-surface="true"], [class*="approval-card"], [role="alert"], [role="alertdialog"]';
  const PANEL = '[data-testid*="thinking"], [data-testid*="reasoning"], [class*="sidecar"]';
  const fold = (value: unknown) =>
    String(value ?? "")
      .replace(/\d+/g, "0")
      .replace(/\s+/g, " ")
      .trim();
  const textOf = (node: Element) =>
    String((node as { innerText?: string }).innerText ?? node.textContent ?? "");
  const hash = (value: string) => {
    let h = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      h ^= value.charCodeAt(index);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  };
  const shown = (node: Element) => {
    const rect = node.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const check = (node as { checkVisibility?: (options: object) => boolean }).checkVisibility;
    return typeof check !== "function" || check.call(node, { visibilityProperty: true });
  };
  const root = doc.querySelector("main") ?? doc.body;
  let text = root ? textOf(root) : "";
  if (root) {
    for (const editor of Array.from(root.querySelectorAll(EDITABLE))) {
      const typed = textOf(editor);
      if (typed.trim()) text = text.split(typed).join("");
    }
  }
  // A reasoning sidecar outside the main area streams too; nested panels count once.
  const panels = Array.from(doc.querySelectorAll(PANEL)).filter(
    (node) => !root?.contains(node) && !node.parentElement?.closest(PANEL) && shown(node),
  );
  if (panels.length > 0) text += `\n${panels.map(textOf).join("\n")}`;
  const surfaces = Array.from(doc.querySelectorAll(SURFACE))
    .filter(shown)
    .map((node) => fold(textOf(node)))
    .join("\n");
  const folded = fold(text);
  const url = String((doc as { location?: { href?: string } }).location?.href ?? "");
  const path = url.replace(/[?#].*$/, "");
  return {
    key: `${hash(folded)}:${folded.length}:${hash(surfaces)}:${path}`,
    length: folded.length,
    url,
  };
}

export function buildTurnProgressExpression(): string {
  return `(${readTurnProgress.toString()})(document)`;
}

/**
 * One page action at a time. An approval click (a guarded trusted click is several CDP events)
 * and a conversation reload never interleave: events of a click that began on one document must
 * never land on the next at the old coordinates.
 */
export interface PageGate {
  /** Runs `action` once no other action holds the page, in the order they asked. */
  exclusive<T>(action: () => Promise<T>): Promise<T>;
}

export function createPageGate(): PageGate {
  let tail: Promise<void> = Promise.resolve();
  return {
    exclusive<T>(action: () => Promise<T>): Promise<T> {
      const turn = tail.then(() => action());
      tail = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
    },
  };
}

export interface TurnResyncAttempt {
  /** Aborted when the conversation is reloaded; that attempt ends and a new one starts. */
  signal: AbortSignal;
  /** What is left of `totalMs` since the wait began: reloads never lengthen a wait. */
  remainingMs(totalMs: number): number;
}

export interface TurnResyncOptions {
  Runtime: ChromeClient["Runtime"];
  Page: ChromeClient["Page"];
  logger: BrowserLogger;
  /** The conversation's URL as the run knows it; else the page's own conversation URL is used. */
  conversationUrl?: () => string | null | undefined;
  stallMs?: number;
  pollMs?: number;
  hiddenQuietMs?: number;
  settleMs?: number;
}

export interface TurnResync {
  /** Shared with the approval monitor: its polls and the reloads take turns on the page. */
  gate: PageGate;
  /** When the thread last changed (also the heartbeat's "last change"). */
  lastChangedAt(): number;
  /** The approval monitor found an allowed app's pending prompt hidden in the page. */
  reportHiddenApproval(surface: { app: string; state: string }): void;
  /**
   * Runs the wait. When the thread has not changed for the stall time (8 minutes, then 16, 32,
   * … after each reload that changed nothing), or an allowed app's prompt is hidden in the page
   * and the thread is quiet, the attempt is aborted, the conversation is reloaded (or navigated
   * to when the reload fails or the tab shows another page), and a new attempt waits on the
   * reloaded page. Never a stop condition: the wait ends only as the operation ends.
   */
  run<T>(operation: (attempt: TurnResyncAttempt) => Promise<T>): Promise<T>;
}

type Trigger = { url: string; reason: string };

const idle = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function formatQuiet(ms: number): string {
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1_000)}s`;
}

export function createTurnResync(options: TurnResyncOptions): TurnResync {
  const { Runtime, Page, logger } = options;
  const stallMs = Math.max(1, options.stallMs ?? TURN_STALL_MS);
  const pollMs = Math.max(1, options.pollMs ?? PROGRESS_POLL_MS);
  const hiddenQuietMs = Math.max(0, options.hiddenQuietMs ?? HIDDEN_PROMPT_QUIET_MS);
  const settleMs = Math.max(0, options.settleMs ?? RELOAD_SETTLE_MS);

  let lastChangeAt = Date.now();
  // Undefined until the first sample (and again after a reload): that sample is the baseline,
  // not progress, so a reload's re-render never counts as the turn moving.
  let baseline: string | undefined;
  let stallReloads = 0;
  let stallAnchor = lastChangeAt;
  let hiddenReloads = 0;
  let hidden: { app: string; state: string; at: number } | null = null;
  let pageConversationUrl: string | null = null;
  let reloading = false;
  // Bumped by each reload: a sample read before it must not become the reloaded page's baseline.
  let epoch = 0;
  let deciding = false;
  let waiter: ((trigger: Trigger) => void) | null = null;
  const reportedNoUrl = new Set<string>();
  const gate = createPageGate();

  const progressed = (now: number) => {
    lastChangeAt = now;
    stallReloads = 0;
    stallAnchor = now;
    hiddenReloads = 0;
  };

  const sample = async (): Promise<void> => {
    const readIn = epoch;
    try {
      const { result } = await Runtime.evaluate({
        expression: buildTurnProgressExpression(),
        returnByValue: true,
      });
      const value = result?.value as Partial<TurnProgressSample> | undefined;
      if (reloading || readIn !== epoch || typeof value?.key !== "string" || !value.key) return;
      if (typeof value.url === "string" && conversationIdFromUrl(value.url)) {
        pageConversationUrl = value.url;
      }
      if (baseline === undefined) {
        baseline = value.key;
      } else if (value.key !== baseline) {
        baseline = value.key;
        progressed(Date.now());
      }
    } catch {
      // A failed read is not a change; the next poll reads again.
    }
  };

  const resolveUrl = async (): Promise<string | null> => {
    const known = options.conversationUrl?.();
    if (known && conversationIdFromUrl(known)) return known;
    try {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const href = typeof result?.value === "string" ? result.value : "";
      if (conversationIdFromUrl(href)) return href;
    } catch {
      // fall back to the last conversation URL the page showed
    }
    return pageConversationUrl;
  };

  const decide = async (): Promise<void> => {
    if (reloading || deciding || !waiter) return;
    deciding = true;
    try {
      const now = Date.now();
      const quiet = now - lastChangeAt;
      let reason: string | null = null;
      let kind: "stall" | "hidden" = "stall";
      if (now - stallAnchor >= stallMs * 2 ** stallReloads) {
        reason = `no change for ${formatQuiet(quiet)}`;
      } else if (
        hidden &&
        now - hidden.at <= HIDDEN_PROMPT_FRESH_MS &&
        hiddenReloads === 0 &&
        quiet >= hiddenQuietMs
      ) {
        kind = "hidden";
        reason = `no change for ${formatQuiet(quiet)}; ${hidden.app}'s approval prompt is hidden in the page`;
      }
      if (!reason) return;
      const url = await resolveUrl();
      // The wait may have ended (or a reload begun) while the URL was read.
      if (!waiter || reloading) return;
      if (!url) {
        // Reloading a page that is not the conversation would lose the turn.
        // Nothing was reloaded, so nothing is counted: the next poll asks again.
        if (!reportedNoUrl.has(kind)) {
          reportedNoUrl.add(kind);
          logger(
            `[browser] Turn looks stalled (${reason}), but no conversation URL is known, so the page is not reloaded.`,
          );
        }
        return;
      }
      if (kind === "stall") {
        stallReloads += 1;
        stallAnchor = now;
      } else {
        hiddenReloads += 1;
      }
      logger(`[browser] Turn looks stalled (${reason}); reloading the conversation to resync`);
      const wake = waiter;
      waiter = null;
      wake?.({ url, reason });
    } finally {
      deciding = false;
    }
  };

  const readPage = async (expression: string): Promise<unknown> => {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    return result?.value;
  };

  /** Reloads the conversation and waits (bounded) until the new page shows its turns. */
  const reload = async ({ url }: Trigger): Promise<void> => {
    const mark = randomUUID();
    await readPage(`window.__oracleResyncMark = ${JSON.stringify(mark)}`).catch(() => undefined);
    const current = await readPage("location.href").catch(() => null);
    const sameConversation =
      typeof current === "string" && conversationIdFromUrl(current) === conversationIdFromUrl(url);
    let how = "reloaded";
    try {
      if (!sameConversation) throw new Error("the tab shows another page");
      await withTimeout(Page.reload({}), PAGE_COMMAND_MS, "Page.reload");
    } catch (reloadError) {
      how = "opened again";
      try {
        await withTimeout(Page.navigate({ url }), PAGE_COMMAND_MS, "Page.navigate");
      } catch (navigateError) {
        logger(
          `[browser] Conversation reload failed (${message(reloadError)}; ${message(navigateError)}); waiting on the page as it is.`,
        );
        return;
      }
    }
    const deadline = Date.now() + settleMs;
    // The new document: the mark is gone and the page has parsed.
    while (Date.now() < deadline) {
      const state = await readPage(
        `window.__oracleResyncMark === ${JSON.stringify(mark)} ? 'old' : document.readyState`,
      ).catch(() => "old");
      if (state === "interactive" || state === "complete") break;
      await idle(250);
    }
    // Its turns: the count holds for three reads in a row.
    let turns = -1;
    let steady = 0;
    while (Date.now() < deadline && steady < 3) {
      const count = await readPage(buildConversationTurnCountExpression()).catch(() => -1);
      const next = typeof count === "number" ? count : -1;
      steady = next > 0 && next === turns ? steady + 1 : 0;
      turns = next;
      await idle(250);
    }
    logger(
      `[browser] Conversation ${how}${turns > 0 ? ` (${turns} turns on the page)` : ""}; waiting for the turn again.`,
    );
  };

  /** The reload, after any approval click in flight has finished (the gate). */
  const reloadInTurn = async (trigger: Trigger): Promise<void> => {
    try {
      await gate.exclusive(() => reload(trigger));
    } catch (error) {
      logger(
        `[browser] Conversation reload failed (${message(error)}); waiting on the page as it is.`,
      );
    }
  };

  const resync: TurnResync = {
    gate,
    lastChangedAt: () => lastChangeAt,
    reportHiddenApproval(surface) {
      if (reloading) return;
      hidden = { app: surface.app, state: surface.state, at: Date.now() };
      void decide();
    },
    async run<T>(operation: (attempt: TurnResyncAttempt) => Promise<T>): Promise<T> {
      const startedAt = Date.now();
      progressed(startedAt);
      let stopped = false;
      const loop = (async () => {
        while (!stopped) {
          await sample();
          if (stopped) break;
          await decide();
          await idle(pollMs);
        }
      })();
      try {
        for (;;) {
          const controller = new AbortController();
          const attempt: TurnResyncAttempt = {
            signal: controller.signal,
            remainingMs: (totalMs) => Math.max(0, totalMs - (Date.now() - startedAt)),
          };
          const pending = (async () => operation(attempt))();
          const next = new Promise<Trigger>((resolve) => {
            waiter = resolve;
          });
          const outcome = await Promise.race([
            pending.then(
              (value) => ({ kind: "done" as const, value }),
              (error: unknown) => ({ kind: "failed" as const, error }),
            ),
            next.then((trigger) => ({ kind: "resync" as const, trigger })),
          ]);
          waiter = null;
          if (outcome.kind === "done") return outcome.value;
          if (outcome.kind === "failed") throw outcome.error;
          controller.abort();
          pending.catch(() => undefined);
          reloading = true;
          epoch += 1;
          try {
            await reloadInTurn(outcome.trigger);
          } finally {
            baseline = undefined;
            hidden = null;
            epoch += 1;
            reloading = false;
          }
        }
      } finally {
        stopped = true;
        waiter = null;
        void loop;
      }
    },
  };
  return resync;
}
