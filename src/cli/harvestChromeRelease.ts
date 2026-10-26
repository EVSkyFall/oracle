import { sessionStore, type SessionMetadata } from "../sessionStore.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  acquireProfileRunLock,
  terminateRecordedChromeForProfile,
} from "../browser/profileState.js";
import { hasOtherLiveBrowserController } from "../browser/recoveryTarget.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "../browser/tabLeaseRegistry.js";
import type { BrowserLogger } from "../browser/types.js";

/** A browser slot a harvest holds on the session's profile while it reads the session's tab. */
export interface HarvestSlot {
  lease: BrowserTabLease;
  userDataDir: string;
}

// A harvest only reads; a slot that is not free within this long is not waited for. Without one
// the harvest still reads, it just never closes the Chrome afterwards.
const HARVEST_SLOT_WAIT_MS = 10_000;

/** Oracle's own persistent profile for this session's Chrome, or null when it is not Oracle's. */
function oracleProfileOf(meta: SessionMetadata): string | null {
  const config = resolveBrowserConfig(meta.browser?.config);
  if (!config.manualLogin || config.attachRunning || config.remoteChrome) return null;
  return meta.browser?.runtime?.userDataDir ?? config.manualLoginProfileDir ?? null;
}

/**
 * Takes a browser slot on the session's Oracle profile while `--harvest`/`--live` reads its tab,
 * as every run does, taking over the slot of the session's own worker once that worker is
 * proven gone. Null when the profile is not Oracle's or no slot could be had.
 */
export async function takeHarvestSlot(
  meta: SessionMetadata,
  logger: BrowserLogger,
  deps: {
    acquire?: typeof acquireBrowserTabLease;
    leaseDeps?: Parameters<typeof acquireBrowserTabLease>[2];
  } = {},
): Promise<HarvestSlot | null> {
  const userDataDir = oracleProfileOf(meta);
  if (!userDataDir) return null;
  try {
    const lease = await (deps.acquire ?? acquireBrowserTabLease)(
      userDataDir,
      {
        maxConcurrentTabs: resolveBrowserConfig(meta.browser?.config).maxConcurrentTabs,
        timeoutMs: HARVEST_SLOT_WAIT_MS,
        sessionId: meta.id,
        takeOverDeadSessionId: meta.id,
      },
      deps.leaseDeps,
    );
    return { lease, userDataDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[reattach] No browser slot for this harvest (${message}); reading without one.`);
    return null;
  }
}

/**
 * Gives the harvest's slot back. When the harvest saved the session's answer and the session's
 * run is over, its Chrome is released the way that run's own end would have: only Oracle's
 * persistent manual-login profile, only when the session does not keep its browser, only when
 * the session's controller is gone, and only when this was the last slot. As in the run's own
 * cleanup, the last-slot decision and the termination happen together inside the slot
 * registry's lock, under the profile lock, so a run that takes a slot meanwhile either counts
 * (the Chrome stays) or waits until the termination is done. A Chrome the user attached
 * (attach-running, remote Chrome) is never closed.
 */
export async function releaseHarvestSlot(
  slot: HarvestSlot | null,
  sessionId: string,
  mayCloseChrome: boolean,
  logger: BrowserLogger,
  deps: {
    terminate?: typeof terminateRecordedChromeForProfile;
    lockProfile?: typeof acquireProfileRunLock;
  } = {},
): Promise<boolean> {
  if (!slot) return false;
  let closeChrome = false;
  let profileLock: Awaited<ReturnType<typeof acquireProfileRunLock>> = null;
  try {
    const meta = mayCloseChrome ? await sessionStore.readSession(sessionId) : null;
    const config = resolveBrowserConfig(meta?.browser?.config);
    closeChrome = Boolean(
      meta &&
      meta.status === "completed" &&
      oracleProfileOf(meta) === slot.userDataDir &&
      !config.keepBrowser &&
      meta.browser?.runtime?.chromePid &&
      !hasOtherLiveBrowserController(meta),
    );
    if (closeChrome && (config.profileLockTimeoutMs ?? 0) > 0) {
      profileLock = await (deps.lockProfile ?? acquireProfileRunLock)(slot.userDataDir, {
        timeoutMs: config.profileLockTimeoutMs ?? 0,
        logger,
        sessionId,
      }).catch(() => null);
    }
  } catch {
    closeChrome = false;
  }
  let closed = false;
  try {
    await slot.lease.release({
      onRelease: async ({ isLastLease }) => {
        if (!closeChrome) return;
        if (!isLastLease) {
          logger("[reattach] Other runs still use this Chrome; leaving it running.");
          return;
        }
        logger(
          "[reattach] This session's run is over and no other run uses its Chrome; closing it.",
        );
        closed = await (deps.terminate ?? terminateRecordedChromeForProfile)(
          slot.userDataDir,
          logger,
        ).catch(() => false);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[reattach] Could not give the browser slot back (${message}); leaving Chrome running.`);
  } finally {
    await profileLock?.release().catch(() => undefined);
  }
  return closed;
}
