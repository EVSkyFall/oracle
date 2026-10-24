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
