/**
 * Selectors for the parts of ChatGPT's page that the page functions tell apart. The page
 * functions are injected with Function.prototype.toString and keep their own copies inline;
 * tests/browser/pageSurfaces.test.ts keeps each copy equal to these.
 */

/** Sidebar, navigation and header (appApprovals.ts scanAppApprovalCards: PAGE_CHROME). */
export const PAGE_CHROME_SELECTOR = 'nav, aside, header, [data-testid*="sidebar" i]';

/** User turns, today's role-less ones included (appApprovals.ts scanAppApprovalCards: USER). */
export const USER_MESSAGE_SELECTOR =
  '[data-message-author-role="user"], [data-turn="user"], .rich-text-user-turn, [class~="group/user-message"]';

/** An answer's Markdown or prose (appApprovals.ts scanAppApprovalCards: PROSE). */
export const PROSE_SELECTOR = '.markdown, [class*="markdown"], [class*="prose"]';

/** Editors (appApprovals.ts scanAppApprovalCards: EDITABLE). */
export const EDITABLE_SELECTOR =
  '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], textarea';

/** Dialogs (appApprovals.ts scanAppApprovalCards: DIALOG). */
export const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

/** Tool arguments and code (appApprovals.ts scanAppApprovalCards: ARGUMENTS). */
export const ARGUMENTS_SELECTOR = "code, pre, samp, kbd";

/** Reasoning panels and sidecars (turnResync.ts readTurnProgress: PANEL). */
export const PANEL_SELECTOR =
  '[data-testid*="thinking"], [data-testid*="reasoning"], [class*="sidecar"]';

/** Approval cards (turnResync.ts readTurnProgress: SURFACE, without its alert roles). */
export const APPROVAL_CARD_SELECTOR =
  '[data-codex-approval-surface="true"], [class*="approval-card"]';
