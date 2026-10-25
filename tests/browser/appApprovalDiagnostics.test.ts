import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveAppApprovalDiagnostic } from "../../src/browser/appApprovalDiagnostics.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("app approval diagnostic files", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-approval-diag-"));
    setOracleHomeDirOverrideForTest(home);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  const diagnostic = {
    reason: '[browser] App approval left for the user: no known allow label among "Continue".',
    capturedAt: "2026-10-26T03:00:00.000Z",
    page: {
      url: "https://chatgpt.com/c/abc",
      html: '<div role="alert"><p>Allow CODEXish?</p><button>Continue</button><script>x()</script></div>',
      htmlLength: 40_000,
      ancestors: [
        { tag: "div", id: "", className: "", role: "alert", testId: "" },
        { tag: "form", id: "", className: "relative flex", role: "", testId: "composer" },
        { tag: "body", id: "", className: "", role: "", testId: "" },
      ],
      buttons: [{ label: "Continue", text: "Continue", ariaLabel: null, disabled: false }],
    },
  };

  test("writes numbered, inert HTML files into the session's artifacts directory", async () => {
    const first = await saveAppApprovalDiagnostic("ask-1", diagnostic);
    const second = await saveAppApprovalDiagnostic("ask-1", { ...diagnostic, page: null });
    const dir = path.join(home, "sessions", "ask-1", "artifacts");
    expect(first).toBe(path.join(dir, "app-approval-diag-1.html"));
    expect(second).toBe(path.join(dir, "app-approval-diag-2.html"));
    const html = await fs.readFile(first!, "utf8");
    expect(html).toContain(
      '<h1>[browser] App approval left for the user: no known allow label among "Continue".</h1>',
    );
    expect(html).toContain("https://chatgpt.com/c/abc");
    // The card's markup is text, never live markup.
    expect(html).toContain("&lt;script&gt;x()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('form class="relative flex" data-testid="composer"');
    expect(html).toContain("40000 characters, cut");
    expect(html).toContain('"label": "Continue"');
    expect(await fs.readFile(second!, "utf8")).toContain("gone before it could be read");
  });

  test("writes nothing without a session", async () => {
    expect(await saveAppApprovalDiagnostic(undefined, diagnostic)).toBeUndefined();
    expect(await fs.readdir(home)).toEqual([]);
  });
});
