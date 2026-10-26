import { createHash } from "node:crypto";
import type { ChromeClient } from "./types.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
import { promptAppearsInText } from "./promptMatch.js";

export const USER_TURN_SELECTOR =
  ':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])';

export function browserPromptFingerprint(value: unknown, messageId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([messageId, String(value ?? "").replace(/\r\n?/g, "\n")]))
    .digest("hex");
}

export function readUserMessageIds(
  runtime: ChromeClient["Runtime"],
  timeoutMs = 0,
): Promise<string[] | undefined> {
  return readDomUntil(
    runtime,
    `Array.from(document.querySelectorAll(':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])'), user => user.getAttribute('data-message-id') || user.getAttribute('data-chatgpt-selection-message-id') || user.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0] || user.closest('[data-turn-key]')?.getAttribute('data-turn-key') || (user.getAttribute('data-content-search-unit-key') || user.getAttribute('data-chatgpt-search-unit-key')))`,
    timeoutMs,
    (value) =>
      Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim())
        ? (value as string[])
        : undefined,
  );
}

/** A user turn as read from the page: its index in the turn list, raw text and identity. */
export interface PageUserTurn {
  index: number;
  text: string | null;
  messageId: string | null;
}

/** Browser-context helpers that read the user turns of the turn list, in document order. */
function userTurnsReaderJs(): string {
  const userSelector = JSON.stringify(USER_TURN_SELECTOR);
  return `const readUserTurns = () => {
          const turns = ${buildConversationTurnListExpression()};
          const users = [];
          for (let index = 0; index < turns.length; index++) {
            const turn = turns[index];
            const user = turn.matches?.(${userSelector}) ? turn : turn.querySelector?.(${userSelector});
            if (user) users.push({ index, text: (user.querySelector?.('[data-user-message-bubble="true"]') || user).textContent ?? null, messageId: user.getAttribute?.('data-message-id') || user.getAttribute?.('data-chatgpt-selection-message-id') || user.getAttribute?.('data-chatgpt-search-message-ids')?.split(' ')[0] || user.closest?.('[data-turn-key]')?.getAttribute('data-turn-key') || (user.getAttribute?.('data-content-search-unit-key') || user.getAttribute?.('data-chatgpt-search-unit-key')) || null });
          }
          return users;
        };`;
}

/**
 * Browser-context expression for the latest user turn ({ index, text, messageId } or null). The
 * identity is the one readUserMessageIds records, so a turn can be told apart from the turns
 * rendered before a send.
 */
export function buildLatestUserTurnExpression(): string {
  return `(() => {
        ${userTurnsReaderJs()}
        return readUserTurns().at(-1) ?? null;
      })()`;
}

/** Browser-context expression for every rendered user turn ({ index, text, messageId }[]). */
export function buildUserTurnsExpression(): string {
  return `(() => {
        ${userTurnsReaderJs()}
        return readUserTurns();
      })()`;
}

/** What identifies the user turn a send produced. */
export interface SentTurnQuery {
  /** The user turn identities rendered before the send (readUserMessageIds). */
  previousMessageIds: readonly string[];
  /** Its own id, once known (the commit check found it): then only that exact turn is it. */
  sentMessageId?: string | null;
  /** The prompt the send typed. */
  prompt?: string | null;
}

/**
 * Browser-context expression for a candidate for the user turn a send produced, or null. With its
 * id known, the turn with exactly that id. Without it, the latest user turn when its id was not
 * rendered before the send, flagged `presendUnrendered` when no pre-send user turn is rendered
 * now, so nothing on the page places it after them (acceptSentUserTurn decides).
 */
export function buildSentUserTurnExpression(query: SentTurnQuery): string {
  return `(() => {
        ${userTurnsReaderJs()}
        const previous = new Set(${JSON.stringify(query.previousMessageIds)});
        const sentId = ${JSON.stringify(query.sentMessageId ?? null)};
        const users = readUserTurns();
        if (sentId) return users.find((user) => user.messageId === sentId) ?? null;
        const latest = users.at(-1);
        if (!latest?.messageId || previous.has(latest.messageId)) return null;
        const presendUnrendered =
          previous.size > 0 && !users.some((user) => user.messageId && previous.has(user.messageId));
        return { ...latest, presendUnrendered };
      })()`;
}

/**
 * The user turn a send produced, from a buildSentUserTurnExpression read. An older turn that
 * renders later (a scroll, a reload, a different window) is never taken for it merely because its
 * id was not among the pre-send ones: the latest user turn stands for it only after a pre-send
 * user turn that is still rendered, or, with none rendered, when it shows the sent prompt.
 */
export function acceptSentUserTurn(value: unknown, query: SentTurnQuery): PageUserTurn | null {
  const turn = value as (PageUserTurn & { presendUnrendered?: boolean }) | null | undefined;
  if (typeof turn?.messageId !== "string" || !turn.messageId) return null;
  const accepted = {
    index: typeof turn.index === "number" ? turn.index : -1,
    text: turn.text ?? null,
    messageId: turn.messageId,
  };
  if (query.sentMessageId) return turn.messageId === query.sentMessageId ? accepted : null;
  if (query.previousMessageIds.includes(turn.messageId)) return null;
  if (turn.presendUnrendered && !(query.prompt && promptAppearsInText(query.prompt, turn.text))) {
    return null;
  }
  return accepted;
}

/**
 * The user turn a send produced (acceptSentUserTurn), waiting while the page does not show it:
 * the new exchange can mount late, or after a reload in a different window of turns. Null when
 * the wait ends first: its time is up or `signal` aborts.
 */
export async function waitForSentUserTurn(
  runtime: ChromeClient["Runtime"],
  query: SentTurnQuery,
  options: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number } = {},
): Promise<PageUserTurn | null> {
  const expression = buildSentUserTurnExpression(query);
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 0);
  const pollMs = Math.max(10, options.pollMs ?? 500);
  for (;;) {
    if (options.signal?.aborted) return null;
    try {
      const { result } = await runtime.evaluate({ expression, returnByValue: true });
      const turn = acceptSentUserTurn(result?.value, query);
      if (turn && turn.index >= 0) return turn;
    } catch {
      // A reload or navigation in progress: read again.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(pollMs, remaining));
      function done() {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", done);
        resolve();
      }
      options.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/** The submitted-turn fingerprint of a user turn already read from the page, if it has one. */
export function fingerprintOfUserTurn(
  turn: { text?: string | null; messageId?: string | null } | null | undefined,
): string | undefined {
  if (!turn?.text?.trim() || !turn.messageId?.trim()) return undefined;
  return browserPromptFingerprint(turn.text, turn.messageId);
}

/** The fingerprint of the user turn a send produced (acceptSentUserTurn), if the page shows it. */
export async function readSubmittedPromptFingerprint(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  timeoutMs = 0,
  prompt?: string | null,
): Promise<string | undefined> {
  if (previousMessageIds === undefined) return undefined;
  const query: SentTurnQuery = { previousMessageIds, prompt };
  return readDomUntil(runtime, buildSentUserTurnExpression(query), timeoutMs, (value) =>
    fingerprintOfUserTurn(acceptSentUserTurn(value, query)),
  );
}

async function readDomUntil<T>(
  runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutMs: number,
  select: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      const result = await runtime.evaluate({ expression, returnByValue: true });
      const selected = select(result.result?.value);
      if (selected !== undefined) return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/Cannot find (?:default )?(?:execution )?context|Execution context (?:was destroyed|is not available)/i.test(
          message,
        )
      )
        return undefined;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}
