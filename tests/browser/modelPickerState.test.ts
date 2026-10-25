import { describe, expect, test } from "vitest";
import {
  findModelPickerButton,
  findModelPickerMenu,
  formatModelPickerState,
  readModelPickerMenuState,
  thinkingLevelFromTierLabel,
} from "../../src/browser/actions/modelPickerState.js";
import { MODEL_BUTTON_SELECTOR } from "../../src/browser/constants.js";
import { FakeDocument, FakeElement } from "./domFixture.js";

const SELECTORS = MODEL_BUTTON_SELECTOR.split(", ");

// The picker as measured on chatgpt.com (2026-10-25): one Radix menu with the tier name, the
// effort slider and the model radios.
function livePicker(options: { tier?: string; value?: string; model?: string } = {}) {
  const button = new FakeElement(
    "button",
    { "aria-label": "Select ChatGPT model", "aria-haspopup": "menu", "aria-controls": "radix-m" },
    [],
    `Thinking effort ${options.tier ?? "Medium"}`,
  );
  const menu = new FakeElement("div", { role: "menu", id: "radix-m" }, [
    new FakeElement(
      "div",
      { role: "menuitem", "aria-label": "Select model" },
      [],
      options.tier ?? "Medium",
    ),
    new FakeElement("div", { role: "menuitem", "aria-label": "Power" }, [
      new FakeElement("span", {
        role: "slider",
        "aria-valuemin": "0",
        "aria-valuemax": "4",
        "aria-valuenow": options.value ?? "1",
      }),
    ]),
    new FakeElement(
      "div",
      { role: "menuitemradio", "aria-checked": String((options.model ?? "GPT-6") === "GPT-6") },
      [],
      "GPT-6",
    ),
    new FakeElement(
      "div",
      {
        role: "menuitemradio",
        "aria-checked": String((options.model ?? "GPT-6") === "GPT-5.6 Sol"),
      },
      [],
      "GPT-5.6 Sol",
    ),
  ]);
  const live = new FakeElement(
    "div",
    { "aria-live": "polite" },
    [],
    `${options.tier ?? "Medium"}, 2 of 5.`,
  );
  const document = new FakeDocument([new FakeElement("form", {}, [button]), menu, live]);
  return { document, button, menu };
}

