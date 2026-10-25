import type { ChromeClient, BrowserLogger, BrowserModelPickerState } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import type { BrowserModelPickerEvidence } from "../../sessionStore.js";
import { BrowserRunCancelledError } from "../../oracle/errors.js";
import { MODEL_BUTTON_SELECTOR } from "../constants.js";
import { delay } from "../utils.js";
import { guardedTrustedClick } from "./composerTools.js";
import { buildClickDispatcher } from "./domEvents.js";

export type { BrowserModelPickerState } from "../types.js";

export interface ModelPickerRestoreResult {
  restored: boolean;
  state: BrowserModelPickerState | null;
  detail?: string;
}

const PICKER_BUTTON_SELECTORS = MODEL_BUTTON_SELECTOR.split(", ");
const STAGE = "browser-select-only";

/** Page function: the visible model picker button, preferring the most specific selector. */
export function findModelPickerButton(doc: Document, selectors: readonly string[]): Element | null {
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  for (const selector of selectors) {
    const match = Array.from(doc.querySelectorAll(selector)).find(visible);
    if (match) return match;
  }
  return null;
}

/** Page function: the open menu that belongs to the picker button. */
export function findModelPickerMenu(doc: Document, button: Element | null): Element | null {
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const menus = Array.from(doc.querySelectorAll('[role="menu"]')).filter(visible);
  const controls = button?.getAttribute("aria-controls");
  const owned = controls ? menus.find((menu) => menu.getAttribute("id") === controls) : undefined;
  if (owned) return owned;
  return (
    menus.find((menu) => menu.querySelector('[role="slider"], [role="menuitemradio"]')) ?? null
  );
}

/**
 * Page function: reads the picker state from the open menu (or only the button when closed).
 * The tier label is the first candidate that names a known effort level (`levelOf`): the lines
 * of the tier header, the slider's aria-valuetext, then the live announcements; the raw header
 * line is the fallback when none does.
 */
