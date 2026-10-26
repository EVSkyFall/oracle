import { withoutBrowserCancellation } from "../cancellation.js";
import type { BrowserAppMention, ChromeClient, BrowserLogger } from "../types.js";
import { randomUUID } from "node:crypto";
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
} from "../constants.js";
import {
  buildConversationTurnCountExpression,
  buildConversationTurnListExpression,
} from "../conversationTurns.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import {
  assertComposerNavigationSnapshot,
  assertComposerPlusStayedInPlace,
  buildAttachmentNamePattern,
  composerNavigationIdentityFromUrl,
} from "./attachments.js";
import { buildComposerNavigationValidationExpression } from "./attachmentContext.js";
import { buildClickDispatcher } from "./domEvents.js";
import { stageAttachmentPrompt } from "./attachmentPrompt.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { buildAttachmentEvidenceExpression } from "./attachmentEvidence.js";
import { buildAttachmentProgressExpression } from "./attachmentProgress.js";
import { buildActiveComposerRootExpression } from "./composerRoot.js";
import { findComposerEditor } from "./composerEditor.js";
import { buildInstallCompletionAnnouncementExpression } from "./completionAnnouncement.js";
import { activateWebSearch } from "./webSearch.js";
import {
  COMPOSER_PLUS_SELECTORS,
  COMPOSER_TOKEN_SELECTOR,
  findComposerPlusButton,
  readComposerPromptText,
} from "./composerTools.js";
import { hasDeepResearchMention } from "./deepResearch.js";
import { assertAppMentionsPresent, insertAppMentions } from "./appMentions.js";
import { assertComposerTierWithinCap } from "./thinkingTimeCap.js";
import { normalizePromptText } from "../promptMatch.js";
import {
  buildLatestUserTurnExpression,
  readUserMessageIds,
  type PageUserTurn,
} from "../promptFingerprint.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";

const ENTER_KEY_EVENT = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = "\r";
const ESCAPE_KEY_EVENT = {
  key: "Escape",
  code: "Escape",
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27,
} as const;

export interface AttachmentReadyExpectation {
  name: string;
  generatedBundle?: boolean;
}

type AttachmentReadyInput = string | AttachmentReadyExpectation;

/**
 * Splits a prompt into paste chunks of at most `size` UTF-16 units, never inside a surrogate
 * pair or a CRLF, with line endings normalised to \n. Boundaries fall wherever the size says,
 * inside lines too. Injected into the page with Function.prototype.toString.
 */
export function splitPasteChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    if (text[end - 1] === "\r" && text[end] === "\n") end--;
    chunks.push(text.slice(i, end).replace(/\r\n?/g, "\n"));
    i = end;
  }
  return chunks;
}

/**
 * Page expression: pastes a multi-line prompt into the contenteditable composer in chunks and
 * reports whether the staged text matches it exactly.
 */
export function buildMultilinePasteExpression(prompt: string): string {
  return `(() => {
        const selectors = ${JSON.stringify(INPUT_SELECTORS)};
        const visible = (node) => { const r = node?.getBoundingClientRect?.(); return Boolean(r && r.width > 0 && r.height > 0); };
        const found = (${findComposerEditor.toString()})(document, selectors);
        const editor = found && visible(found) ? found : null;
        if (editor instanceof HTMLTextAreaElement) return { used: false };
        if (!editor?.isContentEditable) return { used: true, complete: false };
        const text = ${JSON.stringify(prompt)};
        // ChatGPT converts a single large paste (seen above ~10k chars) into a "Pasted text"
        // file chip and leaves the editor empty, so paste in chunks well under that size.
        const CHUNK = 4000;
        const chips = () => document.querySelectorAll('form button[aria-label^="Remove Pasted text"]').length;
        const chipsBefore = chips();
        editor.focus();
        for (const chunk of (${splitPasteChunks.toString()})(text, CHUNK)) {
          const data = new DataTransfer();
          data.setData('text/plain', chunk);
          // Explicit hard breaks preserve blank lines that a plain-text paragraph parser can collapse.
          const paragraph = document.createElement('p');
          paragraph.style.whiteSpace = 'pre-wrap';
          paragraph.textContent = chunk;
          data.setData('text/html', paragraph.outerHTML.replace(/\\n/g, '<br>'));
          editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }
        // innerText adds layout spacing between paragraphs. Read actual hard breaks and block
        // boundaries instead, without mentions/pills staged before the text (a mention leaves
        // its separating space ahead of the prompt).
        const staged = (${readComposerPromptText.toString()})(editor, ${JSON.stringify(COMPOSER_TOKEN_SELECTOR)});
        const normalize = value => value.replace(/\\r\\n?/g, '\\n');
        const comparable = value => staged.tokens > 0 ? value.replace(/^\\s+/, '') : value;
        const landed = comparable(normalize(staged.text));
        const expected = comparable(normalize(text));
        const convertedToFile = chips() > chipsBefore;
        return { used: true, length: landed.length, expected: expected.length, complete: landed === expected, convertedToFile };
      })()`;
}