describe("model picker state", () => {
  test("reads model, tier, slider and announcement from the open picker", () => {
    const { document, button, menu } = livePicker();
    const doc = document as unknown as Document;
    expect(findModelPickerButton(doc, SELECTORS)).toBe(button);
    expect(findModelPickerMenu(doc, button as unknown as Element)).toBe(menu);
    const state = readModelPickerMenuState(
      doc,
      button as unknown as Element,
      menu as unknown as Element,
    );
    expect(state).toEqual({
      pickerLabel: "Thinking effort Medium",
      modelLabel: "GPT-6",
      modelOptions: ["GPT-6", "GPT-5.6 Sol"],
      tierLabel: "Medium",
      sliderValue: 1,
      sliderMin: 0,
      sliderMax: 4,
      announcement: "Medium, 2 of 5.",
      tierSource: "header",
      currentTiers: [],
      sliderPresent: true,
    });
    expect(formatModelPickerState(state)).toBe('model "GPT-6", tier "Medium", slider 1 (0-4)');
  });

  test("finds the picker menu by its contents when the button names no menu", () => {
    const other = new FakeElement("div", { role: "menu", id: "unrelated" }, [
      new FakeElement("div", { role: "menuitem" }, [], "Rename"),
    ]);
    const { document, menu } = livePicker({ tier: "Pro", value: "4", model: "GPT-5.6 Sol" });
    document.body.children.unshift(other);
    other.parentElement = document.body;
    const button = new FakeElement("button", { "aria-label": "Select ChatGPT model" });
    const doc = document as unknown as Document;
    expect(findModelPickerMenu(doc, button as unknown as Element)).toBe(menu);
    const state = readModelPickerMenuState(doc, null, menu as unknown as Element);
    expect(state).toMatchObject({ modelLabel: "GPT-5.6 Sol", tierLabel: "Pro", sliderValue: 4 });
  });

  test("a closed picker yields no menu and only the button label", () => {
    const button = new FakeElement("button", { "aria-label": "Select ChatGPT model" }, [], "Pro");
    const document = new FakeDocument([button]);
    const doc = document as unknown as Document;
    expect(findModelPickerMenu(doc, button as unknown as Element)).toBeNull();
    expect(readModelPickerMenuState(doc, button as unknown as Element, null)).toMatchObject({
      pickerLabel: "Pro",
      modelLabel: null,
      sliderValue: null,
    });
  });

  test("takes the tier from the first candidate that names a known level", () => {
    class Lines extends FakeElement {
      constructor(
        attributes: Record<string, string>,
        readonly lines: string,
      ) {
        super("div", attributes, [], lines.replace(/\n/g, ""));
      }
      override get innerText() {
        return this.lines;
      }
    }
    const read = (header: FakeElement, announcement: string) => {
      const menu = new FakeElement("div", { role: "menu" }, [
        header,
        new FakeElement("div", { role: "menuitem", "aria-label": "Power" }, [
          new FakeElement("span", { role: "slider", "aria-valuenow": "2" }),
        ]),
      ]);
      const live = new FakeElement("div", { "aria-live": "polite" }, [], announcement);
      return readModelPickerMenuState(
        new FakeDocument([menu, live]) as unknown as Document,
        null,
        menu as unknown as Element,
        thinkingLevelFromTierLabel,
      );
    };
    expect(read(new Lines({ role: "menuitem" }, "Thinking effort\nMedium"), "").tierLabel).toBe(
      "Medium",
    );
    expect(
      read(new FakeElement("div", { role: "menuitem" }, [], "Switch model"), "High, 3 of 5."),
    ).toMatchObject({ tierLabel: "High", announcement: "High, 3 of 5." });
    expect(read(new FakeElement("div", { role: "menuitem" }, [], "5.6"), "").tierLabel).toBe("5.6");
  });

  test("a tier label counts only as a whole label, never as part of other text", async () => {
    const { highestTierInButtonText } =
      await import("../../src/browser/actions/modelPickerState.js");
    for (const text of [
      "ChatGPT Pro",
      "Pro mode",
      "프로젝트",
      "Upgrade to Pro",
      "Projects (Pro)",
      "Try GPT-6 Pro",
      "High priority",
      "Medium-sized",
    ]) {
      expect(thinkingLevelFromTierLabel(text), text).toBeNull();
    }
    expect(thinkingLevelFromTierLabel("Pro")).toBe("pro");
    expect(thinkingLevelFromTierLabel("프로")).toBe("pro");
    expect(thinkingLevelFromTierLabel("Extra High")).toBe("extra-high");
    expect(thinkingLevelFromTierLabel("extra-high")).toBe("extra-high");
    expect(thinkingLevelFromTierLabel("매우 높음")).toBe("extra-high");
    expect(thinkingLevelFromTierLabel("Medium")).toBe("standard");
    expect(thinkingLevelFromTierLabel("  Extra High (current) ")).toBe("extra-high");
    expect(thinkingLevelFromTierLabel("“Pro”.")).toBe("pro");
    expect(thinkingLevelFromTierLabel("ＰＲＯ".normalize("NFKC"))).toBe("pro");
    expect(highestTierInButtonText("Thinking effort\nExtra High")).toBe("extra-high");
    expect(highestTierInButtonText("ChatGPT Pro\nThinking effort")).toBeNull();
  });

  test("maps tier labels to thinking levels and leaves unknown labels alone", () => {
    expect(thinkingLevelFromTierLabel("Instant")).toBe("light");
    expect(thinkingLevelFromTierLabel("Medium")).toBe("standard");
    expect(thinkingLevelFromTierLabel("High")).toBe("extended");
    expect(thinkingLevelFromTierLabel("Extra High")).toBe("extra-high");
    expect(thinkingLevelFromTierLabel("Pro")).toBe("pro");
    expect(thinkingLevelFromTierLabel("Heavy")).toBe("heavy");
    expect(thinkingLevelFromTierLabel("매우 높음")).toBe("extra-high");
    expect(thinkingLevelFromTierLabel("중간")).toBe("standard");
    expect(thinkingLevelFromTierLabel("Produce")).toBeNull();
    expect(thinkingLevelFromTierLabel("Turbo")).toBeNull();
    expect(thinkingLevelFromTierLabel(null)).toBeNull();
  });
});

