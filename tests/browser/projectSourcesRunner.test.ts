import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

const launchChromeMock = vi.fn();
const connectWithNewTabMock = vi.fn();
const openProjectSourcesTabMock = vi.fn();
const closeTabMock = vi.fn(async (..._args: unknown[]) => true);
const onscreenMock = vi.fn(async (..._args: unknown[]) => undefined);
const ensurePageMock = vi.fn(async (..._args: unknown[]): Promise<string | undefined> => "spare");

vi.mock("../../src/browser/chromeLifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/chromeLifecycle.js")>()),
  launchChrome: launchChromeMock,
  connectWithNewTab: connectWithNewTabMock,
  closeTab: closeTabMock,
  ensureChromePageTargetAfterClose: ensurePageMock,
  positionChromeWindowOnscreen: onscreenMock,
  positionChromeWindowOffscreen: vi.fn(async () => undefined),
  registerTerminationHooks: vi.fn(() => () => undefined),
}));
vi.mock("../../src/browser/pageActions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/pageActions.js")>()),
  navigateToChatGPT: vi.fn(async () => undefined),
  ensureLoggedIn: vi.fn(async () => undefined),
  installJavaScriptDialogAutoDismissal: vi.fn(() => () => undefined),
}));
vi.mock("../../src/browser/cookies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/cookies.js")>()),
  clearStaleChatGptConversationCookies: vi.fn(async () => undefined),
}));
vi.mock("../../src/browser/actions/projectSources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/actions/projectSources.js")>()),
  openProjectSourcesTab: openProjectSourcesTabMock,
  waitForProjectSourcesReady: vi.fn(async () => undefined),
  waitForProjectSourcesListSettled: vi.fn(async () => []),
}));