export async function submitPrompt(
  deps: {
    runtime: ChromeClient["Runtime"];
    input: ChromeClient["Input"];
    page?: ChromeClient["Page"];
    /**
     * Bring the target to the front before trusted clicks (default). `false` skips this
     * explicit activation and relies on the caller having enabled focus emulation.
     */
    activateBeforeTrustedInput?: boolean;
    attachmentNames?: AttachmentReadyInput[];
    attachmentNavigationUrl?: string;
    baselineTurns?: number | null;
    inputTimeoutMs?: number | null;
    attachmentTimeoutMs?: number | null;
    onPromptSubmitted?: () => Promise<void> | void;
    webSearch?: boolean;
    /** Deep Research was activated before staging; its editor mention must still be there. */
    deepResearch?: boolean;
    /** Apps to mention ahead of the prompt text. */
    apps?: readonly BrowserAppMention[];
    /** --browser-max-thinking-time: the composer button is checked once more before the click. */
    maxThinkingTime?: ThinkingTimeLevel;
    /**
     * The send went out but its commit could not be proven; the run goes on. Called with the
     * latest user turn when it shows the prompt and is not provably an older turn, else null.
     */
    onCommitUnproven?: (turn: PageUserTurn | null) => void;
    /** The commit was proven by the sent user turn: called with that turn. */
    onCommitted?: (turn: PageUserTurn) => void;
    /**
     * The user turn identities rendered before the send, as the run read them (with its input
     * timeout) before staging the prompt. Read here once when not given.
     */
    baselineUserIds?: readonly string[];
  },
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  const { runtime, input } = deps;
  const hasAttachments = Array.isArray(deps.attachmentNames) && deps.attachmentNames.length > 0;
  if (hasAttachments && !deps.attachmentNavigationUrl) {
    throw new BrowserAutomationError(
      "Oracle cannot safely submit attachments without the pre-upload ChatGPT page identity.",
      {
        stage: "submit-prompt",
        code: "attachment-navigation-identity-unavailable",
      },
    );
  }
  if (hasAttachments) {
    await assertComposerPlusStayedInPlace(runtime, deps.attachmentNavigationUrl!);
  }

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  const apps = deps.apps ?? [];
  if (apps.length > 0) await insertAppMentions(runtime, input, apps, logger);
  let observedLength: number;
  if (hasAttachments) {
    observedLength = await stageAttachmentPrompt(runtime, prompt, deps.attachmentNavigationUrl!);
  } else {
    const encodedPrompt = JSON.stringify(prompt);
    const focusResult = await runtime.evaluate({
      expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        // Learned: React/ProseMirror require a real click + focus + selection for inserts to stick.
        dispatchClickSequence(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      // The visible composer, never a hidden one an in-page move left behind.
      const preferred = (${findComposerEditor.toString()})(document, SELECTORS);
      if (preferred && focusNode(preferred)) {
        return { focused: true };
      }
      return { focused: false };
    })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (!focusResult.result?.value?.focused) {
      await logDomFailure(runtime, logger, "focus-textarea");
      throw new Error("Failed to focus prompt textarea");
    }

    // ProseMirror can treat typed newlines as submission; paste without pressing Enter.
    let pastedMultiline = false;
    if (prompt.includes("\n")) {
      const pasteResult = await runtime.evaluate({
        expression: buildMultilinePasteExpression(prompt),
        returnByValue: true,
      });
      const pasted = pasteResult.result?.value as
        | {
            used?: boolean;
            length?: number;
            expected?: number;
            complete?: boolean;
            convertedToFile?: boolean;
          }
        | undefined;
      if (pasted?.used !== false) {
        const complete = pasted?.complete === true && !pasted.convertedToFile;
        if (!complete) {
          // Never fall back to typing here: a typed newline submits the first line only.
          throw new BrowserAutomationError(
            `ChatGPT did not accept the pasted prompt intact (${pasted?.length ?? 0}/${pasted?.expected ?? 0} chars${pasted?.convertedToFile ? ", converted to a file" : ""}); nothing was sent.`,
            { stage: "submit-prompt", code: "prompt-paste-incomplete" },
          );
        }
      }
      pastedMultiline = Boolean(pasted?.used && (pasted.length ?? 0) > 0);
      logger(
        `Prompt delivery: ${pastedMultiline ? "paste (multi-line, contenteditable)" : "typed"}`,
      );
    }
    if (!pastedMultiline) {
      await input.insertText({ text: prompt });
    }

    // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
    // before the send button becomes enabled; give it a short breather to avoid races.
    await delay(500);

    const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
    const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
    const verification = await runtime.evaluate({
      expression: `(() => {
      const editor = (${findComposerEditor.toString()})(document, [${primarySelectorLiteral}]);
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const tokenSelector = ${JSON.stringify(COMPOSER_TOKEN_SELECTOR)};
      const readPrompt = ${readComposerPromptText.toString()};
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        // A staged mention or tool pill is not prompt text.
        if (node.querySelector?.(tokenSelector)) return readPrompt(node, tokenSelector).text;
        return node.innerText ?? '';
      };
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: readValue(editor),
        fallbackValue: fallback?.value ?? '',
        activeValue: active ? readValue(active) : '',
      };
    })()`,
      returnByValue: true,
    });

    const editorTextRaw = verification.result?.value?.editorText ?? "";
    const fallbackValueRaw = verification.result?.value?.fallbackValue ?? "";
    const activeValueRaw = verification.result?.value?.activeValue ?? "";
    const editorTextTrimmed = editorTextRaw?.trim?.() ?? "";
    const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? "";
    const activeValueTrimmed = activeValueRaw?.trim?.() ?? "";
    if (!editorTextTrimmed && !fallbackValueTrimmed && !activeValueTrimmed) {
      // Learned: occasionally Input.insertText doesn't land in the editor; force textContent/value + input events.
      await runtime.evaluate({
        expression: `(() => {
        const fallback = document.querySelector(${fallbackSelectorLiteral});
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = (${findComposerEditor.toString()})(document, [${primarySelectorLiteral}]);
        if (editor && editor.querySelector(${JSON.stringify(COMPOSER_TOKEN_SELECTOR)})) {
          // Replacing textContent would drop the staged mentions; insert after them instead.
          editor.focus();
          const selection = document.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand('insertText', false, ${encodedPrompt});
        } else if (editor) {
          editor.textContent = ${encodedPrompt};
          // Nudge ProseMirror to register the textContent write so its state/send-button updates
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        }
      })()`,
      });
    }

    const postVerification = await runtime.evaluate({
      expression: `(() => {
      const editor = (${findComposerEditor.toString()})(document, [${primarySelectorLiteral}]);
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const tokenSelector = ${JSON.stringify(COMPOSER_TOKEN_SELECTOR)};
      const readPrompt = ${readComposerPromptText.toString()};
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        // A staged mention or tool pill is not prompt text.
        if (node.querySelector?.(tokenSelector)) return readPrompt(node, tokenSelector).text;
        return node.innerText ?? '';
      };
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: readValue(editor),
        fallbackValue: fallback?.value ?? '',
        activeValue: active ? readValue(active) : '',
      };
    })()`,
      returnByValue: true,
    });
    const observedEditor = postVerification.result?.value?.editorText ?? "";
    const observedFallback = postVerification.result?.value?.fallbackValue ?? "";
    const observedActive = postVerification.result?.value?.activeValue ?? "";
    observedLength = Math.max(
      observedEditor.length,
      observedFallback.length,
      observedActive.length,
    );
  }
  const promptLength = prompt.length;
  if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
    await logDomFailure(runtime, logger, "prompt-too-large");
    throw new BrowserAutomationError(
      "Prompt appears truncated in the composer (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength,
        observedLength,
      },
    );
  }

  if (deps.webSearch) await activateWebSearch(runtime, input, prompt, logger);
  if (deps.deepResearch && !(await hasDeepResearchMention(runtime))) {
    // Without the mention ChatGPT answers normally instead of starting Deep Research.
    throw new BrowserAutomationError(
      "The Deep research mention left the composer while the prompt was staged; nothing was sent.",
      { stage: "submit-prompt", code: "deep-research-mention-lost" },
    );
  }
  await assertAppMentionsPresent(runtime, apps);
  await warnIfChatListRateLimited(runtime, logger);

  // The user turns rendered before the send: a turn not among them is a new one, even when a
  // long conversation unmounts an old turn for it and the count stays the same.
  const baselineUserIds = deps.baselineUserIds ?? (await readUserMessageIds(runtime, 0));
  // Without ids, the text of the latest user turn before the send is what tells a new one apart.
  const baselineLatestUserText = await runtime
    .evaluate({ expression: buildLatestUserTurnExpression(), returnByValue: true })
    .then(({ result }) => {
      const turn = result?.value as PageUserTurn | null | undefined;
      return turn === null ? null : typeof turn?.text === "string" ? turn.text : undefined;
    })
    .catch(() => undefined);

  // Install before the click: a short answer can complete while commit verification runs.
  await runtime
    .evaluate({
      expression: buildInstallCompletionAnnouncementExpression(deps.baselineTurns),
      returnByValue: true,
    })
    .catch(() => undefined);

  // Never Pro: the composer is checked once more right before each actual send (click, the
  // attachment Enter, the fallback Enter), after every wait, menu close and page activation.
  const maxThinkingTime = deps.maxThinkingTime;
  const beforeSend = maxThinkingTime
    ? () => assertComposerTierWithinCap(runtime, maxThinkingTime, logger)
    : undefined;

  const clicked = await attemptSendButton(
    runtime,
    input,
    logger,
    deps?.attachmentNames,
    deps?.attachmentTimeoutMs,
    deps?.activateBeforeTrustedInput === false ? undefined : deps?.page,
    deps?.attachmentNavigationUrl,
    beforeSend,
  );
  if (!clicked) {
    await beforeSend?.();
    await dispatchEnterKey(input);
    logger("Submitted prompt via Enter key");
  } else {
    logger("Activated send button");
  }
  await deps.onPromptSubmitted?.();

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  return await verifyPromptCommitted(
    runtime,
    prompt,
    commitTimeoutMs,
    logger,
    deps.baselineTurns ?? undefined,
    {
      baselineUserIds,
      baselineLatestUserText,
      onUnproven: deps.onCommitUnproven,
      onCommitted: deps.onCommitted,
    },
  );
}

