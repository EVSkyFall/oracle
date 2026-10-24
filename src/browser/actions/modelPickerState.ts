import type { ChromeClient, BrowserLogger, BrowserModelPickerState } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
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
  const tierItem = menu
    ? Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
        (item) => visible(item) && !item.querySelector('[role="slider"]') && firstLine(item),
      )
    : undefined;
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
  const candidates = [
    ...headerLines.map((label) => ({ label, text: null as string | null })),
    ...(valueText ? [{ label: valueText, text: null as string | null }] : []),
    ...spoken,
  ];
  const known = candidates.find((candidate) => candidate.label && levelOf(candidate.label));
  const announcement = known?.text ?? announcements.at(-1) ?? null;
  const tierLabel = known?.label ?? headerLines[0] ?? valueText ?? (spoken[0]?.label || null);
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

/** Opens the picker, reads what it shows and closes it again. Null when it cannot be opened. */
export async function readModelPickerState(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
): Promise<BrowserModelPickerState | null> {
  if (!(await openModelPicker(runtime, input))) return null;
  // The tier header and slider render a beat after the menu itself.
  let state: BrowserModelPickerState | null = null;
  await waitFor(async () => {
    state = await readOpenState(runtime);
    return Boolean(state && (state.modelLabel || state.sliderValue !== null));
  }, 1_500);
  await closeModelPicker(runtime, input);
  return state;
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
      return items.find(node => /model/i.test(node.getAttribute('aria-label') ?? '')) ?? items.find(node => (node.innerText ?? '').trim()) ?? null;
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
  let current = (await readOpenState(runtime))?.sliderValue ?? null;
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
 * Puts the picker back to `target` (model radio first, then the effort slider) and reads it back.
 */
export async function restoreModelPickerState(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  target: BrowserModelPickerState,
  logger: BrowserLogger,
): Promise<ModelPickerRestoreResult> {
  const problems: string[] = [];
  if (!(await openModelPicker(runtime, input))) {
    return { restored: false, state: null, detail: "the model picker did not open" };
  }
  let state = await readOpenState(runtime);
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
    state = await readOpenState(runtime);
  }
  if (target.sliderValue !== null && state && state.sliderValue !== target.sliderValue) {
    const reached = await moveSlider(runtime, input, target.sliderValue);
    if (reached !== target.sliderValue) {
      problems.push(`effort slider stopped at ${reached ?? "unknown"}`);
    }
  }
  await closeModelPicker(runtime, input);
  const finalState = await readModelPickerState(runtime, input);
  const modelOk = !target.modelLabel || finalState?.modelLabel === target.modelLabel;
  const sliderOk = target.sliderValue === null || finalState?.sliderValue === target.sliderValue;
  const restored = Boolean(finalState) && modelOk && sliderOk;
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

/** One line of evidence, e.g. `model "GPT-6", tier "Pro", slider 4 (0-4)`. */
export function formatModelPickerState(state: BrowserModelPickerState | null): string {
  if (!state) return "picker unreadable";
  const slider =
    state.sliderValue === null
      ? "slider n/a"
      : `slider ${state.sliderValue}${state.sliderMin !== null && state.sliderMax !== null ? ` (${state.sliderMin}-${state.sliderMax})` : ""}`;
  return `model "${state.modelLabel ?? "unknown"}", tier "${state.tierLabel ?? "unknown"}", ${slider}`;
}
