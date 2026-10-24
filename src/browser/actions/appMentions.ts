import type { BrowserAppMention, BrowserLogger, ChromeClient } from "../types.js";
import { INPUT_SELECTORS } from "../constants.js";
import { delay } from "../utils.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { captureComposerNavigationUrl } from "./attachmentContext.js";
import {
  COMPOSER_MENTION_SELECTOR,
  COMPOSER_TOKEN_SELECTOR,
  closeComposerPlusPanel,
  composerRowTitleEquals,
  guardedTrustedClick,
  readComposerPanelRows,
  readComposerPromptText,
  readMentionNames,
} from "./composerTools.js";

const APP_MENTION_STAGE = "app-mention";

/** Names the app/plugin mentions inside the visible editor go by (display name, name, label). */
export function buildEditorMentionNamesExpression(): string {
  return `(() => {
    const visible = node => Boolean(node) && typeof node.getBoundingClientRect === 'function' &&
      node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const editor = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visible);
    if (!editor) return null;
    const names = ${readMentionNames.toString()};
    const mentions = Array.from(editor.querySelectorAll(${JSON.stringify(COMPOSER_MENTION_SELECTOR)}));
    // Nested mention markup (a label span inside the chip) is read through its outermost chip.
    const outer = mentions.filter(node => !mentions.some(other => other !== node && other.contains(node)));
    return Array.from(new Set(outer.flatMap(names)));
  })()`;
}

export function mentionNamesInclude(names: readonly string[], app: string): boolean {
  const wanted = app.trim().toLowerCase();
  return names.some((name) => name.trim().toLowerCase() === wanted);
}

async function readEditorMentionNames(runtime: ChromeClient["Runtime"]): Promise<string[] | null> {
  const { result } = await runtime.evaluate({
    expression: buildEditorMentionNamesExpression(),
    returnByValue: true,
  });
  return Array.isArray(result?.value) ? (result.value as string[]) : null;
}

async function waitForMention(
  runtime: ChromeClient["Runtime"],
  app: string,
  polls = 15,
): Promise<boolean> {
  for (let poll = 0; poll < polls; poll += 1) {
    if (mentionNamesInclude((await readEditorMentionNames(runtime)) ?? [], app)) return true;
    await delay(150);
  }
  return false;
}