export function readModelPickerMenuState(
  doc: Document,
  button: Element | null,
  menu: Element | null,
  levelOf: (label: string) => unknown = () => null,
): BrowserModelPickerState {
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const firstLine = (node: Element | null | undefined) =>
    String((node as HTMLElement | null | undefined)?.innerText ?? node?.textContent ?? "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? null;
  const flatText = (node: Element | null | undefined) =>
    String((node as HTMLElement | null | undefined)?.innerText ?? node?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim() || null;
  const numberAttr = (node: Element | null, name: string) => {
    const raw = node?.getAttribute(name);
    if (raw === null || raw === undefined || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const radios = menu
    ? Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(visible)
    : [];
  const checked = radios.find(
    (radio) =>
      radio.getAttribute("aria-checked") === "true" ||
      radio.getAttribute("data-state") === "checked",
  );
  const slider = menu
    ? (Array.from(menu.querySelectorAll('[role="slider"]')).find(visible) ?? null)
    : null;
  const items = menu
    ? Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(
        (item) => visible(item) && !item.querySelector('[role="slider"]') && firstLine(item),
      )
    : [];
  // The tier header, found as the model list opener is: its English label, then structure (the
  // item that opens a sub-list, the item right before the slider), then the first item.
  let beforeSlider: Element | undefined;
  for (const item of items) {
    if (slider && item.compareDocumentPosition(slider) & 4) beforeSlider = item;
  }
  const tierItem =
    items.find((item) => /select model/i.test(item.getAttribute("aria-label") ?? "")) ??
    items.find((item) => item.hasAttribute("aria-haspopup")) ??
    beforeSlider ??
    items[0];
  const announcements = Array.from(doc.querySelectorAll('[aria-live], [role="status"]'))
    .map((node) => flatText(node))
    .filter((text): text is string => Boolean(text) && (text as string).length <= 120);
  const headerLines = String(
    (tierItem as HTMLElement | undefined)?.innerText ?? tierItem?.textContent ?? "",
  )
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const valueText = slider?.getAttribute("aria-valuetext")?.trim() || null;
  // Newest announcement first; "Medium, 2 of 5." names the tier before its comma.
  const spoken = announcements.reduceRight<Array<{ text: string; label: string }>>(
    (list, text) => [...list, { text, label: text.split(/[,，、]/)[0]!.trim() }],
    [],
  );
  type Source = "header" | "valuetext" | "announcement";
  const candidates = [
    ...headerLines.map((label) => ({
      label,
      text: null as string | null,
      source: "header" as Source,
    })),
    ...(valueText
      ? [{ label: valueText, text: null as string | null, source: "valuetext" as Source }]
      : []),
    ...spoken.map((entry) => ({ ...entry, source: "announcement" as Source })),
  ];
  const known = candidates.find((candidate) => candidate.label && levelOf(candidate.label));
  const announcement = known?.text ?? announcements.at(-1) ?? null;
  const fallback = headerLines[0]
    ? { label: headerLines[0], source: "header" as Source }
    : valueText
      ? { label: valueText, source: "valuetext" as Source }
      : spoken[0]?.label
        ? { label: spoken[0].label, source: "announcement" as Source }
        : null;
  const tierLabel = known?.label ?? fallback?.label ?? null;
  // Every current source that names a known tier: the header's first such line and the slider's
  // text. They can disagree for a moment after a change; callers that must not miss a higher tier
  // look at all of them.
  const headerTier = headerLines.find((label) => levelOf(label));
  const currentTiers = [
    ...(headerTier ? [{ label: headerTier, source: "header" as const }] : []),
    ...(valueText && levelOf(valueText)
      ? [{ label: valueText, source: "valuetext" as const }]
      : []),
  ];
  return {
    pickerLabel: flatText(button),
    modelLabel: firstLine(checked),
    modelOptions: radios
      .map((radio) => firstLine(radio))
      .filter((label): label is string => Boolean(label)),
    tierLabel,
    sliderValue: numberAttr(slider, "aria-valuenow"),
    sliderMin: numberAttr(slider, "aria-valuemin"),
    sliderMax: numberAttr(slider, "aria-valuemax"),
    announcement,
    tierSource: known?.source ?? fallback?.source ?? null,
    currentTiers,
    sliderPresent: Boolean(menu?.querySelector('[role="slider"]')),
  };
}

const PAGE_FUNCTIONS = `
  const __findPickerButton = () => (${findModelPickerButton.toString()})(document, ${JSON.stringify(PICKER_BUTTON_SELECTORS)});
  const __findPickerMenu = () => (${findModelPickerMenu.toString()})(document, __findPickerButton());
  const __readPickerState = () => (${readModelPickerMenuState.toString()})(document, __findPickerButton(), __findPickerMenu(), ${thinkingLevelFromTierLabel.toString()});
`;

const BUTTON_LOCATE = `() => { ${PAGE_FUNCTIONS} return __findPickerButton(); }`;

async function evaluate<T>(runtime: ChromeClient["Runtime"], body: string): Promise<T | undefined> {
  const { result } = await runtime.evaluate({
    expression: `(() => { ${PAGE_FUNCTIONS} ${body} })()`,
    returnByValue: true,
  });
  return result?.value as T | undefined;
}

/**
 * The composer model button's text, read without touching it (no click, the picker stays as it
 * is). On chatgpt.com (2026-10-25) it reads "Thinking effort\nExtra High". Null without a button.
 */
export async function readModelButtonText(
  runtime: ChromeClient["Runtime"],
): Promise<string | null> {
  return (
    (await evaluate<string | null>(
      runtime,
      "const button = __findPickerButton(); return button ? String(button.innerText ?? button.textContent ?? '') : null;",
    )) ?? null
  );
}

/** The highest known tier any line of the button text names; null when no line names one. */
export function highestTierInButtonText(text: string | null | undefined): ThinkingTimeLevel | null {
  let highest: ThinkingTimeLevel | null = null;
  for (const line of String(text ?? "").split(/\n+/)) {
    const level = thinkingLevelFromTierLabel(line);
    if (level && (highest === null || (LEVEL_RANK[level] ?? -1) > (LEVEL_RANK[highest] ?? -1))) {
      highest = level;
    }
  }
  return highest;
}

async function isPickerMenuOpen(runtime: ChromeClient["Runtime"]): Promise<boolean> {
  return (await evaluate<boolean>(runtime, "return Boolean(__findPickerMenu());")) === true;
}

async function readOpenState(
  runtime: ChromeClient["Runtime"],
): Promise<BrowserModelPickerState | null> {
  return (await evaluate<BrowserModelPickerState>(runtime, "return __readPickerState();")) ?? null;
}

async function pressKey(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  key: string,
  keyCode: number,
): Promise<void> {
  if (input && typeof input.dispatchKeyEvent === "function") {
    const event = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await input.dispatchKeyEvent({ type: "keyDown", ...event });
    await input.dispatchKeyEvent({ type: "keyUp", ...event });
    return;
  }
  await runtime.evaluate({
    expression: `(() => { const target = document.activeElement || document.body; target.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return true; })()`,
    returnByValue: true,
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

/** Opens the model picker with a guarded trusted click. Returns whether its menu is open. */
export async function openModelPicker(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
): Promise<boolean> {
  if (await isPickerMenuOpen(runtime)) return true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clicked = await guardedTrustedClick(runtime, input, {
      locate: BUTTON_LOCATE,
      stage: STAGE,
      target: "The ChatGPT model picker",
    });
    if (clicked.status === "unreached") continue;
    if (clicked.status !== "clicked") return false;
    if (await waitFor(() => isPickerMenuOpen(runtime), 3_000)) return true;
  }
  return false;
}

/** Closes the model picker with Escape. Returns whether it is closed afterwards. */
export async function closeModelPicker(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await isPickerMenuOpen(runtime))) return true;
    await pressKey(runtime, input, "Escape", 27);
    if (await waitFor(async () => !(await isPickerMenuOpen(runtime)), 1_000)) return true;
  }
  return !(await isPickerMenuOpen(runtime));
}

/**
 * Closes the picker so no menu is left over the composer: Escape first, then its own button
 * (which toggles the menu) when Escape did not close it. Logs when it had to recover or could
 * not close. Never throws.
 */
export async function closeModelPickerOrRecover(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  logger?: BrowserLogger,
): Promise<boolean> {
  try {
    if (await closeModelPicker(runtime, input)) return true;
    const clicked = await guardedTrustedClick(runtime, input, {
      locate: BUTTON_LOCATE,
      stage: STAGE,
      target: "The ChatGPT model picker",
      settleTimeoutMs: 1_000,
    });
    const closed =
      clicked.status === "clicked" &&
      (await waitFor(async () => !(await isPickerMenuOpen(runtime)), 1_500));
    logger?.(
      `[browser] Model picker: Escape did not close the menu; ${closed ? "closed it with its button" : "it is still open"}.`,
    );
    return closed;
  } catch (error) {
    if (error instanceof BrowserRunCancelledError) throw error;
    logger?.(
      `[browser] Model picker: closing the menu failed (${error instanceof Error ? error.message : String(error)}).`,
    );
    return false;
  }
}

// The tier header and the effort slider render a beat after the menu itself.
const SLIDER_MOUNT_WAIT_MS = 3_000;

/**
 * The effort level the picker shows now: from the tier header or the slider's aria-valuetext,
 * never from a live announcement alone (it can be left over from an earlier change).
 */
export function currentTierLevel(
  state: BrowserModelPickerState | null | undefined,
): ThinkingTimeLevel | null {
  if (!state || state.tierSource === "announcement") return null;
  return thinkingLevelFromTierLabel(state.tierLabel);
}

/**
 * The highest known tier any current source shows (the tier header, the slider's text). A stale
 * announcement never counts; null when no current source names a known tier.
 */
export function highestCurrentTierLevel(
  state: BrowserModelPickerState | null | undefined,
): ThinkingTimeLevel | null {
  if (!state) return null;
  const levels = [
    ...(state.currentTiers ?? []).map((reading) => thinkingLevelFromTierLabel(reading.label)),
    currentTierLevel(state),
  ].filter((level): level is ThinkingTimeLevel => level !== null);
  let highest: ThinkingTimeLevel | null = null;
  for (const level of levels) {
    if (highest === null || (LEVEL_RANK[level] ?? -1) > (LEVEL_RANK[highest] ?? -1)) {
      highest = level;
    }
  }
  return highest;
}

/** Whether a picker reading has both the model and the effort it shows. */
export function isCompletePickerState(
  state: BrowserModelPickerState | null | undefined,
): state is BrowserModelPickerState {
  return Boolean(
    state?.modelLabel && (state.sliderValue !== null || currentTierLevel(state) !== null),
  );
}

async function readOpenStateWhenMounted(
  runtime: ChromeClient["Runtime"],
): Promise<BrowserModelPickerState | null> {
  let state: BrowserModelPickerState | null = null;
  await waitFor(async () => {
    state = await readOpenState(runtime);
    if (!state?.modelLabel) return false;
    // A picker with a slider is read once the slider has mounted; one without it, by its tier.
    return (
      state.sliderValue !== null ||
      (state.sliderPresent === false && currentTierLevel(state) !== null)
    );
  }, SLIDER_MOUNT_WAIT_MS);
  return state;
}

// Order of effort levels: which way the slider moves toward a level, and whether a tier is above
// a maximum. Not slider values.
const LEVEL_RANK: Partial<Record<ThinkingTimeLevel, number>> = {
  light: 0,
  standard: 1,
  extended: 2,
  "extra-high": 3,
  heavy: 3.5,
  pro: 4,
};

/** Where `level` sits among effort levels; undefined for a level that cannot be placed. */
export function thinkingLevelRank(level: ThinkingTimeLevel | null | undefined): number | undefined {
  return level ? LEVEL_RANK[level] : undefined;
}

/** A picker reading as session evidence. A tier named only by a live announcement is left out. */
export function modelPickerEvidence(
  state: BrowserModelPickerState | null | undefined,
): BrowserModelPickerEvidence {
  const tierLabel = state && state.tierSource !== "announcement" ? (state.tierLabel ?? null) : null;
  const sliderValue = state?.sliderValue ?? null;
  return {
    modelLabel: state?.modelLabel ?? null,
    tierLabel,
    sliderValue,
    sliderMin: state?.sliderMin ?? null,
    sliderMax: state?.sliderMax ?? null,
    ...(state?.currentTiers?.length
      ? { tierReadings: state.currentTiers.map((reading) => ({ ...reading })) }
      : {}),
    readable: Boolean(state?.modelLabel || tierLabel || sliderValue !== null),
    source: "chatgpt-model-picker",
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Opens the picker, reads what it shows (waiting for the slider to mount) and closes it again.
 * Null when it cannot be opened; a picker without a mounted slider is returned as read.
 */
export async function readModelPickerState(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  logger?: BrowserLogger,
): Promise<BrowserModelPickerState | null> {
  try {
    let opened = await openModelPicker(runtime, input);
    if (!opened) {
      await delay(500);
      opened = await openModelPicker(runtime, input);
    }
    if (!opened) return null;
    return await readOpenStateWhenMounted(runtime);
  } finally {
    // Also after a failed read, and after an open that reported failure but opened late.
    await closeModelPickerOrRecover(runtime, input, logger);
  }
}

async function chooseModelRadio(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  label: string,
): Promise<boolean> {
  const locate = `() => {
    ${PAGE_FUNCTIONS}
    const menu = __findPickerMenu();
    if (!menu) return null;
    const wanted = ${JSON.stringify(label.toLowerCase())};
    const line = node => String(node.innerText ?? node.textContent ?? '').split(/\\n+/).map(part => part.replace(/\\s+/g, ' ').trim()).find(Boolean) ?? '';
    return Array.from(menu.querySelectorAll('[role="menuitemradio"]')).find(radio => line(radio).toLowerCase() === wanted) ?? null;
  }`;
  const clickRadio = async () =>
    (
      await guardedTrustedClick(runtime, input, {
        locate,
        stage: STAGE,
        target: `The "${label}" model option`,
        settleTimeoutMs: 1_000,
      })
    ).status === "clicked";
  if (await clickRadio()) return true;
  // Current layout: the model radios sit under the effort panel until its header (the tier
  // name, labelled "Select model") brings the model list to the front.
  const header = await guardedTrustedClick(runtime, input, {
    locate: `() => {
      ${PAGE_FUNCTIONS}
      const menu = __findPickerMenu();
      if (!menu) return null;
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(node => node.getBoundingClientRect().width > 0 && !node.querySelector('[role="slider"]'));
      // The English label first, then structure, so a localized picker still restores: the item
      // that opens a sub-list, then the item right before the slider.
      const slider = menu.querySelector('[role="slider"]');
      const beforeSlider = slider ? items.filter(node => node.compareDocumentPosition(slider) & 4).at(-1) : undefined;
      return items.find(node => /select model/i.test(node.getAttribute('aria-label') ?? '')) ??
        items.find(node => /model/i.test(node.getAttribute('aria-label') ?? '')) ??
        items.find(node => node.hasAttribute('aria-haspopup')) ??
        beforeSlider ??
        items.find(node => (node.innerText ?? '').trim()) ?? null;
    }`,
    stage: STAGE,
    target: "The model list header",
    settleTimeoutMs: 1_000,
  });
  if (header.status === "clicked") {
    await delay(400);
    if (await clickRadio()) return true;
  }
  // Last resort, as the model selection itself does: a synthetic click on the radio.
  return (
    (await evaluate<boolean>(
      runtime,
      `${buildClickDispatcher()} const radio = (${locate})(); if (!radio) return false; dispatchClickSequence(radio); return true;`,
    )) === true
  );
}

async function focusSlider(runtime: ChromeClient["Runtime"]): Promise<boolean> {
  return (
    (await evaluate<boolean>(
      runtime,
      `const menu = __findPickerMenu(); const slider = menu ? Array.from(menu.querySelectorAll('[role="slider"]')).find(node => node.getBoundingClientRect().width > 0) : null; if (!slider) return false; slider.focus({ preventScroll: true }); return document.activeElement === slider;`,
    )) === true
  );
}

/**
 * Moves the open picker's effort slider to `target` with trusted arrow keys, one step at a time.
 * It stops when the value reaches the target or when no key moves it any more.
 */
async function moveSlider(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  target: number,
): Promise<number | null> {
  // Horizontal keys are what the live slider was measured with; vertical keys are the
  // direction-independent fallback that Radix-style sliders also accept.
  const keySets = [
    { up: ["ArrowRight", 39], down: ["ArrowLeft", 37] },
    { up: ["ArrowUp", 38], down: ["ArrowDown", 40] },
  ] as const;
  let current = (await readOpenStateWhenMounted(runtime))?.sliderValue ?? null;
  // Presses one key and returns the value it settled on (unchanged when the key did nothing).
  const press = async ([key, code]: readonly [string, number]) => {
    const before = current;
    if (!(await focusSlider(runtime))) return before;
    await pressKey(runtime, input, key, code);
    await waitFor(async () => {
      current = (await readOpenState(runtime))?.sliderValue ?? null;
      return current !== before;
    }, 1_500);
    return current;
  };
  let keySet = 0;
  // Right-to-left layouts reverse the horizontal keys.
  let swapped = false;
  // A repeated move means the slider is cycling (for example a key that skips the target).
  const moves = new Set<string>();
  while (current !== null && current !== target) {
    const before = current;
    const towardUp = before < target;
    const keys = keySets[keySet]!;
    const [primary, secondary] = towardUp !== swapped ? [keys.up, keys.down] : [keys.down, keys.up];
    let after = await press(primary);
    if (after === before) {
      // At the end of the range the reversed key cannot move, so try its opposite before
      // deciding that this key set does nothing.
      after = await press(secondary);
      if (after === before) {
        if (keySet + 1 >= keySets.length) return current;
        keySet += 1;
        swapped = false;
        continue;
      }
      if (after !== null && Math.abs(target - after) < Math.abs(target - before))
        swapped = !swapped;
    } else if (after !== null && Math.abs(target - after) > Math.abs(target - before)) {
      if (swapped) return current;
      swapped = true;
    }
    const move = `${before}>${after}`;
    if (moves.has(move)) return current;
    moves.add(move);
  }
  return current;
}

/**
 * Moves the open picker's slider one step at a time until its tier header (or aria-valuetext)
 * names `level`. Returns the slider value that shows it, for a target known only by its label.
 */
async function moveSliderToLevel(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  level: ThinkingTimeLevel,
): Promise<{ value: number | null; matched: boolean; detail?: string }> {
  const wanted = LEVEL_RANK[level];
  const seen = new Set<number>();
  for (;;) {
    const state = await readOpenStateWhenMounted(runtime);
    const value = state?.sliderValue ?? null;
    if (value === null)
      return { value, matched: false, detail: "the effort slider is not mounted" };
    const shown = currentTierLevel(state);
    if (shown === level) return { value, matched: true };
    const rank = shown ? LEVEL_RANK[shown] : undefined;
    if (rank === undefined || wanted === undefined) {
      return {
        value,
        matched: false,
        detail: `tier "${state?.tierLabel ?? "unknown"}" cannot be placed`,
      };
    }
    if (seen.has(value)) return { value, matched: false, detail: `no slider step shows ${level}` };
    seen.add(value);
    const next = value + (rank < wanted ? 1 : -1);
    if (
      (state?.sliderMin !== null && state?.sliderMin !== undefined && next < state.sliderMin) ||
      (state?.sliderMax !== null && state?.sliderMax !== undefined && next > state.sliderMax)
    ) {
      return { value, matched: false, detail: `no slider step shows ${level}` };
    }
    const reached = await moveSlider(runtime, input, next);
    if (reached !== next) {
      return {
        value: reached,
        matched: false,
        detail: `effort slider stopped at ${reached ?? "unknown"}`,
      };
    }
  }
}

/**
 * Steps the effort slider down with trusted keys until the picker's tier is at or below
 * `maxLevel`. Which slider direction lowers the tier is learned from the first step. Opens and
 * closes the picker itself; the caller reads the result back.
 */
export async function lowerModelPickerTier(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  maxLevel: ThinkingTimeLevel,
  logger?: BrowserLogger,
): Promise<{ lowered: boolean; detail?: string }> {
  const cap = LEVEL_RANK[maxLevel];
  if (cap === undefined) return { lowered: false, detail: `"${maxLevel}" cannot be placed` };
  if (!(await openModelPicker(runtime, input))) {
    return { lowered: false, detail: "the model picker did not open" };
  }
  try {
    let step = -1;
    let flipped = false;
    const seen = new Set<number>();
    for (;;) {
      const state = await readOpenStateWhenMounted(runtime);
      const value = state?.sliderValue ?? null;
      if (value === null) return { lowered: false, detail: "the effort slider is not mounted" };
      const shown = highestCurrentTierLevel(state);
      const rank = shown ? LEVEL_RANK[shown] : undefined;
      if (rank === undefined) {
        return {
          lowered: false,
          detail: `tier "${state?.tierLabel ?? "unknown"}" cannot be placed`,
        };
      }
      if (rank <= cap) return { lowered: true };
      if (seen.has(value)) return { lowered: false, detail: "no slider step lowers the tier" };
      seen.add(value);
      const next = value + step;
      const outside =
        (state?.sliderMin !== null && state?.sliderMin !== undefined && next < state.sliderMin) ||
        (state?.sliderMax !== null && state?.sliderMax !== undefined && next > state.sliderMax);
      if (outside) {
        if (flipped) return { lowered: false, detail: "no slider step lowers the tier" };
        step = -step;
        flipped = true;
        seen.clear();
        continue;
      }
      const reached = await moveSlider(runtime, input, next);
      if (reached !== next) {
        return { lowered: false, detail: `effort slider stopped at ${reached ?? "unknown"}` };
      }
      // The header can trail the slider for a moment; let the sources settle so a header that
      // still names the old tier does not push the slider past the cap.
      let settled: BrowserModelPickerState | null = null;
      await waitFor(async () => {
        settled = await readOpenState(runtime);
        const levels = new Set(
          (settled?.currentTiers ?? []).map((reading) => thinkingLevelFromTierLabel(reading.label)),
        );
        return levels.size <= 1;
      }, 1_500);
      const afterRank = thinkingLevelRank(highestCurrentTierLevel(settled));
      if (afterRank !== undefined && afterRank > rank && !flipped) {
        step = -step;
        flipped = true;
        seen.clear();
      }
    }
  } finally {
    await closeModelPickerOrRecover(runtime, input, logger);
  }
}

/**
 * Puts the picker back to `target` (model radio first, then the effort slider) and reads it back.
 * A target known only by its tier label is restored by stepping the slider until it shows that
 * tier. The final read must show the slider at the target value (or, in a picker without a
 * slider, the target tier from its header); a stale announcement never counts.
 */
export async function restoreModelPickerState(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  target: BrowserModelPickerState,
  logger: BrowserLogger,
): Promise<ModelPickerRestoreResult> {
  const problems: string[] = [];
  if (!isCompletePickerState(target)) {
    return { restored: false, state: null, detail: "the selection to restore is incomplete" };
  }
  let targetValue = target.sliderValue;
  const targetLevel = currentTierLevel(target);
  try {
    const early = await adjustOpenPicker();
    if (early) return early;
  } finally {
    await closeModelPickerOrRecover(runtime, input, logger);
  }
  return await verifyRestore();

  // Opens the picker and moves model and effort toward the target; a result only when it stops.
  async function adjustOpenPicker(): Promise<ModelPickerRestoreResult | null> {
    if (!(await openModelPicker(runtime, input))) {
      return { restored: false, state: null, detail: "the model picker did not open" };
    }
    let state = await readOpenStateWhenMounted(runtime);
    if (target.modelLabel && state?.modelLabel !== target.modelLabel) {
      const label = target.modelLabel;
      if (await chooseModelRadio(runtime, input, label)) {
        await waitFor(async () => {
          if (!(await isPickerMenuOpen(runtime))) return true;
          return (await readOpenState(runtime))?.modelLabel === label;
        }, 3_000);
        // Reopen fresh so the effort panel (not the model list) is in front for the slider.
        await closeModelPicker(runtime, input);
        if (!(await openModelPicker(runtime, input))) {
          return { restored: false, state: null, detail: "the model picker did not reopen" };
        }
        await waitFor(async () => (await readOpenState(runtime))?.modelLabel === label, 2_000);
      } else {
        problems.push(`model option "${label}" not clickable`);
      }
      // A model switch remounts the effort slider; wait for it before moving it.
      state = await readOpenStateWhenMounted(runtime);
    }
    if (state?.sliderValue !== null && state?.sliderValue !== undefined) {
      if (targetValue !== null) {
        if (state.sliderValue !== targetValue) {
          const reached = await moveSlider(runtime, input, targetValue);
          if (reached !== targetValue)
            problems.push(`effort slider stopped at ${reached ?? "unknown"}`);
        }
      } else if (targetLevel) {
        // Known only by its label: the slider value that shows that tier is the target.
        const moved = await moveSliderToLevel(runtime, input, targetLevel);
        if (moved.matched) targetValue = moved.value;
        else problems.push(moved.detail ?? `tier "${target.tierLabel}" not reached`);
      }
    } else if (state?.sliderPresent !== false) {
      problems.push("the effort slider did not mount");
    }
    return null;
  }

  async function verifyRestore(): Promise<ModelPickerRestoreResult> {
    const finalState = await readModelPickerState(runtime, input, logger);
    // Every field must read back equal; a field that cannot be read is not a restore.
    const modelOk = finalState?.modelLabel === target.modelLabel;
    const finalLevel = currentTierLevel(finalState);
    const sameTier = !finalLevel || !targetLevel || finalLevel === targetLevel;
    const tierOk =
      finalState?.sliderValue !== null && finalState?.sliderValue !== undefined
        ? targetValue !== null && finalState.sliderValue === targetValue && sameTier
        : finalState?.sliderPresent === false && finalLevel !== null && finalLevel === targetLevel;
    const restored = Boolean(finalState) && modelOk && tierOk;
    if (!restored && problems.length === 0) {
      problems.push(finalState ? "the picker shows a different selection" : "picker unreadable");
    }
    if (!restored) logger(`[browser] Select-only: restore incomplete (${problems.join("; ")}).`);
    return {
      restored,
      state: finalState,
      ...(problems.length > 0 ? { detail: problems.join("; ") } : {}),
    };
  }
}

/** Maps an effort tier label shown by the picker to Oracle's thinking level, when recognisable. */
export function thinkingLevelFromTierLabel(
  label: string | null | undefined,
): ThinkingTimeLevel | null {
  const text = label?.normalize("NFC").trim().toLowerCase() ?? "";
  if (!text) return null;
  if (/extra[\s-]*high|sehr hoch|非常に高い|極高|极高|매우 높음/.test(text)) return "extra-high";
  if (/(?:^|[^a-z])pro(?:[^a-z]|$)|프로/.test(text)) return "pro";
  if (/heavy|schwer|重度|加重/.test(text)) return "heavy";
  if (/(?:^|[^a-z])(?:high|extended|hoch|erweitert)(?:[^a-z]|$)|高い|扩展|높음/.test(text))
    return "extended";
  if (/(?:^|[^a-z])(?:medium|standard|mittel)(?:[^a-z]|$)|中程度|标准|중간/.test(text))
    return "standard";
  if (/(?:^|[^a-z])(?:instant|light|sofort|leicht)(?:[^a-z]|$)|最速|极速|즉시/.test(text))
    return "light";
  return null;
}

/** The evidence line for a stored picker reading, with the same shape as formatModelPickerState. */
export function formatModelPickerEvidence(evidence: BrowserModelPickerEvidence): string {
  if (!evidence.readable) return "picker unreadable";
  return formatModelPickerState({
    pickerLabel: null,
    modelLabel: evidence.modelLabel,
    modelOptions: [],
    tierLabel: evidence.tierLabel,
    sliderValue: evidence.sliderValue,
    sliderMin: evidence.sliderMin ?? null,
    sliderMax: evidence.sliderMax ?? null,
    announcement: null,
    currentTiers: evidence.tierReadings,
  });
}

/**
 * Reads the picker for the run's evidence and logs one line. Never fails the run: a picker that
 * cannot be read is recorded as unreadable.
 */
export async function readModelPickerEvidence(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  logger: BrowserLogger,
): Promise<BrowserModelPickerEvidence> {
  let state: BrowserModelPickerState | null = null;
  let failure = "";
  try {
    state = await readModelPickerState(runtime, input, logger);
  } catch (error) {
    if (error instanceof BrowserRunCancelledError) throw error;
    failure = ` (reading it failed: ${error instanceof Error ? error.message : String(error)})`;
  }
  const evidence = modelPickerEvidence(state);
  logger(`[browser] Model picker evidence: ${formatModelPickerEvidence(evidence)}${failure}.`);
  return evidence;
}

/** One line of evidence, e.g. `model "GPT-6", tier "Pro", slider 4 (0-4)`. */
export function formatModelPickerState(state: BrowserModelPickerState | null): string {
  if (!state) return "picker unreadable";
  const slider =
    state.sliderValue === null
      ? "slider n/a"
      : `slider ${state.sliderValue}${state.sliderMin !== null && state.sliderMax !== null ? ` (${state.sliderMin}-${state.sliderMax})` : ""}`;
  // A current source that names another tier than the header (e.g. the slider right after a move).
  const others = (state.currentTiers ?? []).filter((reading) => reading.label !== state.tierLabel);
  const disagreement = others
    .map(
      (reading) =>
        ` (${reading.source === "valuetext" ? "slider text" : "header"} "${reading.label}")`,
    )
    .join("");
  return `model "${state.modelLabel ?? "unknown"}", tier "${state.tierLabel ?? "unknown"}"${disagreement}, ${slider}`;
}