async function dispatchEnterKey(Input: ChromeClient["Input"]): Promise<void> {
  await Input.dispatchKeyEvent({
    type: "keyDown",
    ...ENTER_KEY_EVENT,
    text: ENTER_KEY_TEXT,
    unmodifiedText: ENTER_KEY_TEXT,
  });
  await Input.dispatchKeyEvent({
    type: "keyUp",
    ...ENTER_KEY_EVENT,
  });
}

export async function clearPromptComposer(Runtime: ChromeClient["Runtime"], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${inputSelectorsLiteral};
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = (${findComposerEditor.toString()})(document, [${primarySelectorLiteral}]);
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value ?? '';
        return node.innerText ?? node.textContent ?? '';
      };
      const dispatchClearEvents = (node) => {
        try {
          node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: null, inputType: 'deleteContentBackward' }));
        } catch {}
        try {
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        } catch {
          node.dispatchEvent(new Event('input', { bubbles: true }));
        }
        node.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const clearEditable = (node) => {
        if (!node) return false;
        try {
          node.focus?.();
        } catch {}
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          node.value = '';
          dispatchClearEvents(node);
          return true;
        }
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') {
          try {
            const selection = node.ownerDocument?.getSelection?.();
            const range = node.ownerDocument?.createRange?.();
            if (selection && range) {
              range.selectNodeContents(node);
              selection.removeAllRanges();
              selection.addRange(range);
              node.ownerDocument?.execCommand?.('delete', false);
            }
          } catch {}
          node.textContent = '';
          dispatchClearEvents(node);
          return true;
        }
        return false;
      };
      let cleared = false;
      // The visible composer too: an in-page move can leave a hidden one first in the page.
      const nodes = [
        (${findComposerEditor.toString()})(document, SELECTORS),
        ...SELECTORS.map((selector) => document.querySelector(selector)),
      ].filter((node) => Boolean(node));
      for (const node of Array.from(new Set([fallback, editor, ...nodes])).filter(Boolean)) {
        cleared = clearEditable(node) || cleared;
      }
      const remaining = Array.from(new Set([fallback, editor, ...nodes]))
        .filter(Boolean)
        .map((node) => readValue(node).trim())
        .filter(Boolean);
      return { cleared, remaining };
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value as { cleared?: boolean; remaining?: string[] } | undefined;
  if (!value?.cleared || (value.remaining?.length ?? 0) > 0) {
    await logDomFailure(Runtime, logger, "clear-composer");
    throw new Error("Failed to clear prompt composer");
  }
  await delay(250);
}

async function waitForDomReady(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const ready = document.readyState === 'complete';
        const composer = document.querySelector('[data-testid*="composer"]') || document.querySelector('form');
        const fileInput = document.querySelector('input[type="file"]');
        return { ready, composer: Boolean(composer), fileInput: Boolean(fileInput) };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as
      | { ready?: boolean; composer?: boolean; fileInput?: boolean }
      | undefined;
    if (value?.ready && value.composer) {
      return;
    }
    await delay(150);
  }
  logger?.(`Page did not reach ready/composer state within ${timeoutMs}ms; continuing cautiously.`);
}

export function buildChatListRateLimitExpressionForTest(): string {
  return `(() => {
    // A resumed conversation may still be usable while the unrelated sidebar list is limited.
    if (/\\/c\\/[^/]+/.test(location.pathname || '')) return false;
    const chatListUnavailable = Array.from(document.querySelectorAll('[role="status"]')).some((node) =>
      /loading chats|unable to load history|チャット.*読み込|履歴.*読み込/i.test((node.textContent || '').trim())
    );
    if (!chatListUnavailable) return false;
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return false;
    return performance.getEntriesByType('resource')
      .filter((entry) => {
        try { return new URL(entry.name, location.href).pathname === '/backend-api/conversations'; }
        catch { return false; }
      })
      .slice(-5)
      .some((entry) => entry.responseStatus === 429);
  })()`;
}

