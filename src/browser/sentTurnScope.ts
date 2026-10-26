import type { ChromeClient } from "./types.js";
import type { TurnResyncAttempt } from "./turnResync.js";
import { waitForSentUserTurn, type SentTurnQuery } from "./promptFingerprint.js";

/** What identifies the user turn a send produced, kept for the run's answer waits. */
export interface SentTurnRecord {
  /** The user turn identities rendered before the send. */
  previousUserMessageIds: readonly string[];
  /** Its id: from the commit check, else recorded here the first time the turn is found. */
  messageId: string | null;
  /** The prompt the send typed. */
  prompt: string | null;
}

export interface SentTurnScope {
  turn: SentTurnRecord;
  /** The answer wait's current start (the turn index the run passes as minTurnIndex). */
  current: () => number | null;
  /** Moves the answer wait's start to the sent user turn. */
  moveTo: (index: number) => void;
}

function queryOf(turn: SentTurnRecord): SentTurnQuery {
  return {
    previousMessageIds: turn.previousUserMessageIds,
    sentMessageId: turn.messageId,
    prompt: turn.prompt,
  };
}

/** Records the found turn's id: from then on only that exact turn is the sent one. */
function settle(scope: SentTurnScope, found: { index: number; messageId: string | null }): boolean {
  if (!scope.turn.messageId && found.messageId) scope.turn.messageId = found.messageId;
  if (found.index === scope.current()) return false;
  scope.moveTo(found.index);
  return true;
}

/** Reads the sent user turn once and moves the scope there; true when it is mounted. */
export async function scopeToSentTurnNow(
  runtime: ChromeClient["Runtime"],
  scope: SentTurnScope,
): Promise<boolean> {
  const found = await waitForSentUserTurn(runtime, queryOf(scope.turn), { timeoutMs: 0 });
  if (!found) return false;
  settle(scope, found);
  return true;
}

/**
 * Runs one answer-wait attempt starting at the user turn this run sent, found by its identity.
 * When that turn is mounted the attempt starts there (a reload can render a different window of
 * turns). When it is not mounted yet the wait starts at once at the current scope, never held
 * back, and is restarted at the sent turn as soon as it mounts at another index, e.g. after the
 * commit window passed.
 */
export async function waitAtSentTurn<T>(
  runtime: ChromeClient["Runtime"],
  scope: SentTurnScope | null,
  attempt: TurnResyncAttempt,
  totalMs: number,
  operation: (attempt: TurnResyncAttempt) => Promise<T>,
): Promise<T> {
  if (!scope || (await scopeToSentTurnNow(runtime, scope).catch(() => false))) {
    return operation(attempt);
  }
  // The wait's own signal ends only with the attempt or for a restart; the watcher has its own.
  const restart = new AbortController();
  const stopWatching = new AbortController();
  const relay = () => {
    restart.abort(attempt.signal.reason);
    stopWatching.abort();
  };
  attempt.signal.addEventListener("abort", relay, { once: true });
  if (attempt.signal.aborted) relay();
  let moved = false;
  // A read every 2 s: it can run for a whole long answer.
  const watcher = waitForSentUserTurn(runtime, queryOf(scope.turn), {
    signal: stopWatching.signal,
    timeoutMs: attempt.remainingMs(totalMs),
    pollMs: 2_000,
  })
    .then((found) => {
      if (!found || stopWatching.signal.aborted || !settle(scope, found)) return;
      moved = true;
      restart.abort();
    })
    .catch(() => undefined);
  try {
    return await operation({ signal: restart.signal, remainingMs: attempt.remainingMs });
  } catch (error) {
    if (!moved || attempt.signal.aborted) throw error;
  } finally {
    attempt.signal.removeEventListener("abort", relay);
    stopWatching.abort();
    await watcher;
  }
  // The sent turn mounted elsewhere: the wait starts again there, with the attempt's own time.
  return operation(attempt);
}
