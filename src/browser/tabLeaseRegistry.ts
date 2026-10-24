import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import type { BrowserLogger } from "./types.js";
import { isProcessAlive, readProcessStartTimeMs } from "./profileState.js";
import { delay } from "./utils.js";
import { normalizeChromeHost } from "./targetClaim.js";

export const DEFAULT_MAX_CONCURRENT_CHATGPT_TABS = 3;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const REGISTRY_LOCK_DIRNAME = "oracle-tab-leases.lock";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_STALE_MS = 2 * 60 * 1000;
const LEASE_HEARTBEAT_INTERVAL_MS = 15_000;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const REGISTRY_LOCK_OWNER_FILENAME = "owner.json";
const REGISTRY_RECOVERY_POLL_MS = 50;
const LEGACY_OWNERLESS_LOCK_STALE_MS = 5 * 60 * 1000;
// A live owner publishes owner.json within milliseconds of mkdir, so a lock directory that
// stays completely empty is left over from a crash or a failed unlock.
const EMPTY_OWNERLESS_LOCK_STALE_MS = 5_000;
const PROCESS_START_TIME_TOLERANCE_MS = 10_000;
const REGISTRY_RENAME_RETRY_ATTEMPTS = 6;
// Windows keeps a deleted owner.json "delete pending" while a waiter still has it open, so the
// directory removal fails with ENOTEMPTY until that handle closes.
export const REGISTRY_LOCK_REMOVE_ATTEMPTS = 12;
const REGISTRY_LOCK_REMOVE_MAX_DELAY_MS = 500;
// The owner identity probe spawns a process on Windows; a live owner normally holds the lock
// for milliseconds, so waiters only pay for the probe once a wait gets long.
const LOCK_OWNER_PROBE_AFTER_MS = 2_000;
const LOCK_OWNER_PROBE_TTL_MS = 2_000;
const BACKGROUND_RETRY_MAX_DELAY_MS = 30_000;

class RegistryLockTimeoutError extends Error {
  readonly code = "ORACLE_TAB_LEASE_LOCK_TIMEOUT";
}

const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
// Hard links are missing on some filesystems (FAT, some network shares).
const HARD_LINK_UNSUPPORTED_CODES = new Set([
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
  "EINVAL",
  "EPERM",
  "EISDIR",
  "EMLINK",
]);

function isTransientLockError(error: unknown): boolean {
  if (error instanceof RegistryLockTimeoutError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_FS_CODES.has(code);
}

// Unref'd so background cleanup never keeps a finished CLI process alive.
const backgroundDelay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export interface BrowserTabLeaseRecord {
  id: string;
  pid: number;
  processStartedAtMs?: number;
  sessionId?: string;
  chromeHost?: string;
  chromePort?: number;
  chromeTargetId?: string;
  tabUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserTabLease {
  id: string;
  release: (options?: {
    onRelease?: (context: BrowserTabLeaseReleaseContext) => Promise<void>;
  }) => Promise<void>;
  update: (patch: Partial<BrowserTabLeaseRecord>) => Promise<void>;
}

export interface BrowserTabLeaseReleaseContext {
  isLastLease: boolean;
  releasedLease: BrowserTabLeaseRecord;
  remainingLeases: readonly BrowserTabLeaseRecord[];
}

interface BrowserTabLeaseRegistryFile {
  version: 1;
  leases: BrowserTabLeaseRecord[];
}

interface BrowserTabLeaseDeps {
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>;
  heartbeatMs?: number;
}

interface RegistryLockOwner {
  id: string;
  pid: number;
  createdAt?: string;
  processStartedAtMs?: number;
}

interface RegistryLockIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
}

type RegistryOwnerReadFile = (filePath: string, encoding: "utf8") => Promise<string>;
type RegistryFileRemove = (file: string) => Promise<void>;
type RegistryDirectoryRemove = (directory: string) => Promise<void>;

export function normalizeMaxConcurrentTabs(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_CONCURRENT_CHATGPT_TABS;
  }
  const numeric = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_CONCURRENT_CHATGPT_TABS;
  }
  return Math.max(1, Math.trunc(numeric));
}