export async function warnIfChatListRateLimited(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<void> {
  const response = await Runtime.evaluate({
    expression: buildChatListRateLimitExpressionForTest(),
    returnByValue: true,
  }).catch(() => null);
  if (response?.result?.value === true) {
    logger(
      "[browser] ChatGPT is rate-limiting its conversation list (HTTP 429); attempting the composer send anyway.",
    );
  }
}

function buildAttachmentReadyExpression(attachmentNames: AttachmentReadyInput[]): string {
  const attachmentExpectations = attachmentNames.map((attachment) => {
    const name = typeof attachment === "string" ? attachment : attachment.name;
    const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
    const generatedBundle = typeof attachment === "object" && attachment.generatedBundle === true;
    return {
      name: normalized,
      stem: normalized.replace(/\.[a-z0-9]{1,10}$/i, ""),
      namePattern: buildAttachmentNamePattern(normalized, generatedBundle)?.source ?? "",
      generatedBundle,
    };
  });
  const namesLiteral = JSON.stringify(attachmentExpectations);
  return `(() => {
    const expected = ${namesLiteral};
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const matchesExpected = (value, item) => {
      const text = normalize(value);
      if (!text) return false;
      const namePattern = item.namePattern ? new RegExp(item.namePattern, 'iu') : null;
      if (
        namePattern &&
        String(value || '').split('\\n').some((candidate) => namePattern.test(normalize(candidate)))
      ) {
        return true;
      }
      if (text.includes('…') || text.includes('...')) {
        const marker = text.includes('…') ? '…' : '...';
        const [prefixRaw, suffixRaw] = text.split(marker);
        const prefix = normalize(prefixRaw);
        const suffix = normalize(suffixRaw);
        const prefixParts = prefix.split(' ').filter(Boolean);
        const suffixParts = suffix.split(' ').filter(Boolean);
        const prefixCandidates = prefixParts.map((_, index) => prefixParts.slice(index).join(' '));
        const suffixCandidates = suffixParts.map((_, index) =>
          suffixParts.slice(0, suffixParts.length - index).join(' '),
        );
        if (prefixCandidates.length === 0 || suffixCandidates.length === 0) return false;
        const targets = [item.name, item.stem && item.stem.length >= 4 ? item.stem : ''].filter(Boolean);
        return targets.some((target) => {
          return prefixCandidates.some((prefixPart) =>
            suffixCandidates.some((suffixPart) => {
              const strongEnough =
                suffixPart.length >= 2 &&
                (prefixPart.length >= 3 || (prefixPart.length >= 2 && suffixPart.length >= 4));
              return strongEnough && target.startsWith(prefixPart) && target.endsWith(suffixPart);
            }),
          );
        });
      }
      return false;
    };
    // Restrict to attachment affordances; never scan generic div/span nodes (prompt text can contain the file name).
    const attachmentSelectors = [
      // Current ChatGPT file tiles expose the filename through a role-group aria label.
      '[role="group"][aria-label]',
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="Remove file"]',
      'button[aria-label*="Remove file"]',
      '[aria-label*="remove file"]',
      'button[aria-label*="remove file"]',
      '[aria-label*="Remove attachment"]',
      'button[aria-label*="Remove attachment"]',
      '[aria-label*="remove attachment"]',
      'button[aria-label*="remove attachment"]',
      // ChatGPT also renders uploaded tiles as a bare "Remove <filename>" button.
      'button[aria-label^="Remove "]',
    ];
    const composer = ${buildActiveComposerRootExpression()};
    if (!composer) return false;
    // Walk node + ancestors (up to grandparent) + descendants to gather every textual hint.
    // ChatGPT's current chip DOM nests the filename inside truncated child spans, so checking
    // only the node's own textContent/aria/title misses the match.
    const collectOwnLabelHaystack = (node) => {
      if (!node) return '';
      const pieces = [];
      const pushAttrs = (el) => {
        if (!el || typeof el.getAttribute !== 'function') return;
        for (const attr of ['aria-label', 'title', 'data-testid', 'data-tooltip', 'data-tooltip-content']) {
          const v = el.getAttribute(attr);
          if (v) pieces.push(v);
        }
      };
      const pushText = (el) => {
        if (!el) return;
        const text = (el.innerText ?? el.textContent ?? '').trim();
        if (text) pieces.push(text);
      };
      pushAttrs(node);
      pushText(node);
      return pieces.join('\\n').toLowerCase();
    };
    const collectLabelHaystack = (node) => {
      if (!node) return '';
      const pieces = [collectOwnLabelHaystack(node)];
      const push = (el) => {
        if (!el || el === composer || el.querySelector?.('textarea,[contenteditable="true"]')) return;
        const text = collectOwnLabelHaystack(el);
        if (text) pieces.push(text);
      };
      const parent = node.parentElement;
      push(parent);
      const grandparent = parent?.parentElement;
      push(grandparent);
      return pieces.join('\\n').toLowerCase();
    };
    const attachmentRoots = Array.from(new Set([composer])).filter(Boolean);
    const collectChipNodes = () => {
      const seen = new Set();
      const collected = [];
      for (const root of attachmentRoots) {
        for (const node of Array.from(root.querySelectorAll(attachmentSelectors.join(',')))) {
          if (!(node instanceof HTMLElement)) continue;
          // Skip elements clearly inside the editable input (composer textarea may contain
          // filename text in the user's prompt — avoid mistaking that for a chip).
          if (node.closest('textarea,[contenteditable="true"]')) continue;
          if (seen.has(node)) continue;
          seen.add(node);
          collected.push(node);
        }
      }
      return collected;
    };
    const chipNodes = collectChipNodes();
    const chipLabels = chipNodes.map((node) => {
      // Bare filename labels stand alone; generic controls need the adjacent chip's text.
      const removeLabel = node.tagName?.toLowerCase() === 'button'
        ? node.getAttribute('aria-label') || ''
        : '';
      return /^remove /i.test(removeLabel) && !/^remove (?:attachment|file|image|photo)$/i.test(removeLabel)
        ? removeLabel.toLowerCase()
        : collectLabelHaystack(node);
    });
    const uploadEvidence = ${buildAttachmentEvidenceExpression(attachmentExpectations.map((item) => item.name))};
    const chipsReady = (() => {
      const used = new Set();
      return expected.every((item, expectedIndex) => {
        if (uploadEvidence[expectedIndex]) return true;
        const index = chipLabels.findIndex((label, candidateIndex) =>
          !used.has(candidateIndex) && matchesExpected(label, item),
        );
        if (index === -1) return false;
        used.add(index);
        return true;
      });
    })();
    const inputsReady = expected.every((item) =>
      attachmentRoots.some((root) =>
        Array.from(root.querySelectorAll('input[type="file"]')).some((el) =>
          Array.from((el instanceof HTMLInputElement ? el.files : []) || []).some((file) =>
            matchesExpected(file?.name, item),
          ),
        ),
      ),
    );
    return (chipsReady || inputsReady) && !${buildAttachmentProgressExpression("composer")};
  })()`;
}

export function buildAttachmentReadyExpressionForTest(attachmentNames: AttachmentReadyInput[]) {
  return buildAttachmentReadyExpression(attachmentNames);
}

async function attemptSendButton(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger?: BrowserLogger,
  attachmentNames?: AttachmentReadyInput[],
  attachmentTimeoutMs?: number | null,
  Page?: ChromeClient["Page"],
  attachmentNavigationUrl?: string,
  /** Runs right before each actual send action; throwing stops the send. */
  beforeSend?: () => Promise<void>,
): Promise<boolean> {
  const needAttachment = Array.isArray(attachmentNames) && attachmentNames.length > 0;
  if (needAttachment && !attachmentNavigationUrl) {
    throw new BrowserAutomationError(
      "Oracle cannot safely submit attachments without the pre-upload ChatGPT page identity.",
      {
        stage: "submit-prompt",
        code: "attachment-navigation-identity-unavailable",
      },
    );
  }
  const findButton = `
    const selectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const isEnabled = (node) => {
      const ariaDisabled = node.getAttribute('aria-disabled');
      const dataDisabled = node.getAttribute('data-disabled');
      const style = window.getComputedStyle(node);
      return !(
        node.hasAttribute('disabled') ||
        ariaDisabled === 'true' ||
        dataDisabled === 'true' ||
        style.pointerEvents === 'none' ||
        style.display === 'none'
      );
    };
    const candidates = [];
    for (const selector of selectors) {
      candidates.push(...Array.from(document.querySelectorAll(selector)));
    }
    const button = candidates.find((node) => isVisible(node) && isEnabled(node)) || null;`;
  const script = `(() => {
    ${findButton}
    if (!button) {
      // What the composer shows instead, for the log: a disabled or hidden send button, the stop
      // button of a reply that is still finishing, or nothing Oracle knows.
      const stopVisible = ${JSON.stringify(STOP_BUTTON_SELECTORS)}.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some(isVisible));
      const why = candidates.some((node) => isVisible(node)) ? 'disabled'
        : stopVisible ? 'stop'
        : candidates.length > 0 ? 'hidden' : 'none';
      return { status: 'missing', why };
    }
    const rect = button.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      // Scrolling an already-visible composer can trigger ChatGPT's layout snap.
      // If scrolling is necessary, discard these coordinates and measure later.
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return { status: 'settling' };
      }
      const hit = document.elementFromPoint(x, y);
      if (!hit || !button.contains(hit)) return { status: 'settling' };
      return { status: 'point', x, y };
    }
    // Last-resort fallback for unusual DOMs where the button is visible but has no useful rect;
    // the caller clicks it synthetically after its last check.
    return { status: 'synthetic' };
  })()`;
  const syntheticClick = `(() => {
    ${buildClickDispatcher()}
    ${findButton}
    if (!button) return { syntheticClicked: false };
    dispatchClickSequence(button);
    return { syntheticClicked: true };
  })()`;

  // Give attachment-bearing submissions more headroom. ChatGPT's chip render can
  // settle slowly for multi-file uploads, but plain text sends should keep the
  // shorter historical deadline.
  const timeoutMs = sendButtonTimeoutMs(attachmentNames, attachmentTimeoutMs);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let previousPoint: { x: number; y: number } | undefined;
  let activated = false;
  let foundButton = false;
  let attachmentMenuChecked = !needAttachment;
  // Right after a reply ChatGPT can show the send button disabled, or the stop button, for a
  // moment while the text is already in the editor; Enter does nothing then. Wait for it.
  const missingSeen = new Set<string>();
  const noteWait = () => {
    if (missingSeen.size === 0) return;
    logger?.(
      `Send button ready after ${((Date.now() - startedAt) / 1000).toFixed(1)}s (the composer showed: ${[...missingSeen].join(", ")})`,
    );
  };
  while (Date.now() < deadline) {
    if (needAttachment) {
      const ready = await Runtime.evaluate({
        expression: buildAttachmentReadyExpression(attachmentNames),
        returnByValue: true,
      });
      if (!ready?.result?.value) {
        await delay(150);
        continue;
      }
    }
    if (!attachmentMenuChecked) {
      await activatePageForTrustedInput(Page, logger);
      activated = true;
      await dismissOpenComposerPlusMenu(Runtime, Input, logger);
      attachmentMenuChecked = true;
      previousPoint = undefined;
      await delay(150);
      continue;
    }
    if (needAttachment) {
      if (
        await activateExactAttachmentSendButton(
          Runtime,
          Input,
          logger,
          attachmentNavigationUrl,
          attachmentNames,
          beforeSend,
        )
      ) {
        return true;
      }
      previousPoint = undefined;
      await delay(100);
      continue;
    }
    // Activating the target can trigger a final compositor/layout pass. Do it before
    // measuring the button so the trusted click never uses stale coordinates.
    if (!activated) {
      await activatePageForTrustedInput(Page, logger);
      activated = true;
    }
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const value = result.value as
      | {
          status?: "missing" | "point" | "settling" | "synthetic";
          x?: number;
          y?: number;
          why?: string;
        }
      | string
      | undefined;
    const status = typeof value === "string" ? value : value?.status;
    if (status === "point" || status === "settling" || status === "synthetic") foundButton = true;
    if (
      status === "point" &&
      typeof value === "object" &&
      typeof value.x === "number" &&
      typeof value.y === "number"
    ) {
      if (
        !previousPoint ||
        Math.abs(previousPoint.x - value.x) > 1 ||
        Math.abs(previousPoint.y - value.y) > 1
      ) {
        previousPoint = { x: value.x, y: value.y };
        await delay(150);
        continue;
      }
      await beforeSend?.();
      noteWait();
      await clickTrustedPoint(Runtime, Input, value.x, value.y);
      return true;
    }
    if (status === "synthetic") {
      await beforeSend?.();
      const clicked = await Runtime.evaluate({ expression: syntheticClick, returnByValue: true });
      if (clicked?.result?.value?.syntheticClicked === true) {
        noteWait();
        return true;
      }
      previousPoint = undefined;
      await delay(100);
      continue;
    }
    if (status === "missing") {
      missingSeen.add(
        typeof value === "object" && typeof value.why === "string" ? value.why : "no send button",
      );
      previousPoint = undefined;
      await delay(150);
      continue;
    }
    previousPoint = undefined;
    await delay(100);
  }
  if (!foundButton && missingSeen.size > 0) {
    logger?.(
      `No ready send button within ${Math.ceil(timeoutMs / 1000)}s (the composer showed: ${[...missingSeen].join(", ")})`,
    );
  }
  if (Array.isArray(attachmentNames) && attachmentNames.length > 0) {
    throw new BrowserAutomationError(
      `Attachments never reached the exact ready send button after ${Math.ceil(
        timeoutMs / 1000,
      )}s; tune --browser-attachment-timeout.`,
      {
        stage: "submit-prompt",
        code: "attachment-send-not-ready",
        attachmentNames,
        timeoutMs,
      },
    );
  }
  if (foundButton) {
    throw new BrowserAutomationError("Send button did not settle before input timeout.", {
      stage: "submit-prompt",
      code: "send-button-unstable",
    });
  }
  return false;
}

async function activateExactAttachmentSendButton(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger?: BrowserLogger,
  attachmentNavigationUrl?: string,
  attachmentNames: AttachmentReadyInput[] = [],
  beforeSend?: () => Promise<void>,
): Promise<boolean> {
  const exactSendSelectors = [
    'button[data-testid="send-button"]',
    'form button[type="submit"][aria-label="Send"]',
    'form button[type="submit"][aria-label="送信"]',
  ];
  const findButton = `() => {
    const root = ${buildActiveComposerRootExpression()};
    return root ? ${JSON.stringify(exactSendSelectors)}.map(selector => root.querySelector(selector)).find(Boolean) : null;
  }`;
  const probe = await Runtime.evaluate({
    expression: `(() => {
      const findButton = ${findButton};
      const button = findButton();
      if (!(button instanceof HTMLElement)) return { status: 'absent' };
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      const enabled = !button.hasAttribute('disabled') &&
        button.getAttribute('aria-disabled') !== 'true' &&
        button.getAttribute('data-disabled') !== 'true' &&
        style.pointerEvents !== 'none' &&
        style.display !== 'none' &&
        style.visibility !== 'hidden';
      if (rect.width <= 0 || rect.height <= 0 || !enabled) return { status: 'unavailable' };
      button.focus({ preventScroll: true });
      return { status: document.activeElement === button ? 'focused' : 'unavailable' };
    })()`,
    returnByValue: true,
  });
  const status = (probe?.result?.value as { status?: string } | undefined)?.status;
  if (status !== "focused") {
    return false;
  }
  if (!Input || typeof Input.dispatchKeyEvent !== "function") {
    throw new BrowserAutomationError(
      "ChatGPT's attachment send button is ready but Oracle cannot activate it safely.",
      {
        stage: "submit-prompt",
        code: "attachment-send-keyboard-unavailable",
      },
    );
  }
  const expectedIdentity = composerNavigationIdentityFromUrl(attachmentNavigationUrl ?? "");
  if (!expectedIdentity || !attachmentNavigationUrl) {
    throw new BrowserAutomationError("Attachment page identity is unavailable before dispatch.", {
      stage: "submit-prompt",
      code: "attachment-navigation-identity-unavailable",
    });
  }
  const guardId = randomUUID();
  // Recheck at event delivery too: a SPA can navigate after the CDP probe returns.
  let delivery: { sawKeyDown?: boolean; blocked?: unknown } | undefined;
  try {
    const boundary = await Runtime.evaluate({
      expression: `(() => {
        const selectors = ${JSON.stringify(exactSendSelectors)};
        const findButton = ${findButton};
        const button = findButton();
        const check = () => {
          const navigation = ${buildComposerNavigationValidationExpression(attachmentNavigationUrl)};
          const rect = button?.getBoundingClientRect();
          const style = button ? window.getComputedStyle(button) : null;
          return {
            ...navigation,
            focused: button instanceof HTMLElement && document.activeElement === button &&
              findButton() === button &&
              !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true' &&
              button.getAttribute('data-disabled') !== 'true' && rect.width > 0 && rect.height > 0 &&
              style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none',
            attachmentsReady: ${buildAttachmentReadyExpression(attachmentNames)},
          };
        };
        const safeCheck = () => {
          try { return check(); } catch { return { currentUrl: location.href, contextMatches: false, focused: false, attachmentsReady: false }; }
        };
        const snapshot = safeCheck();
        if (!snapshot.contextMatches || !snapshot.focused || !snapshot.attachmentsReady) return snapshot;
        const existing = window.__oracleAttachmentDispatchGuard;
        if (existing && !existing.finished) return { ...snapshot, focused: false };
        existing?.cleanup?.();
        const guard = { id: ${JSON.stringify(guardId)}, sawKeyDown: false, blocked: null, finished: false };
        const detach = () => {
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('keyup', onKeyUp, true);
          window.removeEventListener('click', onClick, true);
          guard.finished = true;
        };
        const cancel = (event, state) => {
          event.preventDefault(); event.stopImmediatePropagation(); guard.blocked = state;
        };
        const onKeyDown = event => {
          if (event.key !== 'Enter' || !event.isTrusted) return;
          guard.sawKeyDown = true;
          const state = safeCheck();
          if (!state.contextMatches || !state.focused || !state.attachmentsReady) cancel(event, state);
        };
        const onKeyUp = event => {
          if (event.key === 'Enter' && event.isTrusted && guard.blocked) { cancel(event, guard.blocked); detach(); }
        };
        const onClick = event => {
          if (!guard.sawKeyDown || !(event.target instanceof Node) ||
              !(button.contains(event.target) || event.target instanceof Element &&
                selectors.some((selector) => event.target.closest(selector) === button))) return;
          const state = safeCheck();
          if (guard.blocked || !state.contextMatches || !state.focused || !state.attachmentsReady) cancel(event, guard.blocked ?? state);
          detach();
        };
        guard.cleanup = () => { detach(); if (window.__oracleAttachmentDispatchGuard === guard) delete window.__oracleAttachmentDispatchGuard; };
        window.__oracleAttachmentDispatchGuard = guard;
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('click', onClick, true);
        return snapshot;
      })()`,
      returnByValue: true,
    });
    const snapshot = boundary?.result?.value as
      | { focused?: boolean; attachmentsReady?: boolean }
      | undefined;
    assertComposerNavigationSnapshot(attachmentNavigationUrl, snapshot);
    if (snapshot?.focused !== true || snapshot.attachmentsReady !== true) return false;
    await beforeSend?.();
    await Input.dispatchKeyEvent({
      type: "keyDown",
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await Input.dispatchKeyEvent({ type: "keyUp", ...ENTER_KEY_EVENT });
  } finally {
    const result = await withoutBrowserCancellation(() =>
      Runtime.evaluate({
        expression: `(() => {
        const guard = window.__oracleAttachmentDispatchGuard;
        if (guard?.id !== ${JSON.stringify(guardId)}) return null;
        const summary = { sawKeyDown: guard.sawKeyDown, blocked: guard.blocked };
        guard.cleanup(); return summary;
      })()`,
        returnByValue: true,
      }).catch(() => undefined),
    );
    delivery = result?.result?.value as typeof delivery;
  }
  if (delivery?.blocked) {
    assertComposerNavigationSnapshot(attachmentNavigationUrl, delivery.blocked);
    throw new BrowserAutomationError(
      "Attachment focus or upload readiness changed at dispatch; the send was stopped.",
      {
        stage: "submit-prompt",
        code: "attachment-send-not-ready",
      },
    );
  }
  if (delivery?.sawKeyDown !== true) {
    throw new BrowserAutomationError(
      "Attachment input delivery could not be verified; do not retry automatically.",
      {
        stage: "submit-prompt",
        code: "attachment-send-ambiguous",
      },
    );
  }
  logger?.("Activated exact attachment send button via keyboard");
  return true;
}

async function dismissOpenComposerPlusMenu(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger?: BrowserLogger,
): Promise<boolean> {
  const probe = await Runtime.evaluate({
    expression: `(() => {
      const selectors = ${JSON.stringify(COMPOSER_PLUS_SELECTORS)};
      const findPlus = ${findComposerPlusButton.toString()};
      const button = findPlus(document, ${JSON.stringify(INPUT_SELECTORS)}, selectors);
      if (!(button instanceof HTMLElement)) return { status: 'absent' };
      if (button.getAttribute('aria-expanded') !== 'true' && button.getAttribute('data-state') !== 'open') return { status: 'closed' };
      button.focus({ preventScroll: true });
      return { status: 'open', focused: document.activeElement === button };
    })()`,
    returnByValue: true,
  });
  const status = (probe?.result?.value as { status?: string } | undefined)?.status;
  if (status !== "open") {
    return false;
  }
  if (!Input || typeof Input.dispatchKeyEvent !== "function") {
    throw new BrowserAutomationError(
      "ChatGPT's attachment menu is still open and Oracle cannot dismiss it safely before sending.",
      {
        stage: "submit-prompt",
        code: "attachment-menu-dismiss-unavailable",
      },
    );
  }
  await Input.dispatchKeyEvent({ type: "keyDown", ...ESCAPE_KEY_EVENT });
  await Input.dispatchKeyEvent({ type: "keyUp", ...ESCAPE_KEY_EVENT });

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await Runtime.evaluate({
      expression: `(() => {
        const selectors = ${JSON.stringify(COMPOSER_PLUS_SELECTORS)};
        return !selectors.some(selector => {
          const node = document.querySelector(selector);
          return node?.getAttribute?.('aria-expanded') === 'true' || node?.getAttribute?.('data-state') === 'open';
        });
      })()`,
      returnByValue: true,
    });
    if (state?.result?.value === true) {
      logger?.("Closed attachment menu before send");
      return true;
    }
    await delay(50);
  }
  throw new BrowserAutomationError(
    "ChatGPT's attachment menu did not close before send; prompt was left staged.",
    {
      stage: "submit-prompt",
      code: "attachment-menu-stuck-open",
    },
  );
}

async function activatePageForTrustedInput(
  Page: ChromeClient["Page"] | undefined,
  logger?: BrowserLogger,
): Promise<void> {
  if (!Page || typeof Page.bringToFront !== "function") {
    return;
  }
  await Page.bringToFront().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.(`[browser] Could not bring ChatGPT target to front before trusted click: ${message}`);
  });
  await delay(150);
}

