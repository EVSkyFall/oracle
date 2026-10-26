import { createHash } from "node:crypto";
import type { ChromeClient } from "./types.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";

const USER_TURN_SELECTOR =
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

/**
 * Browser-context expression for the latest user turn ({ index, text, messageId } or null). The
 * identity is the one readUserMessageIds records, so a turn can be told apart from the turns
 * rendered before a send.
 */
export function buildLatestUserTurnExpression(): string {
  const userSelector = JSON.stringify(USER_TURN_SELECTOR);
  return `(() => {
        const turns = ${buildConversationTurnListExpression()};
        for (let index = turns.length - 1; index >= 0; index--) {
          const turn = turns[index];
          const user = turn.matches?.(${userSelector}) ? turn : turn.querySelector?.(${userSelector});
          if (user) return { index, text: (user.querySelector?.('[data-user-message-bubble="true"]') || user).textContent ?? null, messageId: user.getAttribute?.('data-message-id') || user.getAttribute?.('data-chatgpt-selection-message-id') || user.getAttribute?.('data-chatgpt-search-message-ids')?.split(' ')[0] || user.closest?.('[data-turn-key]')?.getAttribute('data-turn-key') || (user.getAttribute?.('data-content-search-unit-key') || user.getAttribute?.('data-chatgpt-search-unit-key')) || null };
        }
        return null;
      })()`;
}

/** The submitted-turn fingerprint of a user turn already read from the page, if it has one. */
export function fingerprintOfUserTurn(
  turn: { text?: string | null; messageId?: string | null } | null | undefined,
): string | undefined {
  if (!turn?.text?.trim() || !turn.messageId?.trim()) return undefined;
  return browserPromptFingerprint(turn.text, turn.messageId);
}

export async function readSubmittedPromptFingerprint(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  timeoutMs = 0,
): Promise<string | undefined> {
  if (previousMessageIds === undefined) return undefined;
  const previous = new Set(previousMessageIds);
  return readDomUntil(runtime, buildLatestUserTurnExpression(), timeoutMs, (value) => {
    const turn = value as { text?: unknown; messageId?: unknown } | null;
    if (
      typeof turn?.text === "string" &&
      turn.text.trim() &&
      typeof turn.messageId === "string" &&
      turn.messageId.trim() &&
      !previous.has(turn.messageId)
    )
      return browserPromptFingerprint(turn.text, turn.messageId);
    return undefined;
  });
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
