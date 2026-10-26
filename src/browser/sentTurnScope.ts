import type { ChromeClient } from "./types.js";
import type { TurnResyncAttempt } from "./turnResync.js";
import { waitForSentUserTurn } from "./promptFingerprint.js";

export interface SentTurnScope {
  /** The user turn identities rendered before the send. */
  previousUserMessageIds: readonly string[];
  /** The answer wait's current start (the turn index the run passes as minTurnIndex). */
  current: () => number | null;
  /** Moves the answer wait's start to the sent user turn. */
  moveTo: (index: number) => void;
}

/** Reads the sent user turn once (by id) and moves the scope there; true when it is mounted. */
export async function scopeToSentTurnNow(
  runtime: ChromeClient["Runtime"],
  scope: SentTurnScope,
): Promise<boolean> {
  const index = await waitForSentUserTurn(runtime, scope.previousUserMessageIds, {
    timeoutMs: 0,
  });
  if (index === null) return false;
  if (index !== scope.current()) scope.moveTo(index);
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
  const watcher = waitForSentUserTurn(runtime, scope.previousUserMessageIds, {
    signal: stopWatching.signal,
    timeoutMs: attempt.remainingMs(totalMs),
    pollMs: 2_000,
  })
    .then((index) => {
      if (index === null || stopWatching.signal.aborted || index === scope.current()) return;
      scope.moveTo(index);
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