export async function acquireBrowserTabLease(
  profileDir: string,
  options: {
    maxConcurrentTabs?: number;
    timeoutMs?: number;
    pollMs?: number;
    logger?: BrowserLogger;
    sessionId?: string;
    chromeHost?: string;
    chromePort?: number;
    staleMs?: number;
    signal?: AbortSignal;
  },
  deps: BrowserTabLeaseDeps = {},
): Promise<BrowserTabLease> {
  const maxConcurrentTabs = normalizeMaxConcurrentTabs(options.maxConcurrentTabs);
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const processStartedAtMs = await (deps.readProcessStartTimeMs ?? readProcessStartTimeMs)(pid);
  const leaseId = randomUUID();
  const startedAt = now();
  let warned = false;
  let lastHeartbeatAt = 0;
  let lockWaitLoggedAt = 0;
  const liveness = {
    isProcessAlive: deps.isProcessAlive ?? isProcessAlive,
    readProcessStartTimeMs: deps.readProcessStartTimeMs ?? readProcessStartTimeMs,
  };

  for (;;) {
    options.signal?.throwIfAborted();
    // Identity probes are slow on Windows; run them before taking the lock so it stays short.
    const probes = await probeStaleLeases(profileDir, { nowMs: now(), staleMs, ...liveness });
    let acquired: BrowserTabLeaseRecord | null;
    try {
      acquired = await withRegistryLock(
        profileDir,
        async () => {
          options.signal?.throwIfAborted();
          const registry = await readRegistry(profileDir);
          const active = pruneStaleLeases(registry.leases, { nowMs: now(), staleMs, probes });
          if (active.length >= maxConcurrentTabs) {
            if (active.length !== registry.leases.length) {
              await writeRegistry(profileDir, { version: 1, leases: active });
            }
            return null;
          }
          const timestamp = new Date(now()).toISOString();
          const lease: BrowserTabLeaseRecord = {
            id: leaseId,
            pid,
            ...(processStartedAtMs === null ? {} : { processStartedAtMs }),
            sessionId: options.sessionId,
            chromeHost: options.chromeHost,
            chromePort: options.chromePort,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await writeRegistry(profileDir, { version: 1, leases: [...active, lease] });
          return lease;
        },
        options.signal,
      );
    } catch (error) {
      if (!(error instanceof RegistryLockTimeoutError)) throw error;
      // Another controller is holding the registry lock for a while (for example while it
      // closes Chrome); keep waiting for a slot within this run's own time budget.
      if (now() - lockWaitLoggedAt >= 30_000) {
        options.logger?.(`[browser] ChatGPT browser slot registry is busy; still waiting.`);
        lockWaitLoggedAt = now();
      }
      acquired = null;
    }

    if (acquired) {
      options.logger?.(
        `[browser] Acquired ChatGPT browser slot ${leaseId.slice(0, 8)} (${maxConcurrentTabs} max).`,
      );
      let released = false;
      let heartbeatInFlight = false;
      let heartbeatPromise: Promise<void> | null = null;
      let heartbeatWarningEmitted = false;
      const heartbeat = setInterval(
        () => {
          if (released || heartbeatInFlight) return;
          heartbeatInFlight = true;
          const heartbeatWork = updateBrowserTabLease(profileDir, leaseId, {})
            .then(() => {
              heartbeatWarningEmitted = false;
            })
            .catch((error) => {
              if (!heartbeatWarningEmitted) {
                const message = error instanceof Error ? error.message : String(error);
                options.logger?.(
                  `[browser] ChatGPT browser slot heartbeat failed; preserving the slot until stale grace expires: ${message}`,
                );
                heartbeatWarningEmitted = true;
              }
            })
            .finally(() => {
              heartbeatInFlight = false;
              if (heartbeatPromise === heartbeatWork) heartbeatPromise = null;
            });
          heartbeatPromise = heartbeatWork;
        },
        Math.max(10, deps.heartbeatMs ?? LEASE_HEARTBEAT_INTERVAL_MS),
      );
      heartbeat.unref();
      return {
        id: leaseId,
        release: async (releaseOptions) => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await heartbeatPromise?.catch(() => undefined);
          try {
            await releaseBrowserTabLease(profileDir, leaseId, options.logger, releaseOptions);
          } catch (error) {
            // A long-lived controller (MCP) would otherwise hold this slot until it exits.
            if (isTransientLockError(error)) {
              scheduleBackgroundLeaseRelease(profileDir, leaseId, options.logger);
            }
            throw error;
          }
        },
        update: async (patch) => {
          if (released) return;
          await updateBrowserTabLease(profileDir, leaseId, patch);
        },
      };
    }

    const elapsed = now() - startedAt;
    if (!warned || now() - lastHeartbeatAt >= 30_000) {
      options.logger?.(
        `[browser] Waiting for ChatGPT browser slot (${maxConcurrentTabs} max, ${Math.round(elapsed / 1000)}s elapsed).`,
      );
      warned = true;
      lastHeartbeatAt = now();
    }
    if (timeoutMs > 0 && elapsed >= timeoutMs) {
      throw new Error(
        `Timed out waiting for ChatGPT browser slot after ${Math.round(elapsed / 1000)}s (${maxConcurrentTabs} max).`,
      );
    }
    await delay(timeoutMs > 0 ? Math.min(pollMs, timeoutMs - elapsed) : pollMs, options.signal);
  }
}

