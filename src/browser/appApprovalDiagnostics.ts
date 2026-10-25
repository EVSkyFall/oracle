import fs from "node:fs/promises";
import path from "node:path";
import type { AppApprovalDiagnostic } from "./actions/appApprovals.js";
import { resolveSessionArtifactsDir } from "./artifacts.js";

const FILE_PATTERN = /^app-approval-diag-(\d+)\.html$/;

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A self-contained, inert HTML page: the card's markup is shown as text (never rendered), with
 * its buttons and ancestors, so it can be read in any browser or editor.
 */
export function renderAppApprovalDiagnostic(diagnostic: AppApprovalDiagnostic): string {
  const page = diagnostic.page;
  const ancestors = (page?.ancestors ?? []).map((node) =>
    [
      node.tag,
      node.id ? `#${node.id}` : "",
      node.className ? ` class="${node.className}"` : "",
      node.role ? ` role="${node.role}"` : "",
      node.testId ? ` data-testid="${node.testId}"` : "",
    ].join(""),
  );
  const truncated = page && page.htmlLength > page.html.length ? ", cut" : "";
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Oracle app approval diagnostic</title></head><body>',
    `<h1>${escapeHtml(diagnostic.reason)}</h1>`,
    `<p>Captured ${escapeHtml(diagnostic.capturedAt)}${page ? ` on ${escapeHtml(page.url)}` : ""}.</p>`,
    page ? "" : "<p>The card was gone before it could be read.</p>",
    page?.withheld
      ? "<p>The element was wider than a card (it held the main area, the composer or the conversation), so its markup was not saved.</p>"
      : "",
    "<h2>Buttons</h2>",
    `<pre>${escapeHtml(JSON.stringify(page?.buttons ?? [], null, 2))}</pre>`,
    "<h2>Ancestors (the card first, up to body)</h2>",
    `<pre>${escapeHtml(ancestors.join("\n"))}</pre>`,
    `<h2>Card outerHTML (${page?.htmlLength ?? 0} characters${truncated})</h2>`,
    `<pre>${escapeHtml(page?.html ?? "")}</pre>`,
    "</body></html>",
    "",
  ].join("\n");
}

/**
 * Writes the diagnostic as `artifacts/app-approval-diag-<n>.html` in the session's directory and
 * returns its path; nothing is written without a session id.
 */
export async function saveAppApprovalDiagnostic(
  sessionId: string | undefined,
  diagnostic: AppApprovalDiagnostic,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const dir = resolveSessionArtifactsDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const used = (await fs.readdir(dir).catch(() => [] as string[]))
    .map((name) => Number(FILE_PATTERN.exec(name)?.[1] ?? 0))
    .filter((value) => value > 0);
  let next = used.length > 0 ? Math.max(...used) + 1 : 1;
  const contents = renderAppApprovalDiagnostic(diagnostic);
  for (;;) {
    const target = path.join(dir, `app-approval-diag-${next}.html`);
    try {
      await fs.writeFile(target, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return target;
    } catch (error) {
      // Another monitor of the same run took this number first.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      next += 1;
    }
  }
}