/** Puts the caret at the end of the editor; returns the prompt text without tokens. */
async function focusEditorEnd(
  runtime: ChromeClient["Runtime"],
): Promise<{ focused: boolean; text: string }> {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const visible = node => Boolean(node) && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
      const editor = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visible);
      if (!editor || editor instanceof HTMLTextAreaElement) return { focused: false, text: '' };
      editor.focus();
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const read = ${readComposerPromptText.toString()};
      return { focused: document.activeElement === editor || editor.contains(document.activeElement), text: read(editor, ${JSON.stringify(COMPOSER_TOKEN_SELECTOR)}).text };
    })()`,
    returnByValue: true,
  });
  const value = result?.value as { focused?: boolean; text?: string } | undefined;
  return {
    focused: value?.focused === true,
    text: typeof value?.text === "string" ? value.text : "",
  };
}

async function pressKey(
  input: ChromeClient["Input"],
  key: string,
  options: { code?: string; keyCode?: number; text?: string; modifiers?: number } = {},
): Promise<void> {
  const base = {
    key,
    code: options.code ?? "",
    windowsVirtualKeyCode: options.keyCode ?? 0,
    nativeVirtualKeyCode: options.keyCode ?? 0,
    ...(options.modifiers ? { modifiers: options.modifiers } : {}),
  };
  await input.dispatchKeyEvent({
    type: "keyDown",
    ...base,
    ...(options.text ? { text: options.text, unmodifiedText: options.text } : {}),
  });
  await input.dispatchKeyEvent({ type: "keyUp", ...base });
}

async function typeCharacters(input: ChromeClient["Input"], text: string): Promise<void> {
  for (const character of text) {
    const upper = character.toUpperCase();
    const letter = /^[a-z]$/i.test(character);
    const digit = /^[0-9]$/.test(character);
    await pressKey(input, character, {
      code: letter ? `Key${upper}` : digit ? `Digit${character}` : "",
      keyCode: letter || digit ? upper.charCodeAt(0) : 0,
      text: character,
    });
  }
}

/** Pastes chip HTML copied from ChatGPT at the end of the editor (ProseMirror parses it). */
async function pasteMentionChip(
  runtime: ChromeClient["Runtime"],
  app: BrowserAppMention,
): Promise<boolean> {
  if (!app.chipHtml) return false;
  await focusEditorEnd(runtime);
  await runtime.evaluate({
    expression: `(() => {
      const visible = node => Boolean(node) && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
      const editor = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visible);
      if (!editor) return false;
      const data = new DataTransfer();
      data.setData('text/html', ${JSON.stringify(app.chipHtml)});
      data.setData('text/plain', ${JSON.stringify(`${app.name} `)});
      return !editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`,
    returnByValue: true,
  });
  return waitForMention(runtime, app.name);
}

type PickerOutcome = { ok: true } | { ok: false; reason: string; available: string[] };

/** Types "@" + the app name with trusted keys and chooses the row titled exactly like the app. */
async function pickMentionFromAtPicker(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"],
  app: BrowserAppMention,
): Promise<PickerOutcome> {
  if (!input || typeof input.dispatchKeyEvent !== "function") {
    return { ok: false, reason: "trusted keyboard input is unavailable", available: [] };
  }
  const navigationUrl = await captureComposerNavigationUrl(runtime);
  const before = await focusEditorEnd(runtime);
  if (!before.focused)
    return { ok: false, reason: "the editor could not be focused", available: [] };
  let typed = "";
  if (before.text.length > 0 && !/\s$/.test(before.text)) {
    await input.insertText({ text: " " });
    typed += " ";
  }
  await pressKey(input, "@", { code: "Digit2", keyCode: 50, text: "@", modifiers: 8 });
  await typeCharacters(input, app.name);
  typed += `@${app.name}`;

  let available: string[] = [];
  let outcome: PickerOutcome | null = null;
  const token = `app-mention-${Date.now()}`;
  for (let poll = 0; poll < 30 && !outcome; poll += 1) {
    const rows = await readComposerPanelRows(runtime, token);
    available = rows.map((row) => row.title || row.text).filter(Boolean);
    const row = rows.find((candidate) => composerRowTitleEquals(candidate, [app.name]));
    if (!row) {
      await delay(150);
      continue;
    }
    const clicked = await guardedTrustedClick(runtime, input, {
      locate: `() => window.__oracleComposerRows?.token === ${JSON.stringify(token)} ? window.__oracleComposerRows.nodes[${row.index}] ?? null : null`,
      navigationUrl,
      stage: APP_MENTION_STAGE,
      target: `The ${app.name} row of the @ picker`,
      settleTimeoutMs: 1_500,
    });
    if (clicked.status === "clicked" && (await waitForMention(runtime, app.name))) {
      outcome = { ok: true };
    } else if (row.current) {
      // The highlighted row is what Enter inserts.
      await pressKey(input, "Enter", { code: "Enter", keyCode: 13, text: "\r" });
      outcome = (await waitForMention(runtime, app.name))
        ? { ok: true }
        : { ok: false, reason: "the @ picker row did not become a mention", available };
    } else {
      outcome = { ok: false, reason: "the @ picker row did not become a mention", available };
    }
  }
  if (outcome?.ok) return outcome;
  await removeTypedQuery(runtime, input, before.text, typed);
  return outcome ?? { ok: false, reason: `no @ picker row titled "${app.name}"`, available };
}

/** Closes the picker and deletes the typed "@query" so it is never sent as prompt text. */
async function removeTypedQuery(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"],
  originalText: string,
  typed: string,
): Promise<void> {
  await closeComposerPlusPanel(runtime, input).catch(() => false);
  for (let press = 0; press <= typed.length + 1; press += 1) {
    const current = await focusEditorEnd(runtime);
    if (current.text.replace(/\s+$/, "") === originalText.replace(/\s+$/, "")) return;
    await pressKey(input, "Backspace", { code: "Backspace", keyCode: 8 });
  }
  const current = await focusEditorEnd(runtime);
  if (current.text.replace(/\s+$/, "") !== originalText.replace(/\s+$/, "")) {
    throw new BrowserAutomationError(
      `The typed "${typed.trim()}" query could not be removed from the composer; nothing was sent.`,
      { stage: APP_MENTION_STAGE, code: "app-mention-query-stuck" },
    );
  }
}

/**
 * Inserts one mention per requested app before the prompt is staged. A pasted chip (when the
 * caller supplied one) is tried first, then the "@" picker; an app that cannot be verified
 * stops the run before anything is sent.
 */
export async function insertAppMentions(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"],
  apps: readonly BrowserAppMention[],
  logger: BrowserLogger,
): Promise<void> {
  for (const app of apps) {
    if (mentionNamesInclude((await readEditorMentionNames(runtime)) ?? [], app.name)) {
      logger(`[browser] App mention ${app.name}: already in the composer.`);
      continue;
    }
    const failures: string[] = [];
    let available: string[] = [];
    if (app.chipHtml) {
      if (await pasteMentionChip(runtime, app)) {
        logger(`[browser] App mention ${app.name}: attached (pasted chip).`);
        continue;
      }
      failures.push("the pasted chip did not become a mention");
    }
    const picked = await pickMentionFromAtPicker(runtime, input, app);
    if (picked.ok) {
      logger(`[browser] App mention ${app.name}: attached (@ picker).`);
      continue;
    }
    failures.push(picked.reason);
    available = picked.available;
    if (!app.chipHtml) failures.push("no --browser-app-chip fallback was given");
    throw new BrowserAutomationError(
      `Could not attach the ChatGPT app "${app.name}" to the prompt (${failures.join("; ")})${available.length ? `; @ picker offered: ${available.join(", ")}` : ""}. Nothing was sent.`,
      { stage: APP_MENTION_STAGE, code: "app-mention-unverified", app: app.name, available },
    );
  }
}

/** Fails before submit when staging dropped a mention that was inserted earlier. */
export async function assertAppMentionsPresent(
  runtime: ChromeClient["Runtime"],
  apps: readonly BrowserAppMention[],
): Promise<void> {
  if (apps.length === 0) return;
  const names = (await readEditorMentionNames(runtime)) ?? [];
  const missing = apps
    .filter((app) => !mentionNamesInclude(names, app.name))
    .map((app) => app.name);
  if (missing.length > 0) {
    throw new BrowserAutomationError(
      `The app mention for ${missing.join(", ")} left the composer while the prompt was staged; nothing was sent.`,
      { stage: "submit-prompt", code: "app-mention-lost", missing },
    );
  }
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/** Reads the app name from chip HTML copied from ChatGPT (plugin or app mention). */
export function parseAppMentionChipName(html: string): string | null {
  const match = /(?:plugin|app)-mention-display-name\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  const name = raw.replace(/&(#?\w+);/g, (entity, code: string) => HTML_ENTITIES[code] ?? entity);
  return name.trim() || null;
}