export async function updateBrowserTabLease(
  profileDir: string,
  leaseId: string,
  patch: Partial<BrowserTabLeaseRecord>,
): Promise<void> {
  await withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    if (!registry.leases.some((lease) => lease.id === leaseId)) {
      throw new Error(
        `Oracle ChatGPT browser slot ${leaseId.slice(0, 8)} is no longer owned by this controller.`,
      );
    }
    const leases = registry.leases.map((lease) =>
      lease.id === leaseId
        ? { ...lease, ...patch, id: lease.id, updatedAt: new Date().toISOString() }
        : lease,
    );
    await writeRegistry(profileDir, { version: 1, leases });
  });
}

export async function releaseBrowserTabLease(
  profileDir: string,
  leaseId: string,
  logger?: BrowserLogger,
  options: { onRelease?: (context: BrowserTabLeaseReleaseContext) => Promise<void> } = {},
): Promise<void> {
  await withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    // Release is a safety-critical reference-count decrement. Never prune other
    // controllers here: a transient cross-process liveness false-negative would
    // make this run look like the final lease and allow it to terminate shared
    // Chrome underneath live tabs. Stale records are reclaimed by a later acquire.
    const releasedLease = registry.leases.find((lease) => lease.id === leaseId);
    if (!releasedLease) {
      throw new Error(
        `Oracle ChatGPT browser slot ${leaseId.slice(0, 8)} was already lost; refusing final shared-Chrome cleanup.`,
      );
    }
    const leases = registry.leases.filter((lease) => lease.id !== leaseId);
    await writeRegistry(profileDir, { version: 1, leases });
    logger?.(
      `[browser] ChatGPT browser slot ${leaseId.slice(0, 8)} release decision: ` +
        `isLastLease=${leases.length === 0}; remaining=${leases.length}; ` +
        `remainingSessions=${formatRemainingLeaseSessions(leases)}.`,
    );
    await options.onRelease?.({
      isLastLease: leases.length === 0,
      releasedLease,
      remainingLeases: leases,
    });
  });
  logger?.(`[browser] Released ChatGPT browser slot ${leaseId.slice(0, 8)}.`);
}

/**
 * Retries removing a lease record whose release hit a transient lock failure. It never runs
 * the release callback, so it cannot make a shared-Chrome termination decision late.
 */
function scheduleBackgroundLeaseRelease(
  profileDir: string,
  leaseId: string,
  logger?: BrowserLogger,
): void {
  void (async () => {
    // Retries while the registry lock is only busy; a slot left behind would keep a long-lived
    // controller (MCP) holding it. It stops on success or a non-transient failure.
    let wait = 1_000;
    for (;;) {
      await backgroundDelay(wait);
      try {
        await releaseBrowserTabLease(profileDir, leaseId);
        logger?.(
          `[browser] Released ChatGPT browser slot ${leaseId.slice(0, 8)} after a retried registry unlock.`,
        );
        return;
      } catch (error) {
        if (!isTransientLockError(error)) return;
      }
      wait = Math.min(BACKGROUND_RETRY_MAX_DELAY_MS, wait * 2);
    }
  })();
}

function formatRemainingLeaseSessions(leases: readonly BrowserTabLeaseRecord[]): string {
  if (leases.length === 0) return "none";
  return leases
    .map(
      (lease) =>
        `${lease.id.slice(0, 8)}:${lease.sessionId ?? "unknown"}:pid${lease.pid}:target${lease.chromeTargetId ?? "pending"}`,
    )
    .join(",");
}

export async function hasOtherActiveBrowserTabLeases(
  profileDir: string,
  leaseId: string,
  options: {
    staleMs?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
    readProcessStartTimeMs?: (pid: number) => Promise<number | null>;
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  const probes = await probeStaleLeases(profileDir, {
    nowMs: now(),
    staleMs,
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    readProcessStartTimeMs: options.readProcessStartTimeMs ?? readProcessStartTimeMs,
  });
  return withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    const active = pruneStaleLeases(registry.leases, { nowMs: now(), staleMs, probes });
    if (active.length !== registry.leases.length) {
      await writeRegistry(profileDir, { version: 1, leases: active });
    }
    return active.some((lease) => lease.id !== leaseId);
  });
}

