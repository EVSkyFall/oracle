import { randomUUID } from "node:crypto";
import { buildConversationTurnCountExpression } from "./conversationTurns.js";
import { conversationIdFromUrl } from "./actions/navigation.js";
import type { ReplacementTab } from "./tabReplacement.js";
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
/**
 * The progress read is a cheap evaluate that answers in milliseconds, and in a few seconds on a
 * busy page; a minute without an answer is a renderer that stopped (an endless script).
 */
const PAGE_FROZEN_MS = 60_000;
// Recovery steps: stopping the page's script, asking whether it answers, opening a new tab.
const TERMINATE_WAIT_MS = 5_000;
const PAGE_ANSWER_WAIT_MS = 10_000;
const NEW_TAB_MS = 60_000;

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
  /**
   * The run's CDP client (runClient.ts): while the wait runs, its calls are raced against the
   * time left, so no call holds the run past it; cleared when the answer is in.
   */
  timeLimit?: { setDeadline(at: number | null): void };
  /** How long the progress read may go unanswered before the page counts as frozen. */
  frozenMs?: number;
  /**
   * Opens the conversation in a new tab of the same Chrome and moves the run there (its client,
   * so the wait, the approval monitor and this resync follow), recording the new target; the
   * frozen tab is closed in the background. Null when no tab could be opened. A tab that opens
   * once `givenUp()` (its step ran out of time) is closed instead of taking the run over.
   */
  replaceTab?: (url: string, givenUp: () => boolean) => Promise<ReplacementTab | null>;
}

export interface TurnResync {
  /** Shared with the approval monitor: its polls and the reloads take turns on the page. */
  gate: PageGate;
  /** When the thread last changed (also the heartbeat's "last change"). */
  lastChangedAt(): number;
  /** When the run's time for this wait is spent (Infinity until run starts or with no limit). */
  deadlineAt(): number;
  /** The approval monitor found an allowed app's pending prompt hidden in the page. */
  reportHiddenApproval(surface: { app: string; state: string }): void;
  /**
   * Runs the wait. When the thread has not changed for the stall time (8 minutes, then 16, 32,
   * … after each reload that changed nothing), or an allowed app's prompt is hidden in the page
   * and the thread is quiet, the attempt is aborted, the conversation is reloaded (or navigated
   * to when the reload fails or the tab shows another page), and a new attempt waits on the
   * reloaded page. Never a stop condition: the wait ends only as the operation ends.
   * `timeoutMs` is the run's time for the whole wait: every step of a reload (waiting for an
   * approval click to finish included) stops when it is spent, and the next attempt, with no time
   * left, ends the wait as its own timeout would.
   */
  run<T>(
    operation: (attempt: TurnResyncAttempt) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
}

type Trigger = {
  url: string | null;
  reason: string;
  kind: "stall" | "hidden" | "frozen";
  /** When the frozen page was last asked something (kind "frozen"). */
  since?: number;
};

/** The progress read got no answer for the frozen time. */
class PageNotAnswering extends Error {}

const idle = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** The run's time ran out during a reload step. */
class RunTimeSpent extends Error {}
/** The reload was given up (its time ran out while it waited its turn). */
class ReloadAbandoned extends Error {}
const endsReload = (error: unknown) =>
  error instanceof RunTimeSpent || error instanceof ReloadAbandoned;
/** A step that fails on its own is skipped with `fallback`; one that ends the reload is not. */
const orElse = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
  promise.catch((error: unknown) => {
    if (endsReload(error)) throw error;
    return fallback;
  });
type Step = <T>(what: string, start: () => Promise<T>, capMs: number) => Promise<T>;

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
  // Since when the page has not answered the progress read (null while it answers).
  let frozenSince: number | null = null;
  const frozenMs = Math.max(1, options.frozenMs ?? PAGE_FROZEN_MS);
  let pageConversationUrl: string | null = null;
  let reloading = false;
  // Bumped by each reload: a sample read before it must not become the reloaded page's baseline.
  let epoch = 0;
  let deciding = false;
  let waiter: ((trigger: Trigger) => void) | null = null;
  const reportedNoUrl = new Set<string>();
  const gate = createPageGate();
  // When the run's time for the wait is spent (set by run).
  let deadline = Number.POSITIVE_INFINITY;