async function clickTrustedPoint(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  x: number,
  y: number,
): Promise<void> {
  if (Input && typeof Input.dispatchMouseEvent === "function") {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return;
  }
  await Runtime.evaluate({
    expression: `(() => {
      const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`,
    returnByValue: true,
  });
}

function sendButtonTimeoutMs(
  attachmentNames?: AttachmentReadyInput[],
  attachmentTimeoutMs?: number | null,
): number {
  if (!Array.isArray(attachmentNames) || attachmentNames.length === 0) {
    return 20_000;
  }
  return typeof attachmentTimeoutMs === "number" && Number.isFinite(attachmentTimeoutMs)
    ? Math.max(1_000, attachmentTimeoutMs)
    : 45_000;
}

async function verifyPromptCommitted(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
  options: {
    /** The user turn identities rendered before the send (readUserMessageIds). */
    baselineUserIds?: readonly string[];
    /** The latest user turn's text before the send: null for none, undefined when unread. */
    baselineLatestUserText?: string | null;
    onUnproven?: (turn: PageUserTurn | null) => void;
    onCommitted?: (turn: PageUserTurn) => void;
  } = {},
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const baselineUserIdsLiteral = JSON.stringify(options.baselineUserIds ?? null);
  const baselineLatestUserTextLiteral = JSON.stringify(
    options.baselineLatestUserText === undefined
      ? { unread: true }
      : { text: options.baselineLatestUserText },
  );
  // The page renders user turn ids: a turn had one before the send, or the latest one has one
  // now. An empty pre-send list alone (a fresh conversation) says nothing either way.
  const idsAvailable = (probe: CommitProbeState | undefined): boolean =>
    Array.isArray(options.baselineUserIds) &&
    (options.baselineUserIds.length > 0 || Boolean(probe?.latestUserId));
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  let baseline: number | null =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : null;
  if (baseline === null) {
    try {
      const { result } = await Runtime.evaluate({
        expression: buildConversationTurnCountExpression(),
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (Number.isFinite(raw)) {
        baseline = Math.max(0, Math.floor(raw));
      }
    } catch {
      // ignore; baseline stays unknown
    }
  }
  const baselineLiteral = baseline ?? -1;
  // Learned: ChatGPT can echo/format text; normalize markdown and use prefix matches to detect the sent prompt.
  const script = `(() => {
		    const editor = (${findComposerEditor.toString()})(document, [${primarySelectorLiteral}]);
		    const fallback = document.querySelector(${fallbackSelectorLiteral});
		    const inputSelectors = ${inputSelectorsLiteral};
	    // Strip markdown *markers* but keep content (ChatGPT renders fence markers differently).
	    const normalize = ${normalizePromptText.toString()};
	    const normalizedPrompt = normalize(${encodedPrompt});
	    const normalizedPromptPrefix = normalizedPrompt.slice(0, 120);
	    const articles = ${buildConversationTurnListExpression()};
	    const normalizedTurns = articles.map((node) => normalize(node?.innerText));
	    const readValue = (node) => {
	      if (!node) return '';
	      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
	      return node.innerText ?? '';
	    };
	    const isVisible = (node) => {
	      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
	      const rect = node.getBoundingClientRect();
	      return rect.width > 0 && rect.height > 0;
	    };
	    const inputs = inputSelectors
	      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
	      .filter((node) => Boolean(node));
	    const visibleInputs = inputs.filter((node) => isVisible(node));
	    const activeInputs = visibleInputs.length > 0 ? visibleInputs : inputs;
	    const userMatched =
	      normalizedPrompt.length > 0 && normalizedTurns.some((text) => text.includes(normalizedPrompt));
	    const prefixMatched =
	      normalizedPromptPrefix.length > 30 &&
	      normalizedTurns.some((text) => text.includes(normalizedPromptPrefix));
		    const lastTurn = normalizedTurns[normalizedTurns.length - 1] ?? '';
		    const lastMatched =
		      normalizedPrompt.length > 0 &&
		      (lastTurn.includes(normalizedPrompt) ||
		        (normalizedPromptPrefix.length > 30 && lastTurn.includes(normalizedPromptPrefix)));
		    const baseline = ${baselineLiteral};
		    const hasNewTurn = baseline < 0 ? false : normalizedTurns.length > baseline;
		    const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
		    const assistantVisible = Boolean(
		      document.querySelector(${assistantSelectorLiteral}) ||
		      document.querySelector('[data-testid*="assistant"]'),
		    );
	    // Learned: composer clearing + stop button or assistant presence is a reliable fallback signal.
      const editorValue = editor?.innerText ?? '';
      const fallbackValue = fallback?.value ?? '';
      const activeEmpty =
        activeInputs.length === 0 ? null : activeInputs.every((node) => !String(readValue(node)).trim());
      const composerCleared = activeEmpty ?? !(String(editorValue).trim() || String(fallbackValue).trim());
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
      // A long conversation keeps only a window of turns rendered: a new turn can unmount an old
      // one, so the count stays the same. The latest user turn's identity tells a new turn apart.
      const baselineUserIds = ${baselineUserIdsLiteral};
      const latestUser = ${buildLatestUserTurnExpression()};
      const latestUserText = normalize(latestUser?.text ?? '');
      const latestUserMatched =
        normalizedPrompt.length > 0 &&
        (latestUserText.includes(normalizedPrompt) ||
          (normalizedPromptPrefix.length > 30 && latestUserText.includes(normalizedPromptPrefix)));
      const latestUserKnown =
        Boolean(latestUser?.messageId) &&
        Array.isArray(baselineUserIds) &&
        baselineUserIds.includes(latestUser.messageId);
      const latestUserIsNew =
        Boolean(latestUser?.messageId) && Array.isArray(baselineUserIds) && !latestUserKnown;
      // Without ids: the latest user turn shows the same text as the latest one before the send
      // (or that text is unknown), so it may be that older turn.
      const baselineLatestUser = ${baselineLatestUserTextLiteral};
      const latestUserSameAsBefore =
        baselineLatestUser.unread === true ||
        (typeof baselineLatestUser.text === 'string' &&
          Boolean(latestUser) &&
          normalize(baselineLatestUser.text) === latestUserText);
		    return {
        baseline,
        latestUserMatched,
        latestUserIsNew,
        latestUserKnown,
        latestUserIndex: typeof latestUser?.index === 'number' ? latestUser.index : -1,
        latestUserId: latestUser?.messageId ?? null,
        latestUserRawText: latestUser?.text ?? null,
        latestUserSameAsBefore,
	      userMatched,
	      prefixMatched,
	      lastMatched,
	      hasNewTurn,
	      stopVisible,
      assistantVisible,
      composerCleared,
      inConversation,
      href,
      fallbackValue,
      editorValue,
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  const latestUserTurn = (probe: CommitProbeState): PageUserTurn => ({
    index: probe.latestUserIndex!,
    text: probe.latestUserRawText ?? null,
    messageId: probe.latestUserId ?? null,
  });
  // Without ids: the composer was cleared and the latest user turn shows the prompt with a text
  // the latest one before the send did not have, so it is the sent turn wherever the window of
  // rendered turns puts it.
  const textStandsForSent = (probe: CommitProbeState | undefined): boolean =>
    probe?.composerCleared === true &&
    probe.latestUserMatched === true &&
    probe.latestUserSameAsBefore === false &&
    typeof probe.latestUserIndex === "number" &&
    probe.latestUserIndex >= 0;
  let lastProbe: CommitProbeState | undefined;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as CommitProbeState | undefined;
    if (info && typeof info === "object") {
      lastProbe = info;
    }
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    // Proven by identity: the latest user turn shows the prompt and was not rendered before the
    // send. The answer follows that turn, wherever the window of rendered turns puts it.
    if (
      info?.latestUserMatched &&
      info.latestUserIsNew &&
      typeof info.latestUserIndex === "number" &&
      info.latestUserIndex >= 0
    ) {
      options.onCommitted?.(latestUserTurn(info));
      return info.latestUserIndex + 1;
    }
    // With the pre-send identities every decision is made by id: text in older turns and a count
    // that a re-rendered window can grow prove nothing then.
    if (idsAvailable(info)) {
      await delay(100);
      continue;
    }
    if (textStandsForSent(info)) {
      options.onCommitted?.(latestUserTurn(info!));
      return info!.latestUserIndex! + 1;
    }
    const matchesPrompt = Boolean(info?.lastMatched || info?.userMatched || info?.prefixMatched);
    const baselineUnknown =
      typeof info?.baseline === "number" ? info.baseline < 0 : baselineLiteral < 0;
    if (matchesPrompt && (baselineUnknown || info?.hasNewTurn)) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const fallbackCommit =
      info?.composerCleared &&
      Boolean(info?.hasNewTurn) &&
      ((info?.stopVisible ?? false) || info?.assistantVisible || info?.inConversation);
    if (fallbackCommit) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    await delay(100);
  }
  const finalProbe = await Runtime.evaluate({ expression: script, returnByValue: true })
    .then((res) => res?.result?.value as CommitProbeState | undefined)
    .catch(() => undefined);
  const probe = finalProbe && typeof finalProbe === "object" ? finalProbe : lastProbe;
  // A new user turn: by id when the pre-send identities are known; without them, only a grown
  // count. A turn that existed before the send, or an assistant's text, is never one.
  const idsKnown = idsAvailable(probe);
  const newUserTurn = idsKnown
    ? probe?.latestUserIsNew === true
    : (probe?.hasNewTurn === true && probe?.latestUserMatched === true) || textStandsForSent(probe);
  // Signs that the prompt left the composer through the page: a new user turn by id, or, without
  // ids, a grown count or the latest user turn showing it with a text it did not have before.
  const sentShown = idsKnown
    ? newUserTurn
    : Boolean(
        probe?.hasNewTurn || (probe?.latestUserMatched && probe?.latestUserSameAsBefore === false),
      );
  // The send was dispatched. When the composer still holds the prompt and no turn above shows it,
  // the click was lost: today's error, so the wrapper may retry. Any other uncertainty never ends
  // the run, and nothing is ever typed or sent again here.
  if (probe?.composerCleared !== false || sentShown) {
    logger?.(
      `[browser] Prompt commit not proven (${probe ? JSON.stringify(summarizeCommitProbe(probe)) : "page unreadable"}); treating it as sent and waiting for the answer`,
    );
    const latestStands =
      newUserTurn && typeof probe?.latestUserIndex === "number" && probe.latestUserIndex >= 0;
    if (
      !idsKnown &&
      !latestStands &&
      probe?.latestUserMatched === true &&
      probe.latestUserSameAsBefore === true
    ) {
      logger?.(
        "[browser] The latest user turn shows the same text as the one before the send, and the page has no message ids to tell them apart; the answer wait keeps its scope.",
      );
    }
    options.onUnproven?.(latestStands ? latestUserTurn(probe!) : null);
    return latestStands ? probe!.latestUserIndex! + 1 : null;
  }
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${probe ? JSON.stringify(probe) : "unavailable"}`,
    );
    await logDomFailure(Runtime, logger, "prompt-commit");
  }
  // Input was already dispatched. Even a large staged prompt may commit late;
  // classifying this as truncation would let the runner submit an upload fallback.
  throw new BrowserAutomationError(
    "Prompt did not appear in conversation before timeout (send may have failed)",
    {
      stage: "submit-prompt",
      code: "prompt-commit-timeout",
      promptLength: prompt.trim().length,
      timeoutMs,
      commitProbe: probe ? summarizeCommitProbe(probe) : undefined,
    },
  );
}

