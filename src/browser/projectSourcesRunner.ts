import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LaunchedChrome } from "chrome-launcher";
import {
  closeTab,
  ensureChromePageTargetAfterClose,
  connectWithNewTab,
  launchChrome,
  positionChromeWindowOffscreen,
  positionChromeWindowOnscreen,
  registerTerminationHooks,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import {
  bringChromeForwardForUser,
  enableFocusEmulation,
  shouldActivateBeforeTrustedInput,
} from "./focusEmulation.js";
import { maybeReuseRunningChrome } from "./reuseChrome.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import {
  installJavaScriptDialogAutoDismissal,
  navigateToChatGPT,
  ensureLoggedIn,
} from "./pageActions.js";
import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "./types.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "./tabLeaseRegistry.js";
import {
  acquireProfileRunLock,
  cleanupStaleProfileState,
  shouldCleanupManualLoginProfileState,
  terminateRecordedChromeForProfile,
  writeChromePid,
  writeDevToolsActivePort,
  type ProfileRunLock,
} from "./profileState.js";
import { CHATGPT_URL } from "./constants.js";
import { delay } from "./utils.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
  formatManualLoginSetupCommand,
  resolveManualLoginWaitMs,
} from "./manualLoginProfile.js";
import {
  openProjectSourcesTab,
  uploadProjectSources,
  waitForProjectSourcesReady,
  waitForProjectSourcesListSettled,
} from "./actions/projectSources.js";
import { normalizeProjectSourcesUrl } from "../projectSources/url.js";
import { buildProjectSourcesUploadPlan, diffAddedProjectSources } from "../projectSources/plan.js";
import type { ProjectSourcesRequest, ProjectSourcesResult } from "../projectSources/types.js";
import { CHROME_COOKIE_SYNC_WARNING, shouldSyncBrowserCookies } from "./policies.js";

type BrowserChrome = LaunchedChrome & { host?: string };

async function releaseProjectSourcesBrowserTabLease(options: {
  lease: BrowserTabLease;
  terminateSharedChrome?: () => Promise<boolean>;
  chromePid?: number;
  chromePort?: number;
  logger: BrowserLogger;
}): Promise<{
  keepBrowserOpen: boolean;
  terminationHandled: boolean;
  releaseError?: Error;
}> {
  let decisionObserved = false;
  let keepBrowserOpen = false;
  let terminationHandled = false;
  let otherLeasesRemain = false;
  let releaseError: Error | undefined;
  try {
    await options.lease.release({
      onRelease: async ({ isLastLease }) => {
        decisionObserved = true;
        if (!isLastLease) {
          keepBrowserOpen = true;
          otherLeasesRemain = true;
          return;
        }
        if (!options.terminateSharedChrome) return;
        options.logger(
          `[browser] ChatGPT browser slot ${options.lease.id.slice(0, 8)} is final; ` +
            `terminating shared Chrome (session=project-sources; controllerPid=${process.pid}; ` +
            `chromePid=${options.chromePid ?? "unknown"}; chromePort=${options.chromePort ?? "unknown"}).`,
        );
        const terminated = await options.terminateSharedChrome().catch(() => false);
        if (terminated) {
          terminationHandled = true;
        } else {
          keepBrowserOpen = true;
          options.logger(
            "[browser] Could not verify shared Chrome termination; leaving it available for reuse.",
          );
        }
      },
    });
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error(String(error));
    if (!terminationHandled) keepBrowserOpen = true;
    options.logger(
      `[browser] Failed to release the ChatGPT browser slot registry lock (a busy lock is retried in the background; restart Oracle/Codex MCP if later runs keep waiting for a slot): ${releaseError.message}`,
    );
  }
  if (!decisionObserved) {
    keepBrowserOpen = true;
    options.logger(
      "[browser] Could not verify final ChatGPT tab lease; leaving shared Chrome running.",
    );
  } else if (otherLeasesRemain) {
    options.logger(
      `[browser] Other ChatGPT tab leases still active; leaving shared Chrome running; ` +
        `browser slot ${options.lease.id.slice(0, 8)} is non-final ` +
        `(session=project-sources; controllerPid=${process.pid}; ` +
        `chromePid=${options.chromePid ?? "unknown"}; chromePort=${options.chromePort ?? "unknown"}).`,
    );
  }
  return {
    keepBrowserOpen,
    terminationHandled,
    ...(releaseError ? { releaseError } : {}),
  };
}