  /**
   * `start()` raced against `capMs` and the run's remaining time; once that time is spent it
   * rejects with RunTimeSpent, so no step of a reload outlives the run.
   */
  const bounded = <T>(what: string, start: () => Promise<T>, capMs: number): Promise<T> => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(new RunTimeSpent(what));
    const byRunTime = left <= capMs;
    return withTimeout(
      (async () => start())(),
      Math.max(1, Math.floor(byRunTime ? left : capMs)),
      what,
    ).catch((error: unknown) => {
      if (byRunTime && Date.now() >= deadline) throw new RunTimeSpent(what);
      throw error;
    });
  };

  const progressed = (now: number) => {
    lastChangeAt = now;
    stallReloads = 0;
    stallAnchor = now;
    hiddenReloads = 0;
  };

  const sample = async (): Promise<void> => {
    const readIn = epoch;
    const askedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { result } = await Promise.race([
        Runtime.evaluate({ expression: buildTurnProgressExpression(), returnByValue: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PageNotAnswering("no answer")), frozenMs);
          timer.unref?.();
        }),
      ]);
      // The page answered: whatever it shows, it is not frozen.
      if (readIn === epoch) frozenSince = null;
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
    } catch (error) {
      // A failed read is not a change; the next poll reads again. A read that never answers
      // means the renderer stopped: the page is recovered (see recoverFrozen).
      if (error instanceof PageNotAnswering && !reloading && readIn === epoch) {
        frozenSince = askedAt;
        void decide();
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const resolveUrl = async (): Promise<string | null> => {
    const known = options.conversationUrl?.();
    if (known && conversationIdFromUrl(known)) return known;
    try {
      const { result } = await bounded(
        "reading the page URL",
        () => Runtime.evaluate({ expression: "location.href", returnByValue: true }),
        PAGE_COMMAND_MS,
      );
      const href = typeof result?.value === "string" ? result.value : "";
      if (conversationIdFromUrl(href)) return href;
    } catch {
      // fall back to the last conversation URL the page showed
    }
    return pageConversationUrl;
  };

  const decide = async (): Promise<void> => {
    // With the run's time spent the attempt ends on its own timeout; a reload would not help.
    if (reloading || deciding || !waiter || Date.now() >= deadline) return;
    deciding = true;
    try {
      const now = Date.now();
      const quiet = now - lastChangeAt;
      let reason: string | null = null;
      let kind: Trigger["kind"] = "stall";
      if (frozenSince !== null) {
        kind = "frozen";
        reason = formatQuiet(now - frozenSince);
      } else if (now - stallAnchor >= stallMs * 2 ** stallReloads) {
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
      // A frozen page answers no URL read; its conversation URL comes from the run or earlier reads.
      const known = options.conversationUrl?.();
      const url =
        kind === "frozen"
          ? known && conversationIdFromUrl(known)
            ? known
            : pageConversationUrl
          : await resolveUrl();
      // The wait may have ended (or a reload begun) while the URL was read.
      if (!waiter || reloading) return;
      if (!url && kind !== "frozen") {
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
      } else if (kind === "hidden") {
        hiddenReloads += 1;
      }
      if (kind !== "frozen") {
        logger(`[browser] Turn looks stalled (${reason}); reloading the conversation to resync`);
      }
      const wake = waiter;
      waiter = null;
      wake?.({ url, reason, kind, since: frozenSince ?? undefined });
    } finally {
      deciding = false;
    }
  };

  const readPage = async (expression: string): Promise<unknown> => {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    return result?.value;
  };

  /**
   * Waits until `settleBy` for a document that has parsed (with `mark`: a new one, the mark
   * gone) and a turn count that holds for three reads in a row; returns that count (-1 unknown).
   */
  const settleTurns = async (step: Step, settleBy: number, mark?: string): Promise<number> => {
    const settleLeft = () => Math.max(1, settleBy - Date.now());
    const readiness = mark
      ? `window.__oracleResyncMark === ${JSON.stringify(mark)} ? 'old' : document.readyState`
      : "document.readyState";
    while (Date.now() < settleBy) {
      const state = await orElse(
        step("reading the new page", () => readPage(readiness), settleLeft()),
        "old",
      );
      if (state === "interactive" || state === "complete") break;
      await idle(250);
    }
    let turns = -1;
    let steady = 0;
    while (Date.now() < settleBy && steady < 3) {
      const count = await orElse(
        step(
          "counting the turns",
          () => readPage(buildConversationTurnCountExpression()),
          settleLeft(),
        ),
        -1,
      );
      const next = typeof count === "number" ? count : -1;
      steady = next > 0 && next === turns ? steady + 1 : 0;
      turns = next;
      await idle(250);
    }
    return turns;
  };

  /**
   * Reloads the conversation and waits until the new page shows its turns. Every step is bounded
   * by the run's remaining time and stops once `abandoned()` (RunTimeSpent / ReloadAbandoned).
   */
  const reload = async ({ url }: { url: string }, abandoned: () => boolean): Promise<void> => {
    const step: Step = (what, start, capMs) =>
      abandoned() ? Promise.reject(new ReloadAbandoned(what)) : bounded(what, start, capMs);
    const mark = randomUUID();
    await orElse(
      step(
        "marking the page",
        () => readPage(`window.__oracleResyncMark = ${JSON.stringify(mark)}`),
        PAGE_COMMAND_MS,
      ),
      undefined,
    );
    const current = await orElse(
      step("reading the page URL", () => readPage("location.href"), PAGE_COMMAND_MS),
      null,
    );
    const sameConversation =
      typeof current === "string" && conversationIdFromUrl(current) === conversationIdFromUrl(url);
    let how = "reloaded";
    try {
      if (!sameConversation) throw new Error("the tab shows another page");
      await step("Page.reload", () => Page.reload({}), PAGE_COMMAND_MS);
    } catch (reloadError) {
      if (endsReload(reloadError)) throw reloadError;
      how = "opened again";
      try {
        await step("Page.navigate", () => Page.navigate({ url }), PAGE_COMMAND_MS);
      } catch (navigateError) {
        if (endsReload(navigateError)) throw navigateError;
        logger(
          `[browser] Conversation reload failed (${message(reloadError)}; ${message(navigateError)}); waiting on the page as it is.`,
        );
        return;
      }
    }
    const turns = await settleTurns(step, Date.now() + settleMs, mark);
    logger(
      `[browser] Conversation ${how}${turns > 0 ? ` (${turns} turns on the page)` : ""}; waiting for the turn again.`,
    );
  };

  /**
   * A page that stopped answering CDP (its renderer runs an endless script): stop its script,
   * reload it from the browser side, and if it still does not answer, move the run to a new tab
   * on the conversation URL. Never resubmits and never types. Each step is bounded by its own
   * limit and by the run's remaining time.
   */
  const recoverFrozen = async (trigger: Trigger, abandoned: () => boolean): Promise<void> => {
    const since = trigger.since ?? Date.now();
    const said = (what: string) =>
      logger(
        `[browser] The page stopped answering (${Math.floor((Date.now() - since) / 1_000)}s); ${what}`,
      );
    const step: Step = (what, start, capMs) =>
      abandoned() ? Promise.reject(new ReloadAbandoned(what)) : bounded(what, start, capMs);
    const answers = (capMs: number) =>
      orElse(
        step("asking the page", () => readPage("1").then(() => true), capMs),
        false,
      );

    let turnsAfterReload = -1;
    said("stopping its script.");
    await orElse(
      step(
        "Runtime.terminateExecution",
        () => (Runtime as { terminateExecution: () => Promise<unknown> }).terminateExecution(),
        TERMINATE_WAIT_MS,
      ),
      undefined,
    );
    const answeredAfterStop = await answers(PAGE_ANSWER_WAIT_MS);
    said(
      answeredAfterStop
        ? "it answers again after its script was stopped; reloading the conversation."
        : "reloading it from the browser.",
    );
    if (answeredAfterStop && trigger.url) {
      await reload({ ...trigger, url: trigger.url }, abandoned);
    } else {
      try {
        await step("Page.reload", () => Page.reload({}), PAGE_COMMAND_MS);
      } catch (reloadError) {
        if (endsReload(reloadError)) throw reloadError;
        if (trigger.url) {
          const url = trigger.url;
          await orElse(
            step("Page.navigate", () => Page.navigate({ url }), PAGE_COMMAND_MS),
            undefined,
          );
        }
      }
      // Any answer now comes from the reloaded document; once it answers, it shows its turns
      // before the wait starts again (as after the marked reload).
      const settleBy = Date.now() + settleMs;
      let answered = false;
      while (Date.now() < settleBy) {
        answered = await answers(Math.max(1, settleBy - Date.now()));
        if (answered) break;
        await idle(250);
      }
      if (answered) turnsAfterReload = await settleTurns(step, Date.now() + settleMs);
    }
    if (await answers(PAGE_ANSWER_WAIT_MS)) {
      said(
        `it answers again${turnsAfterReload > 0 ? ` (${turnsAfterReload} turns on the page)` : ""}; waiting for the turn again.`,
      );
      return;
    }
    if (!trigger.url || !options.replaceTab) {
      said(
        "it does not answer after a reload, and no new tab can be opened; waiting on it as it is.",
      );
      return;
    }
    const url = trigger.url;
    said("opening the conversation in a new tab.");
    let tabStepOver = false;
    const replacement = await orElse(
      step("opening a new tab", () => options.replaceTab!(url, () => tabStepOver), NEW_TAB_MS),
      null,
    ).finally(() => {
      tabStepOver = true;
    });
    if (!replacement) {
      said("a new tab could not be opened; waiting on the page as it is.");
      return;
    }
    // The new tab: it has parsed and its turn count holds.
    const turns = await settleTurns(step, Date.now() + settleMs);
    if (replacement.ready) {
      await orElse(
        step("readying the new tab", () => Promise.resolve(replacement.ready!()), PAGE_COMMAND_MS),
        undefined,
      );
    }
    said(
      `the wait moved to a new tab${replacement.targetId ? ` (target ${replacement.targetId})` : ""}${turns > 0 ? ` with ${turns} turns on the page` : ""}.`,
    );
  };

  /**
   * The reload, after any approval click in flight has finished (the gate). Waiting for the gate
   * counts against the run's time too: when it is spent the reload is given up, and if its turn
   * comes later it does nothing.
   */
  const reloadInTurn = async (trigger: Trigger): Promise<void> => {
    let abandoned = false;
    const job = gate.exclusive(() =>
      abandoned
        ? Promise.resolve()
        : trigger.kind === "frozen"
          ? recoverFrozen(trigger, () => abandoned)
          : trigger.url
            ? reload({ ...trigger, url: trigger.url }, () => abandoned)
            : Promise.resolve(),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runTime = Number.isFinite(deadline)
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RunTimeSpent("the reload")),
            Math.max(0, deadline - Date.now()),
          );
        })
      : null;
    try {
      await (runTime ? Promise.race([job, runTime]) : job);
    } catch (error) {
      logger(
        endsReload(error)
          ? "[browser] The run's time for the answer ran out during the conversation reload; the wait ends as it would at its timeout."
          : `[browser] Conversation reload failed (${message(error)}); waiting on the page as it is.`,
      );
    } finally {
      abandoned = true;
      if (timer) clearTimeout(timer);
      job.catch(() => undefined);
    }
  };

  const resync: TurnResync = {
    gate,
    lastChangedAt: () => lastChangeAt,
    deadlineAt: () => deadline,
    reportHiddenApproval(surface) {
      if (reloading) return;
      hidden = { app: surface.app, state: surface.state, at: Date.now() };
      void decide();
    },
    async run<T>(
      operation: (attempt: TurnResyncAttempt) => Promise<T>,
      runOptions: { timeoutMs?: number } = {},
    ): Promise<T> {
      const startedAt = Date.now();
      progressed(startedAt);
      const timeoutMs = runOptions.timeoutMs;
      deadline =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
          ? startedAt + Math.max(0, timeoutMs)
          : Number.POSITIVE_INFINITY;
      options.timeLimit?.setDeadline(Number.isFinite(deadline) ? deadline : null);
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
          if (outcome.kind === "done") {
            // The answer is in: what follows (its markdown, artifacts) is not bound by the wait.
            options.timeLimit?.setDeadline(null);
            return outcome.value;
          }
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
            frozenSince = null;
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