describe("picker evidence", () => {
  test("keeps model, trusted tier and slider, and leaves out a tier named only by an announcement", async () => {
    const { modelPickerEvidence } = await import("../../src/browser/actions/modelPickerState.js");
    const base = {
      pickerLabel: null,
      modelLabel: "GPT-6",
      modelOptions: [],
      tierLabel: "Extra High",
      sliderValue: 3,
      sliderMin: 0,
      sliderMax: 4,
      announcement: "Extra High, 4 of 5.",
    };
    expect(modelPickerEvidence({ ...base, tierSource: "header" })).toMatchObject({
      modelLabel: "GPT-6",
      tierLabel: "Extra High",
      sliderValue: 3,
      sliderMin: 0,
      sliderMax: 4,
      readable: true,
      source: "chatgpt-model-picker",
    });
    expect(
      modelPickerEvidence({ ...base, tierSource: "announcement", sliderValue: null }),
    ).toMatchObject({ tierLabel: null, sliderValue: null, readable: true });
    expect(modelPickerEvidence(null)).toMatchObject({ modelLabel: null, readable: false });
  });

  test("a picker read that fails is recorded as unreadable and logged in one line", async () => {
    const { readModelPickerEvidence } =
      await import("../../src/browser/actions/modelPickerState.js");
    const lines: string[] = [];
    const logger = Object.assign((line: string) => lines.push(line), { verbose: false });
    const runtime = {
      evaluate: async () => {
        throw new Error("Target closed");
      },
    };
    await expect(
      readModelPickerEvidence(runtime as never, undefined, logger),
    ).resolves.toMatchObject({ readable: false });
    // The evidence is one line; the attempt to leave no menu open reports its own failure.
    expect(lines).toEqual([
      "[browser] Model picker: closing the menu failed (Target closed).",
      "[browser] Model picker evidence: picker unreadable (reading it failed: Target closed).",
    ]);
  });
});

describe("tier header and current tier sources", () => {
  const slider = (attributes: Record<string, string>) =>
    new FakeElement("div", { role: "menuitem", "aria-label": "Power" }, [
      new FakeElement("span", {
        role: "slider",
        "aria-valuemin": "0",
        "aria-valuemax": "4",
        ...attributes,
      }),
    ]);
  const readMenu = (children: FakeElement[], announcement = "") => {
    const menu = new FakeElement("div", { role: "menu" }, children);
    const live = new FakeElement("div", { "aria-live": "polite" }, [], announcement);
    return readModelPickerMenuState(
      new FakeDocument([menu, live]) as unknown as Document,
      null,
      menu as unknown as Element,
      thinkingLevelFromTierLabel,
    );
  };

  test("finds a localized tier header by structure, never an item placed before it", () => {
    const withPopup = readMenu(
      [
        new FakeElement("div", { role: "menuitem" }, [], "임시 채팅"),
        new FakeElement("div", { role: "menuitem", "aria-haspopup": "menu" }, [], "Pro"),
        slider({ "aria-valuenow": "4" }),
      ],
      "Medium, 2 of 5.",
    );
    expect(withPopup).toMatchObject({ tierLabel: "Pro", tierSource: "header" });
    const beforeSlider = readMenu([
      new FakeElement("div", { role: "menuitem" }, [], "Temporary chat"),
      new FakeElement("div", { role: "menuitem" }, [], "Pro"),
      slider({ "aria-valuenow": "4" }),
    ]);
    expect(beforeSlider).toMatchObject({ tierLabel: "Pro", tierSource: "header" });
  });

  test("a header and slider text that disagree are both kept, and the highest one counts", async () => {
    const { highestCurrentTierLevel, currentTierLevel } =
      await import("../../src/browser/actions/modelPickerState.js");
    const state = readMenu([
      new FakeElement("div", { role: "menuitem", "aria-label": "Select model" }, [], "Extra High"),
      slider({ "aria-valuenow": "4", "aria-valuetext": "Pro" }),
    ]);
    expect(state.currentTiers).toEqual([
      { label: "Extra High", source: "header" },
      { label: "Pro", source: "valuetext" },
    ]);
    expect(currentTierLevel(state)).toBe("extra-high");
    expect(highestCurrentTierLevel(state)).toBe("pro");
    expect(formatModelPickerState(state)).toBe(
      'model "unknown", tier "Extra High" (slider text "Pro"), slider 4 (0-4)',
    );
  });

  test("a localized header that names no tier leaves the tier to the slider text", async () => {
    const { highestCurrentTierLevel } =
      await import("../../src/browser/actions/modelPickerState.js");
    const state = readMenu(
      [
        new FakeElement("div", { role: "menuitem" }, [], "임시 채팅"),
        new FakeElement("div", { role: "menuitem", "aria-haspopup": "menu" }, [], "모델"),
        slider({ "aria-valuenow": "4", "aria-valuetext": "Pro" }),
      ],
      "Medium, 2 of 5.",
    );
    expect(state.currentTiers).toEqual([{ label: "Pro", source: "valuetext" }]);
    expect(highestCurrentTierLevel(state)).toBe("pro");
  });
});
