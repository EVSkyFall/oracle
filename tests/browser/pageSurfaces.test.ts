import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  APPROVAL_CARD_SELECTOR,
  ARGUMENTS_SELECTOR,
  DIALOG_SELECTOR,
  EDITABLE_SELECTOR,
  PAGE_CHROME_SELECTOR,
  PANEL_SELECTOR,
  PROSE_SELECTOR,
  USER_MESSAGE_SELECTOR,
} from "../../src/browser/pageSurfaces.js";

// The page functions keep their selectors inline (they are injected with toString); the shared
// copies the banner detector uses must stay the same strings.
const source = (file: string) =>
  readFile(new URL(`../../src/browser/${file}`, import.meta.url), "utf8");

test("the shared page-surface selectors are the approval scanner's and the progress reader's own", async () => {
  const approvals = await source("actions/appApprovals.ts");
  for (const selector of [
    PAGE_CHROME_SELECTOR,
    USER_MESSAGE_SELECTOR,
    PROSE_SELECTOR,
    EDITABLE_SELECTOR,
    DIALOG_SELECTOR,
    ARGUMENTS_SELECTOR,
  ]) {
    expect(approvals, selector).toMatch(
      new RegExp(`['"]${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`),
    );
  }
  const progress = await source("turnResync.ts");
  expect(progress).toContain(`'${PANEL_SELECTOR}'`);
  expect(progress).toContain(`'${APPROVAL_CARD_SELECTOR}, [role="alert"]`);
});