interface CommitProbeState {
  baseline?: number;
  latestUserMatched?: boolean;
  latestUserIsNew?: boolean;
  latestUserKnown?: boolean;
  latestUserIndex?: number;
  latestUserId?: string | null;
  latestUserRawText?: string | null;
  latestUserSameAsBefore?: boolean;
  userMatched?: boolean;
  prefixMatched?: boolean;
  lastMatched?: boolean;
  hasNewTurn?: boolean;
  stopVisible?: boolean;
  assistantVisible?: boolean;
  composerCleared?: boolean;
  inConversation?: boolean;
  turnsCount?: number;
  href?: string;
  editorValue?: string;
  fallbackValue?: string;
  lastTurn?: string;
}

// Keep booleans/counts but replace free text with lengths so session metadata stays lean.
function summarizeCommitProbe(probe: CommitProbeState): Record<string, unknown> {
  return {
    baseline: probe.baseline,
    turnsCount: probe.turnsCount,
    userMatched: probe.userMatched,
    prefixMatched: probe.prefixMatched,
    lastMatched: probe.lastMatched,
    hasNewTurn: probe.hasNewTurn,
    latestUserMatched: probe.latestUserMatched,
    latestUserIsNew: probe.latestUserIsNew,
    latestUserKnown: probe.latestUserKnown,
    latestUserIndex: probe.latestUserIndex,
    stopVisible: probe.stopVisible,
    assistantVisible: probe.assistantVisible,
    composerCleared: probe.composerCleared,
    inConversation: probe.inConversation,
    editorLength: typeof probe.editorValue === "string" ? probe.editorValue.length : undefined,
    lastTurnLength: typeof probe.lastTurn === "string" ? probe.lastTurn.length : undefined,
  };
}

export const __test__ = {
  activateExactAttachmentSendButton,
  attemptSendButton,
  dismissOpenComposerPlusMenu,
  sendButtonTimeoutMs,
  verifyPromptCommitted,
};