export async function runBrowserProjectSources(
  request: ProjectSourcesRequest,
): Promise<ProjectSourcesResult> {
  const startedAt = Date.now();
  const logger: BrowserLogger = ((message: string) => request.log?.(message)) as BrowserLogger;
  const projectUrl = normalizeProjectSourcesUrl(request.chatgptUrl);
  const operation = request.operation;
  const files = request.files ?? [];
  const plannedUploads = buildProjectSourcesUploadPlan(files);
  const warnings: string[] = [];
  if (operation === "add" && files.length === 0) {
    throw new Error("Project Sources add requires at least one file.");
  }
  if (request.dryRun) {
    return {
      status: "dry-run",
      operation,
      projectUrl,
      dryRun: true,
      plannedUploads,
      warnings,
      tookMs: Date.now() - startedAt,
    };
  }

  let config = resolveBrowserConfig({
    ...request.config,
    url: projectUrl,
    chatgptUrl: projectUrl,
  });
  if (config.remoteChrome) {
    throw new Error(
      "Project Sources v1 uses local browser automation only. Run it on the signed-in browser host.",
    );
  }

  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-"));
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    await assertManualLoginProfileReadyForRun({
      userDataDir,
      keepBrowser: effectiveKeepBrowser,
    });
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  let tabLease: BrowserTabLease | null = null;
  if (manualLogin) {
    tabLease = await acquireBrowserTabLease(userDataDir, {
      maxConcurrentTabs: config.maxConcurrentTabs,
      timeoutMs: config.timeoutMs,
      logger,
      sessionId: "project-sources",
    });
  }

  let chrome: BrowserChrome | null = null;
  let reusedChrome: LaunchedChrome | null = null;
  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connectionClosedUnexpectedly = false;
  let completed = false;

  try {
    const acquired = manualLogin
      ? await acquireManualLoginChromeForProjectSources(userDataDir, config, logger)
      : {
          chrome: await launchChrome({ ...config, remoteChrome: null }, userDataDir, logger),
          reusedChrome: null,
        };
    chrome = acquired.chrome;
    reusedChrome = acquired.reusedChrome;
    const chromeHost = chrome.host ?? "127.0.0.1";
    if (tabLease) {
      await tabLease.update({ chromeHost, chromePort: chrome.port });
    }

    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      {
        isInFlight: () => !completed,
        preserveUserDataDir: manualLogin,
        preserveSharedChromeOnSignal: manualLogin,
      },
    );

    const strictTabIsolation = Boolean(manualLogin && reusedChrome);
    const devtoolsRetries = manualLogin ? 6 : 0;
    const connection = await connectWithNewTab(chrome.port, logger, "about:blank", chromeHost, {
      // A no-focus launch has no startup page, so there is no default tab to fall back to.
      fallbackToDefault: !strictTabIsolation && !(config.noFocus && !config.headless),
      retries: devtoolsRetries,
      retryDelayMs: 500,
      background: config.noFocus,
    });
    client = connection.client;
    isolatedTargetId = connection.targetId ?? null;
    if (tabLease && isolatedTargetId) {
      await tabLease.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: isolatedTargetId,
        tabUrl: projectUrl,
      });
    }

    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        reject(new Error("Chrome window closed before Project Sources finished."));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);

    const { Network, Page, Runtime, Input, DOM, Target } = client;
    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(client, userDataDir, logger);
    } else if (!config.headless) {
      await positionChromeWindowOnscreen(client, userDataDir, logger);
    }
    // A no-focus tab stays behind other apps, so its trusted clicks need focus emulation.
    const activateBeforeTrustedInput = config.noFocus
      ? shouldActivateBeforeTrustedInput(
          true,
          await enableFocusEmulation(client, logger, "Project Sources target"),
          logger,
        )
      : false;
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const appliedCookies = await applyProjectSourcesCookies({
      config,
      network: Network,
      manualLogin,
      logger,
    });
    await clearStaleChatGptConversationCookies(Network, Target, logger);

    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger));
    await raceWithDisconnect(
      waitForProjectSourcesLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        timeoutMs: config.timeoutMs,
        profileDir: userDataDir,
        keepBrowser: effectiveKeepBrowser,
        // Sign-in needs the user, so a no-focus run brings Chrome forward for it once.
        onLoginRequired:
          config.noFocus && !config.headless
            ? async () => {
                // As in the main sign-in wait, a hidden window has to come back on-screen too.
                if (config.hideWindow && client)
                  await positionChromeWindowOnscreen(client, userDataDir, logger);
                await bringChromeForwardForUser(Page, logger, "sign-in");
              }
            : undefined,
      }),
    );
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, projectUrl, logger));
    if (activateBeforeTrustedInput) {
      await Page.bringToFront().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger(`[browser] Could not bring Project Sources target to front: ${message}`);
      });
    }
    await raceWithDisconnect(openProjectSourcesTab(Runtime, Input, config.inputTimeoutMs, logger));
    await raceWithDisconnect(waitForProjectSourcesReady(Runtime, config.inputTimeoutMs, logger));

    const sourcesBefore = await raceWithDisconnect(
      waitForProjectSourcesListSettled(Runtime, config.inputTimeoutMs, logger),
    );
    let sourcesAfter = sourcesBefore;
    if (operation === "add") {
      sourcesAfter = await raceWithDisconnect(
        uploadProjectSources(
          { runtime: Runtime, dom: DOM, input: Input },
          files,
          logger,
          config.timeoutMs,
        ),
      );
    }
    const added = operation === "add" ? diffAddedProjectSources(sourcesBefore, sourcesAfter) : [];
    completed = true;
    return {
      status: "ok",
      operation,
      projectUrl,
      dryRun: false,
      sourcesBefore,
      sourcesAfter,
      plannedUploads,
      added,
      warnings,
      tookMs: Date.now() - startedAt,
    };
  } finally {
    removeDialogHandler?.();
    removeTerminationHooks?.();
    const chromeHost = chrome?.host ?? "127.0.0.1";
    try {
      await client?.close();
    } catch {
      // ignore close failures
    }
    if (completed && isolatedTargetId && chrome?.port) {
      // A kept Chrome must keep a page, as in the main runner: a no-focus launch has no other one.
      const safeToClose =
        !effectiveKeepBrowser ||
        Boolean(
          await ensureChromePageTargetAfterClose(
            chrome.port,
            isolatedTargetId,
            logger,
            chromeHost,
            { background: config.noFocus },
          ).catch(() => undefined),
        );
      if (safeToClose) {
        await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
      } else {
        logger(
          "[browser] Leaving the Project Sources tab open because Chrome has no replacement page target.",
        );
      }
    }

    let keepBrowserOpen = effectiveKeepBrowser;
    let cleanupProfileLock: ProfileRunLock | null = null;
    let browserTerminationHandledByLease = false;
    let tabLeaseReleaseError: Error | undefined;
    if (!keepBrowserOpen && manualLogin && tabLease) {
      const cleanupLockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
      if (cleanupLockTimeoutMs > 0) {
        cleanupProfileLock = await acquireProfileRunLock(userDataDir, {
          timeoutMs: cleanupLockTimeoutMs,
          logger,
          sessionId: "project-sources",
        }).catch(() => null);
      }
    }
    if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      const chromeHandle = chrome;
      const terminateSharedChrome =
        !keepBrowserOpen && manualLogin && chromeHandle && !connectionClosedUnexpectedly
          ? async () => terminateRecordedChromeForProfile(userDataDir, logger).catch(() => false)
          : undefined;
      const releaseResult = await releaseProjectSourcesBrowserTabLease({
        lease: handle,
        terminateSharedChrome,
        chromePid: chromeHandle?.pid,
        chromePort: chromeHandle?.port,
        logger,
      });
      keepBrowserOpen ||= releaseResult.keepBrowserOpen;
      browserTerminationHandledByLease = releaseResult.terminationHandled;
      tabLeaseReleaseError = releaseResult.releaseError;
    }
    if (!keepBrowserOpen && chrome) {
      if (!connectionClosedUnexpectedly) {
        try {
          if (!browserTerminationHandledByLease) {
            await chrome.kill();
          }
        } catch {
          // ignore kill failures
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          { connectionClosedUnexpectedly, host: chrome.host ?? "127.0.0.1" },
        );
        if (shouldCleanup) {
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else if (chrome) {
      try {
        chrome.process?.unref();
      } catch {
        // best effort
      }
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
    if (cleanupProfileLock) {
      await cleanupProfileLock.release().catch(() => undefined);
    }
    if (tabLeaseReleaseError) {
      // The sources work is done; a slot bookkeeping problem must not fail it.
      logger(
        `[browser] Warning: ChatGPT browser slot release failed after the Project Sources run (${tabLeaseReleaseError.message}); a busy registry lock is retried in the background and a stale slot is reclaimed by a later run.`,
      );
    }
  }
}

async function applyProjectSourcesCookies({
  config,
  network,
  manualLogin,
  logger,
}: {
  config: ResolvedBrowserConfig;
  network: ChromeClient["Network"];
  manualLogin: boolean;
  logger: BrowserLogger;
}): Promise<number> {
  const cookieSyncEnabled = shouldSyncBrowserCookies(config, { manualLogin });
  if (!cookieSyncEnabled) {
    logger(
      manualLogin
        ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
        : "Skipping Chrome cookie copy (disabled by default; use --browser-cookie-sync to opt in).",
    );
    return 0;
  }
  if (!config.inlineCookies) {
    logger(CHROME_COOKIE_SYNC_WARNING);
  }
  const cookieCount = await syncCookies(network, config.url, config.chromeProfile, logger, {
    allowErrors: config.allowCookieErrors ?? false,
    filterNames: config.cookieNames ?? undefined,
    inlineCookies: config.inlineCookies ?? undefined,
    cookiePath: config.chromeCookiePath ?? undefined,
    waitMs: config.cookieSyncWaitMs ?? 0,
  });
  logger(
    cookieCount > 0
      ? config.inlineCookies
        ? `Applied ${cookieCount} inline cookies`
        : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
      : "No Chrome cookies found; continuing without session reuse",
  );
  return cookieCount;
}

async function waitForProjectSourcesLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
  profileDir,
  keepBrowser,
  onLoginRequired,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
  profileDir?: string;
  keepBrowser?: boolean;
  onLoginRequired?: () => Promise<void>;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const waitMs = resolveManualLoginWaitMs(timeoutMs, Boolean(keepBrowser));
  const deadline = Date.now() + waitMs;
  let lastNotice = 0;
  let loginWindowShown = false;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        message.toLowerCase().includes("login button") ||
        message.toLowerCase().includes("session not detected");
      if (!retryable) {
        throw error;
      }
      if (!loginWindowShown) {
        loginWindowShown = true;
        await onLoginRequired?.();
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  const setupCommand = formatManualLoginSetupCommand(profileDir ?? defaultManualLoginProfileDir());
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session. " +
      `Browser mode is using Oracle's private Chrome profile at ${profileDir ?? "(default profile)"}, not your normal Chrome profile. ` +
      `Run first-time setup, sign in there, then retry: ${setupCommand}`,
  );
}

async function acquireManualLoginChromeForProjectSources(
  userDataDir: string,
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  const lockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
  let launchLock: ProfileRunLock | null = null;
  if (lockTimeoutMs > 0) {
    launchLock = await acquireProfileRunLock(userDataDir, {
      timeoutMs: lockTimeoutMs,
      logger,
      sessionId: "project-sources",
    });
  }
  try {
    const reusedChrome = await maybeReuseRunningChrome(userDataDir, logger, {
      waitForPortMs: config.reuseChromeWaitMs,
      chromePath: config.chromePath,
    });
    const chrome =
      reusedChrome ??
      (await launchChrome(
        {
          ...config,
          remoteChrome: null,
        },
        userDataDir,
        logger,
      ));
    if (chrome.port) {
      await writeDevToolsActivePort(userDataDir, chrome.port);
      if (!reusedChrome && chrome.pid) {
        await writeChromePid(userDataDir, chrome.pid);
      }
    }
    return { chrome, reusedChrome };
  } finally {
    await launchLock?.release().catch(() => undefined);
  }
}

export const releaseProjectSourcesBrowserTabLeaseForTest = releaseProjectSourcesBrowserTabLease;
