import type { ChromeClient, BrowserLogger } from "../types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { INPUT_SELECTORS } from "../constants.js";
import { delay } from "../utils.js";
import { captureComposerNavigationUrl, assertComposerPlusStayedInPlace } from "./attachments.js";
import {
  COMPOSER_TOKEN_SELECTOR,
  type ComposerPanelRow,
  clickComposerPanelRow,
  closeComposerPlusPanel,
  isWebSearchPill,
  openComposerPlusPanel,
} from "./composerTools.js";

export function matchesWebSearchMenuLabel(value: string): boolean {
  return [
    "search",
    "searchfindontheweb",
    "websearch",
    "websearchfindreal-timenewsandinfo",
  ].includes(value.replace(/\s+/g, "").toLowerCase());
}

/** The "+" panel row for Web Search, by its title (or the legacy combined label). */
export function findWebSearchPanelRow(rows: readonly ComposerPanelRow[]): number {
  return rows.findIndex((row) =>
    [row.title, row.leaf, row.aria, row.text].some(
      (value) => value.length > 0 && matchesWebSearchMenuLabel(value),
    ),
  );
}

export function buildWebSearchVerificationExpression(prompt: string): string {
  return `(() => {
    const visible = node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const editor = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visible);
    if (!editor) return { selected: false, promptMatches: false };
    // Current pills carry the system-hint type and link but no data-id; older ones had data-id="search".
    const isSearchPill = ${isWebSearchPill.toString()};
    const chip = Array.from(editor.querySelectorAll(${JSON.stringify(COMPOSER_TOKEN_SELECTOR)})).find(isSearchPill);
    const copy = editor.cloneNode(true);
    copy.querySelectorAll(${JSON.stringify(COMPOSER_TOKEN_SELECTOR)}).forEach(node => node.remove());
    const readText = node => {
      if (node.nodeType === 3) return node.textContent ?? '';
      const text = Array.from(node.childNodes).map(readText).join('');
      return text + (['P', 'DIV', 'BR', 'LI', 'PRE'].includes(node.nodeName) ? '\\n' : '');
    };
    const normalize = text => String(text ?? '').replace(/[\\u200b\\ufeff]/g, '').replace(/\\s+/g, ' ').trim();
    return { selected: Boolean(chip && visible(chip)), promptMatches: normalize(readText(copy)) === normalize(${JSON.stringify(prompt)}) };
  })()`;
}

const WEB_SEARCH_STAGE = "web-search-activate";

/** Web Search is an inline editor hint, so activate it after staging text/attachments. */
export async function activateWebSearch(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"],
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  const navigationUrl = await captureComposerNavigationUrl(runtime);
  const verify = async () => {
    const { result, exceptionDetails } = await runtime.evaluate({
      expression: buildWebSearchVerificationExpression(prompt),
      returnByValue: true,
    });
    if (exceptionDetails) return false;
    return result?.value?.selected === true && result?.value?.promptMatches === true;
  };
  if (await verify()) return;
  const opened = await openComposerPlusPanel(runtime, input, {
    navigationUrl,
    stage: WEB_SEARCH_STAGE,
  });
  if (opened.status === "unavailable" || opened.status === "not-needed") {
    throw new BrowserAutomationError(
      `Web Search requires the ChatGPT composer tools menu (${opened.reason ?? "not available"}); the prompt was not submitted.`,
      { stage: WEB_SEARCH_STAGE, code: "web-search-menu-unavailable" },
    );
  }
  try {
    const choice = await clickComposerPanelRow(runtime, input, {
      pick: findWebSearchPanelRow,
      navigationUrl,
      stage: WEB_SEARCH_STAGE,
      target: "The Web search row",
    });
    if (choice.status !== "clicked") {
      const available = choice.rows.map((row) => row.title || row.text).filter(Boolean);
      throw new BrowserAutomationError(
        `Web Search option not found in the composer + panel${available.length ? ` (available: ${available.join(", ")})` : ""}; the prompt was not submitted.`,
        { stage: WEB_SEARCH_STAGE, code: "web-search-option-missing", available },
      );
    }
    const confirmationDeadline = Date.now() + 3_000;
    do {
      await assertComposerPlusStayedInPlace(runtime, navigationUrl);
      if (await verify()) {
        logger("Web Search selected; inline search hint and staged prompt verified.");
        return;
      }
      await delay(100);
    } while (Date.now() < confirmationDeadline);
  } finally {
    await closeComposerPlusPanel(runtime, input).catch(() => false);
  }
  throw new BrowserAutomationError(
    "Web Search selection could not be verified; the prompt was not submitted. This pilot supports the English ChatGPT Web search control.",
    { stage: WEB_SEARCH_STAGE },
  );
}