const run = async (
  noFocus: boolean,
  emulation: "ok" | "fails" = "ok",
  signIn = false,
  hideWindow = false,
) => {
  onscreenMock.mockClear();
  const events: string[] = [];
  const logs: string[] = [];
  launchChromeMock.mockReset().mockResolvedValue({
    pid: 0,
    port: 9222,
    host: "127.0.0.1",
    kill: vi.fn(async () => undefined),
  });
  const client = {
    Network: { enable: vi.fn(async () => ({})), clearBrowserCookies: vi.fn(async () => ({})) },
    Page: {
      enable: vi.fn(async () => ({})),
      bringToFront: vi.fn(async () => events.push("bringToFront")),
    },
    Runtime: { enable: vi.fn(async () => ({})) },
    DOM: { enable: vi.fn(async () => ({})) },
    Input: {},
    Target: {},
    Emulation: {
      setFocusEmulationEnabled: vi.fn(async () => {
        events.push("focusEmulation");
        if (emulation === "fails") throw new Error("unsupported");
        return {};
      }),
    },
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  connectWithNewTabMock.mockReset().mockResolvedValue({ client, targetId: "sources-tab" });
  // The Sources tab is the first trusted click; stop there.
  openProjectSourcesTabMock.mockReset().mockImplementation(async () => {
    events.push("firstTrustedClick");
    throw new Error("stop-at-first-click");
  });
  const { runBrowserProjectSources } = await import("../../src/browser/projectSourcesRunner.js");
  const pageActions = await import("../../src/browser/pageActions.js");
  // Signed out on the first check, signed in on the next one.
  if (signIn)
    vi.mocked(pageActions.ensureLoggedIn).mockRejectedValueOnce(new Error("Login button detected"));
  const profile = signIn
    ? await mkdtemp(path.join(os.tmpdir(), "oracle-sources-signin-"))
    : undefined;
  try {
    await expect(
      runBrowserProjectSources({
        operation: "list",
        chatgptUrl: "https://chatgpt.com/g/g-p-123-example/project",
        config: signIn
          ? {
              noFocus,
              manualLogin: true,
              manualLoginProfileDir: profile,
              keepBrowser: true,
              hideWindow,
              // No Chrome to reuse; skip the wait for one.
              reuseChromeWaitMs: 0,
            }
          : { noFocus, manualLogin: false, cookieSync: false },
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow("stop-at-first-click");
  } finally {
    // Windows: the background lease release can still be deleting files in the profile.
    if (profile)
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const tabOptions = connectWithNewTabMock.mock.calls[0]?.[4];
  return {
    events,
    logs,
    background: tabOptions?.background,
    fallbackToDefault: tabOptions?.fallbackToDefault,
  };
};

describe("runBrowserProjectSources no-focus setup", () => {
  // /json/new and Page.bringToFront activate Chrome on macOS; a background tab needs
  // focus emulation so its trusted clicks still land.
  test("opens a background tab and emulates focus before the first trusted click", async () => {
    const { events, background, fallbackToDefault } = await run(true);

    expect(background).toBe(true);
    // A no-focus launch has no startup page to fall back to.
    expect(fallbackToDefault).toBe(false);
    expect(events).toEqual(["focusEmulation", "firstTrustedClick"]);
  });

  test("brings the tab to the front when focus emulation cannot be enabled", async () => {
    const { events, logs } = await run(true, "fails");

    expect(events).toEqual(["focusEmulation", "bringToFront", "firstTrustedClick"]);
    expect(logs).toContain(
      "[browser] Focus emulation is unavailable; no-focus fallback: Oracle will bring Chrome to the front before trusted clicks.",
    );
  });

  test("keeps the flag-off setup unchanged", async () => {
    const { events, background, fallbackToDefault } = await run(false);

    expect(background).toBe(false);
    expect(fallbackToDefault).toBe(true);
    expect(events).toEqual(["firstTrustedClick"]);
  });

  test.each([true, false])(
    "brings Chrome forward once for sign-in only when noFocus=%s",
    async (noFocus) => {
      const { events, logs } = await run(noFocus, "ok", true);

      expect(logs.some((line) => line.includes("Manual login mode"))).toBe(true);
      // Emulation is set up first; sign-in then brings Chrome forward once, and the click itself
      // skips activation.
      expect(events).toEqual(
        noFocus ? ["focusEmulation", "bringToFront", "firstTrustedClick"] : ["firstTrustedClick"],
      );
    },
    15_000,
  );

  // A kept no-focus Chrome has no startup page, so closing the only tab could leave it with none.
  test.each([
    { keepBrowser: true, spare: "spare", closes: true },
    { keepBrowser: true, spare: undefined, closes: false },
    { keepBrowser: false, spare: undefined, closes: true },
  ])(
    "keeps a page before closing the tab (keepBrowser $keepBrowser, replacement $spare)",
    async ({ keepBrowser, spare, closes }) => {
      launchChromeMock.mockReset().mockResolvedValue({
        pid: 0,
        port: 9222,
        host: "127.0.0.1",
        kill: vi.fn(async () => undefined),
      });
      const client = {
        Network: { enable: vi.fn(async () => ({})), clearBrowserCookies: vi.fn(async () => ({})) },
        Page: { enable: vi.fn(async () => ({})), bringToFront: vi.fn(async () => ({})) },
        Runtime: { enable: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        Input: {},
        Target: {},
        Emulation: { setFocusEmulationEnabled: vi.fn(async () => ({})) },
        on: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      connectWithNewTabMock.mockReset().mockResolvedValue({ client, targetId: "sources-tab" });
      openProjectSourcesTabMock.mockReset().mockResolvedValue(undefined);
      closeTabMock.mockClear();
      ensurePageMock.mockReset().mockResolvedValue(spare);
      const logs: string[] = [];
      const { runBrowserProjectSources } =
        await import("../../src/browser/projectSourcesRunner.js");

      await expect(
        runBrowserProjectSources({
          operation: "list",
          chatgptUrl: "https://chatgpt.com/g/g-p-123-example/project",
          config: { noFocus: true, manualLogin: false, cookieSync: false, keepBrowser },
          log: (line) => logs.push(line),
        }),
      ).resolves.toMatchObject({ status: "ok" });

      if (keepBrowser) {
        expect(ensurePageMock).toHaveBeenCalledWith(
          9222,
          "sources-tab",
          expect.any(Function),
          "127.0.0.1",
          { background: true },
        );
      } else {
        expect(ensurePageMock).not.toHaveBeenCalled();
      }
      expect(closeTabMock).toHaveBeenCalledTimes(closes ? 1 : 0);
      expect(logs.some((line) => line.includes("Leaving the Project Sources tab open"))).toBe(
        !closes,
      );
    },
  );

  test.each([true, false])(
    "moves a hidden window on-screen for sign-in only when noFocus=%s",
    async (noFocus) => {
      // Hide-window setup moves the window off-screen; only the sign-in wait brings it back.
      await run(noFocus, "ok", true, true);
      expect(onscreenMock).toHaveBeenCalledTimes(noFocus ? 1 : 0);
    },
    15_000,
  );
});