export async function hasActiveBrowserTargetLease(
  profileDir: string,
  target: { host: string; port: number; targetId: string },
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path.join(profileDir, REGISTRY_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const registry = JSON.parse(raw) as BrowserTabLeaseRegistryFile;
  if (registry.version !== 1 || !Array.isArray(registry.leases))
    throw new Error("Unknown browser lease registry");
  return registry.leases.some(
    (lease) =>
      lease.chromeTargetId === target.targetId &&
      (!lease.chromeHost ||
        normalizeChromeHost(lease.chromeHost) === normalizeChromeHost(target.host)) &&
      (!lease.chromePort || lease.chromePort === target.port) &&
      isProcessAlive(lease.pid),
  );
}

async function withRegistryLock<T>(
  profileDir: string,
  callback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lockDir = path.join(profileDir, REGISTRY_LOCK_DIRNAME);
  const lockId = randomUUID();
  const processStartedAtMs = await readProcessStartTimeMs(process.pid);
  const startedAt = Date.now();
  const ownerProbes = new Map<string, { alive: boolean; at: number }>();
  let acquiredIdentity: RegistryLockIdentity | null = null;
  for (;;) {
    signal?.throwIfAborted();
    try {
      // mkdir is exclusive on every platform; rename can replace a live empty
      // directory on POSIX (including locks held by older Oracle controllers).
      await mkdir(lockDir, { recursive: false });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw error;
      }
      const owner = await readRegistryLockOwner(lockDir);
      if (owner && !(await isWaitedLockOwnerAlive(owner, startedAt, ownerProbes))) {
        await recoverDeadRegistryLock(profileDir, lockDir, owner);
        continue;
      }
      if (!owner && (await isRegistryOwnerFileMissing(lockDir))) {
        const identity = await readRegistryLockIdentity(lockDir);
        const staleMs = (await isRegistryLockDirectoryEmpty(lockDir))
          ? EMPTY_OWNERLESS_LOCK_STALE_MS
          : LEGACY_OWNERLESS_LOCK_STALE_MS;
        if (identity && Date.now() - identity.mtimeMs >= staleMs) {
          await recoverOwnerlessRegistryLock(profileDir, lockDir, identity, staleMs);
          continue;
        }
      }
      if (Date.now() - startedAt > REGISTRY_LOCK_TIMEOUT_MS) {
        throw new RegistryLockTimeoutError(
          `Timed out waiting for Oracle tab lease registry lock ${lockDir}; preserving the existing lock to avoid split-brain cleanup.`,
        );
      }
      await delay(50, signal);
      continue;
    }
    acquiredIdentity = await readRegistryLockIdentity(lockDir);
    const temporaryOwner = path.join(lockDir, `${lockId}.tmp`);
    try {
      // Publish only complete ownership evidence. A crash before rename leaves
      // an ownerless lock, which the aged-lock recovery path can safely reclaim.
      await writeFile(
        temporaryOwner,
        `${JSON.stringify({
          id: lockId,
          pid: process.pid,
          createdAt: new Date().toISOString(),
          ...(processStartedAtMs === null ? {} : { processStartedAtMs }),
        })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      // If this controller stalled after mkdir long enough for the empty directory to be
      // reclaimed and re-created, the directory now belongs to someone else.
      if (
        !acquiredIdentity ||
        !sameRegistryLockDirectory(await readRegistryLockIdentity(lockDir), acquiredIdentity) ||
        !(await isRegistryOwnerFileMissing(lockDir))
      ) {
        await rm(temporaryOwner, { force: true }).catch(() => undefined);
        continue;
      }
      if (
        !(await publishRegistryLockOwner(
          temporaryOwner,
          path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME),
        ))
      ) {
        // Another controller published first (it reclaimed and re-created this directory
        // while we stalled); this lock is theirs.
        continue;
      }
    } catch (error) {
      await rm(temporaryOwner, { force: true }).catch(() => undefined);
      await removeRegistryLockIfOwned(lockDir, lockId).catch(() => undefined);
      if (
        acquiredIdentity &&
        sameRegistryLockDirectory(await readRegistryLockIdentity(lockDir), acquiredIdentity)
      ) {
        // Only an unchanged empty directory can be removed without an owner.
        await rmdir(lockDir).catch(() => undefined);
      }
      throw error;
    }
    break;
  }
  try {
    return await callback();
  } finally {
    await unlockRegistry(lockDir, lockId, acquiredIdentity);
  }
}

/**
 * Releases the registry lock. Ownership problems still throw; a directory that only failed
 * to disappear (Windows delete-pending files) is ours and is removed in the background, so a
 * finished operation is not reported as failed.
 */
async function unlockRegistry(
  lockDir: string,
  lockId: string,
  ownedIdentity: RegistryLockIdentity | null,
): Promise<void> {
  try {
    await removeRegistryLockIfOwned(lockDir, lockId, { requireOwned: true, ownedIdentity });
  } catch (error) {
    if (!isTransientLockError(error)) throw error;
    scheduleBackgroundLockRemoval(lockDir, lockId, ownedIdentity);
  }
}

function scheduleBackgroundLockRemoval(
  lockDir: string,
  lockId: string,
  ownedIdentity: RegistryLockIdentity | null,
): void {
  void (async () => {
    // Keeps trying while the failure is transient: a lock left behind would make every later
    // run wait for it. It stops once the directory is gone, is someone else's, or fails hard.
    let wait = 250;
    for (;;) {
      await backgroundDelay(wait);
      try {
        const identity = await readRegistryLockIdentity(lockDir);
        if (!identity) return;
        if (ownedIdentity && !sameRegistryLockDirectory(identity, ownedIdentity)) return;
        const owner = await readRegistryLockOwner(lockDir);
        if (owner && owner.id !== lockId) return;
        if (!owner && !ownedIdentity) return;
        await removeOwnedRegistryLockDirectory(lockDir, lockId, { ownedIdentity, attempts: 1 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        if (!isTransientLockError(error)) return;
      }
      wait = Math.min(BACKGROUND_RETRY_MAX_DELAY_MS, wait * 2);
    }
  })();
}

/**
 * Liveness of the controller holding the lock we wait for. The cheap PID check answers while a
 * wait is short; after that the identity probe (which catches a reused PID) runs, cached
 * briefly so a long wait does not spawn a probe per poll.
 */
async function isWaitedLockOwnerAlive(
  owner: RegistryLockOwner,
  waitStartedAt: number,
  cache: Map<string, { alive: boolean; at: number }>,
): Promise<boolean> {
  if (Date.now() - waitStartedAt < LOCK_OWNER_PROBE_AFTER_MS && isProcessAlive(owner.pid)) {
    return true;
  }
  const key = `${owner.id}|${owner.pid}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < LOCK_OWNER_PROBE_TTL_MS) return cached.alive;
  const alive = await isRegistryLockOwnerAlive(owner);
  cache.set(key, { alive, at: Date.now() });
  return alive;
}

async function isRegistryLockDirectoryEmpty(lockDir: string): Promise<boolean> {
  try {
    return (await readdir(lockDir)).length === 0;
  } catch {
    return false;
  }
}

async function readRegistryLockOwner(
  lockDir: string,
  readFileImpl: RegistryOwnerReadFile = readFile,
): Promise<RegistryLockOwner | null> {
  try {
    const raw = await readFileImpl(path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as {
      id?: unknown;
      pid?: unknown;
      createdAt?: unknown;
      processStartedAtMs?: unknown;
    };
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      (parsed.processStartedAtMs !== undefined &&
        (typeof parsed.processStartedAtMs !== "number" ||
          !Number.isFinite(parsed.processStartedAtMs)))
    ) {
      return null;
    }
    return {
      id: parsed.id,
      pid: parsed.pid,
      ...(typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}),
      ...(typeof parsed.processStartedAtMs === "number"
        ? { processStartedAtMs: parsed.processStartedAtMs }
        : {}),
    };
  } catch {
    return null;
  }
}

async function isRegistryLockOwnerAlive(
  owner: RegistryLockOwner,
  deps = { isProcessAlive, readProcessStartTimeMs },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const alive = deps.isProcessAlive(owner.pid);
    const actualStartedAtMs = await deps.readProcessStartTimeMs(owner.pid);
    // A positive independent identity probe outranks a transient native PID miss.
    if (actualStartedAtMs !== null) {
      if (owner.processStartedAtMs !== undefined) {
        return (
          Math.abs(actualStartedAtMs - owner.processStartedAtMs) <= PROCESS_START_TIME_TOLERANCE_MS
        );
      }
      const createdAt = owner.createdAt ? Date.parse(owner.createdAt) : Number.NaN;
      return (
        !Number.isFinite(createdAt) ||
        actualStartedAtMs <= createdAt + PROCESS_START_TIME_TOLERANCE_MS
      );
    }
    if (alive) return true;
    if (attempt === 0) await delay(REGISTRY_RECOVERY_POLL_MS);
  }
  return false;
}

