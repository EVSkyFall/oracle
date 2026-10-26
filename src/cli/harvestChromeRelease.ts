import { sessionStore } from "../sessionStore.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { terminateRecordedChromeForProfile } from "../browser/profileState.js";
import { hasOtherLiveBrowserController } from "../browser/recoveryTarget.js";
import { hasOtherBrowserTabUsers } from "../browser/tabLeaseRegistry.js";
import type { BrowserLogger } from "../browser/types.js";

/**
 * After `--harvest`/`--live` saved a session's answer whose worker died, releases the Chrome
 * oracle launched for it the way the run's own end would have: only for oracle's persistent
 * manual-login profile, only when the session does not keep its browser, only when the session's
 * own controller is gone (a live one releases it itself), and only when no other run holds a slot
 * on that profile. A Chrome the user attached (attach-running, remote Chrome) is never closed,
 * and the Chrome is ended only when its recorded process is that profile's (profileState.ts).
 */
export async function releaseHarvestedSessionChrome(
  sessionId: string,
  logger: BrowserLogger,
  deps: {
    terminate?: typeof terminateRecordedChromeForProfile;
    hasOtherUsers?: typeof hasOtherBrowserTabUsers;
  } = {},
): Promise<boolean> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta || meta.status !== "completed") return false;
  const config = resolveBrowserConfig(meta.browser?.config);
  const runtime = meta.browser?.runtime;
  if (!config.manualLogin || config.keepBrowser || config.attachRunning || config.remoteChrome) {
    return false;
  }
  const userDataDir = runtime?.userDataDir ?? config.manualLoginProfileDir ?? undefined;
  if (!userDataDir || !runtime?.chromePid) return false;
  if (hasOtherLiveBrowserController(meta)) return false;
  let otherUsers = true;
  try {
    otherUsers = await (deps.hasOtherUsers ?? hasOtherBrowserTabUsers)(userDataDir, sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[reattach] Could not read the browser slots (${message}); leaving Chrome running.`);
    return false;
  }
  if (otherUsers) {
    logger("[reattach] Other runs still use this Chrome; leaving it running.");
    return false;
  }
  logger("[reattach] This session's run is over and no other run uses its Chrome; closing it.");
  return (deps.terminate ?? terminateRecordedChromeForProfile)(userDataDir, logger);
}