async function isRegistryOwnerFileMissing(lockDir: string): Promise<boolean> {
  try {
    await lstat(path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function readRegistryLockIdentity(lockDir: string): Promise<RegistryLockIdentity | null> {
  try {
    const value = await stat(lockDir);
    return {
      dev: value.dev,
      ino: value.ino,
      birthtimeMs: value.birthtimeMs,
      mtimeMs: value.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sameRegistryLockIdentity(
  left: RegistryLockIdentity | null,
  right: RegistryLockIdentity,
): boolean {
  return sameRegistryLockDirectory(left, right) && left?.mtimeMs === right.mtimeMs;
}

function sameRegistryLockDirectory(
  left: RegistryLockIdentity | null,
  right: RegistryLockIdentity,
): boolean {
  return (
    left !== null &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function removeRegistryLockIfOwned(
  lockDir: string,
  lockId: string,
  options: {
    requireOwned?: boolean;
    readFileImpl?: RegistryOwnerReadFile;
    unlinkImpl?: RegistryFileRemove;
    rmdirImpl?: RegistryDirectoryRemove;
    /** Directory identity seen right after this owner's mkdir. */
    ownedIdentity?: RegistryLockIdentity | null;
  } = {},
): Promise<boolean> {
  const owner = await readRegistryLockOwnerWithRetry(lockDir, options.readFileImpl);
  const lockIdentity = owner ? null : await readRegistryLockIdentity(lockDir);
  if (!owner) {
    if (lockIdentity && options.requireOwned) {
      throw new Error(
        `Unable to verify ownership while releasing Oracle tab lease registry lock ${lockDir}.`,
      );
    }
    return false;
  }
  if (owner?.id !== lockId) {
    if (options.requireOwned) {
      throw new Error(
        `Oracle tab lease registry lock ${lockDir} changed owners before release; preserving it.`,
      );
    }
    return false;
  }
  await removeOwnedRegistryLockDirectory(lockDir, lockId, options);
  return true;
}

async function readRegistryLockOwnerWithRetry(
  lockDir: string,
  readFileImpl: RegistryOwnerReadFile = readFile,
): Promise<RegistryLockOwner | null> {
  for (let attempt = 0; ; attempt += 1) {
    const owner = await readRegistryLockOwner(lockDir, readFileImpl);
    if (owner) return owner;
    const identity = await readRegistryLockIdentity(lockDir);
    if (!identity || attempt + 1 >= REGISTRY_RENAME_RETRY_ATTEMPTS) return null;
    await delay(25 * (attempt + 1));
  }
}

/**
 * Removes a lock that belongs to `lockId`: its owner record, re-read each time and deleted only
 * while it still names that owner, then the directory with a non-recursive rmdir. Another
 * controller's owner record or any file this lock did not create is never deleted; a directory
 * that is not empty yet (Windows keeps a deleted file "delete pending" while another handle has
 * it open) is retried.
 */
async function removeOwnedRegistryLockDirectory(
  lockDir: string,
  lockId: string,
  options: {
    readFileImpl?: RegistryOwnerReadFile;
    unlinkImpl?: RegistryFileRemove;
    rmdirImpl?: RegistryDirectoryRemove;
    ownedIdentity?: RegistryLockIdentity | null;
    attempts?: number;
  } = {},
): Promise<void> {
  const unlinkImpl = options.unlinkImpl ?? ((file: string) => rm(file, { force: true }));
  const rmdirImpl = options.rmdirImpl ?? rmdir;
  const attempts = Math.max(1, options.attempts ?? REGISTRY_LOCK_REMOVE_ATTEMPTS);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const owner = await readRegistryLockOwner(lockDir, options.readFileImpl);
      if (owner && owner.id !== lockId) return;
      if (owner) await unlinkImpl(path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME));
      await rmdirImpl(lockDir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      const transient = typeof code === "string" && TRANSIENT_FS_CODES.has(code);
      if (!transient || attempt + 1 >= attempts) throw error;
      await delay(Math.min(REGISTRY_LOCK_REMOVE_MAX_DELAY_MS, 50 * 2 ** attempt));
      if (options.ownedIdentity) {
        // Once our directory is gone or replaced, nothing of ours is left to remove.
        const current = await readRegistryLockIdentity(lockDir);
        if (!current || !sameRegistryLockDirectory(current, options.ownedIdentity)) return;
      }
    }
  }
}

export async function removeRegistryLockIfOwnedForTest(
  lockDir: string,
  lockId: string,
  options: {
    readFileImpl?: RegistryOwnerReadFile;
    unlinkImpl?: RegistryFileRemove;
    rmdirImpl?: RegistryDirectoryRemove;
  } = {},
): Promise<boolean> {
  return removeRegistryLockIfOwned(lockDir, lockId, { ...options, requireOwned: true });
}

async function recoverDeadRegistryLock(
  profileDir: string,
  lockDir: string,
  observedOwner: RegistryLockOwner,
): Promise<void> {
  await withRegistryRecoveryLock(profileDir, async () => {
    // Re-read after acquiring the crash-safe recovery mutex. Another process may
    // already have reaped the dead lock and installed a live owner.
    const currentOwner = await readRegistryLockOwner(lockDir);
    if (
      currentOwner?.id !== observedOwner.id ||
      currentOwner.pid !== observedOwner.pid ||
      currentOwner.createdAt !== observedOwner.createdAt ||
      currentOwner.processStartedAtMs !== observedOwner.processStartedAtMs ||
      (await isRegistryLockOwnerAlive(currentOwner))
    ) {
      return;
    }
    await removeRegistryLockIfOwned(lockDir, currentOwner.id);
  });
}

async function recoverOwnerlessRegistryLock(
  profileDir: string,
  lockDir: string,
  observedIdentity: RegistryLockIdentity,
  staleMs: number,
): Promise<void> {
  await withRegistryRecoveryLock(profileDir, async () => {
    if ((await readRegistryLockOwner(lockDir)) || !(await isRegistryOwnerFileMissing(lockDir)))
      return;
    const currentIdentity = await readRegistryLockIdentity(lockDir);
    if (
      !sameRegistryLockIdentity(currentIdentity, observedIdentity) ||
      Date.now() - observedIdentity.mtimeMs < staleMs
    ) {
      return;
    }
    if (staleMs >= LEGACY_OWNERLESS_LOCK_STALE_MS) {
      // A crash before the owner was published leaves only a temporary owner file. Remove
      // just those, never files this registry did not create.
      const entries = await readdir(lockDir).catch(() => [] as string[]);
      for (const entry of entries) {
        if (entry.endsWith(".tmp")) await rm(path.join(lockDir, entry), { force: true });
      }
    }
    // rmdir fails (and the lock is left alone) if anything else is in it or appeared since.
    await rmdir(lockDir).catch(() => undefined);
  });
}

/**
 * Publishes the owner record without ever replacing one: a hard link fails with EEXIST when
 * another controller already published into this directory. Returns false in that case.
 * Filesystems without hard links fall back to the rename after the missing-owner check.
 */
async function publishRegistryLockOwner(temporary: string, owner: string): Promise<boolean> {
  try {
    await link(temporary, owner);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await rm(temporary, { force: true }).catch(() => undefined);
      return false;
    }
    if (typeof code !== "string" || !HARD_LINK_UNSUPPORTED_CODES.has(code)) throw error;
    await renameRegistryFileWithRetry(temporary, owner);
    return true;
  }
  await rm(temporary, { force: true }).catch(() => undefined);
  return true;
}

async function withRegistryRecoveryLock<T>(
  profileDir: string,
  callback: () => Promise<T>,
): Promise<T> {
  const identity = await canonicalProfileIdentity(profileDir);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const windowsEndpoint = `\\\\.\\pipe\\oracle-tab-lease-recovery-${digest}`;
  const posixPort = 20_000 + (Number.parseInt(digest.slice(0, 8), 16) % 40_000);
  const endpoint = process.platform === "win32" ? windowsEndpoint : `127.0.0.1:${posixPort}`;
  const startedAt = Date.now();
  let server: net.Server | null = null;

  for (;;) {
    const candidate = net.createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once("error", reject);
        const listenOptions =
          process.platform === "win32"
            ? windowsEndpoint
            : { host: "127.0.0.1", port: posixPort, exclusive: true };
        candidate.listen(listenOptions, () => {
          candidate.removeListener("error", reject);
          resolve();
        });
      });
      server = candidate;
      break;
    } catch (error) {
      candidate.close();
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
      if (Date.now() - startedAt > REGISTRY_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Oracle tab lease recovery mutex ${endpoint}.`);
      }
      await delay(REGISTRY_RECOVERY_POLL_MS);
    }
  }

  try {
    return await callback();
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  }
}

async function canonicalProfileIdentity(profileDir: string): Promise<string> {
  let resolved = path.resolve(profileDir);
  try {
    resolved = await realpath(resolved);
  } catch {
    // The profile normally exists before lease acquisition. Keep an absolute,
    // normalized fallback so an introspection failure remains fail-closed.
  }
  resolved = path.normalize(resolved);
  if (process.platform === "win32") {
    if (/^\\\\\?\\UNC\\/iu.test(resolved)) {
      resolved = `\\\\${resolved.slice(8)}`;
    } else {
      resolved = resolved.replace(/^\\\\\?\\/u, "");
    }
    resolved = resolved.toLowerCase();
  }
  const root = path.parse(resolved).root;
  while (resolved.length > root.length && /[\\/]$/u.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

export async function canonicalProfileIdentityForTest(profileDir: string): Promise<string> {
  return canonicalProfileIdentity(profileDir);
}

async function readRegistry(profileDir: string): Promise<BrowserTabLeaseRegistryFile> {
  try {
    const raw = await readFile(registryPath(profileDir), "utf8");
    const parsed = JSON.parse(raw) as BrowserTabLeaseRegistryFile;
    if (!Array.isArray(parsed.leases)) {
      throw new Error("Oracle tab lease registry is missing its leases array.");
    }
    if (!parsed.leases.every(isLeaseRecord)) {
      throw new Error("Oracle tab lease registry contains an invalid lease record.");
    }
    return {
      version: 1,
      leases: parsed.leases,
    };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { version: 1, leases: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Oracle tab lease registry: ${message}`, { cause: error });
  }
}

async function writeRegistry(
  profileDir: string,
  registry: BrowserTabLeaseRegistryFile,
): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const destination = registryPath(profileDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await renameRegistryFileWithRetry(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function renameRegistryFileWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt + 1 >= REGISTRY_RENAME_RETRY_ATTEMPTS) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

function registryPath(profileDir: string): string {
  return path.join(profileDir, REGISTRY_FILENAME);
}

const staleLeaseProbeKey = (lease: BrowserTabLeaseRecord) =>
  `${lease.id}|${lease.pid}|${lease.processStartedAtMs ?? ""}|${lease.updatedAt}`;

function isLeaseStale(lease: BrowserTabLeaseRecord, nowMs: number, staleMs: number): boolean {
  const updatedAt = Date.parse(lease.updatedAt);
  // One cross-process liveness probe is not trustworthy enough to delete a
  // fresh foreign lease. Active controllers refresh updatedAt every 15s; only
  // a missed heartbeat beyond the grace period permits identity verification.
  // Invalid timestamps fail closed.
  return Number.isFinite(updatedAt) && nowMs - updatedAt > staleMs;
}

/**
 * Probes the identity of leases that missed their heartbeat, outside the registry lock.
 * A read failure probes nothing: the locked read reports a corrupt registry itself.
 */
async function probeStaleLeases(
  profileDir: string,
  options: {
    nowMs: number;
    staleMs: number;
    isProcessAlive: (pid: number) => boolean;
    readProcessStartTimeMs: (pid: number) => Promise<number | null>;
  },
): Promise<Map<string, boolean>> {
  const probes = new Map<string, boolean>();
  const registry = await readRegistry(profileDir).catch(() => null);
  for (const lease of registry?.leases ?? []) {
    if (!isLeaseStale(lease, options.nowMs, options.staleMs)) continue;
    probes.set(staleLeaseProbeKey(lease), await isRegistryLockOwnerAlive(lease, options));
  }
  return probes;
}

/** Drops stale leases proven dead by `probes`; a stale lease that was not probed stays. */
function pruneStaleLeases(
  leases: BrowserTabLeaseRecord[],
  options: { nowMs: number; staleMs: number; probes: Map<string, boolean> },
): BrowserTabLeaseRecord[] {
  return leases.filter(
    (lease) =>
      !isLeaseStale(lease, options.nowMs, options.staleMs) ||
      options.probes.get(staleLeaseProbeKey(lease)) !== false,
  );
}

function isLeaseRecord(value: unknown): value is BrowserTabLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as BrowserTabLeaseRecord;
  return (
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    (record.processStartedAtMs === undefined ||
      (typeof record.processStartedAtMs === "number" &&
        Number.isFinite(record.processStartedAtMs))) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
