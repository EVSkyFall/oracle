import { enableFocusEmulation } from "./focusEmulation.js";
import type { RunClient } from "./runClient.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

/** What a run hands the resync once a new tab has taken over its wait. */
export interface ReplacementTab {
  targetId?: string;
  /** Runs once the new tab shows the conversation (e.g. the run's tab claim). */
  ready?: () => Promise<unknown>;
}

/** A tab opened on the conversation, not yet carrying the run. */
export interface OpenedTab {
  client: ChromeClient;
  targetId?: string;
  /** Closes the tab and its connection when it does not take the run over. */
  discard: () => Promise<unknown>;
}

// Each domain of a new tab normally enables in milliseconds; a tab that does not within this
// long is used as it is (a domain that is not enabled fails on use, as on any tab).
const PREPARE_STEP_MS = 10_000;
// Closing what a frozen tab leaves: the browser answers these, not the frozen renderer.
const RETIRE_STEP_MS = 10_000;

const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

/**
 * Readies a new tab to carry the run: the domains the run reads and focus emulation, each
 * best effort and bounded.
 */
export async function prepareReplacementTab(
  client: ChromeClient,
  logger: BrowserLogger,
): Promise<void> {
  const domains = client as unknown as Record<
    string,
    { enable?: (params?: object) => Promise<unknown> } | undefined
  >;
  await Promise.all(
    ["Network", "Page", "Runtime", "DOM"].map((name) =>
      within(
        Promise.resolve()
          .then(() => domains[name]?.enable?.(name === "Network" ? {} : undefined))
          .catch(() => undefined),
        PREPARE_STEP_MS,
      ),
    ),
  );
  await within(
    enableFocusEmulation(client, logger, "the new tab").catch(() => false),
    PREPARE_STEP_MS,
  );
}

/**
 * Closes what a frozen tab leaves behind, in the background: each step gets `boundMs` and a
 * failure is only logged. The run never waits on it.
 */
export function retireFrozenTab(
  logger: BrowserLogger,
  steps: Array<() => Promise<unknown>>,
  boundMs = RETIRE_STEP_MS,
): void {
  void (async () => {
    for (const step of steps) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(step),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${boundMs} ms`)), boundMs);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        logger(
          `[browser] The frozen tab could not be closed (${error instanceof Error ? error.message : String(error)}); it is left as it is.`,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  })();
}

/**
 * Moves a run whose tab stopped answering to a new tab on the conversation: opens it, readies
 * it, swaps the run's client to it (so the wait, the approval monitor and the resync act on it)
 * and retires the frozen tab in the background. Never types and never submits anything.
 */
export async function moveRunToNewTab<T extends OpenedTab>(options: {
  runClient: RunClient;
  logger: BrowserLogger;
  open: () => Promise<T>;
  givenUp: () => boolean;
  /** What to close of the frozen tab, given its retired client (read before `moved`). */
  retire: (retired: ChromeClient) => Array<() => Promise<unknown>>;
  /** Records the new tab as the run's tab (target id, ownership, session runtime). */
  moved: (opened: T) => void;
  ready?: () => Promise<unknown>;
}): Promise<ReplacementTab | null> {
  const opened = await options.open();
  const drop = () => {
    retireFrozenTab(options.logger, [opened.discard]);
    return null;
  };
  if (options.givenUp()) return drop();
  await prepareReplacementTab(opened.client, options.logger);
  if (options.givenUp()) return drop();
  const retired = options.runClient.replace(opened.client);
  const leftovers = options.retire(retired);
  options.moved(opened);
  retireFrozenTab(options.logger, leftovers);
  return { targetId: opened.targetId, ready: options.ready };
}

/** The page target id of a chrome-remote-interface client (its WebSocket URL), if it shows one. */
export function clientTargetId(client: ChromeClient): string | undefined {
  const url = (client as unknown as { webSocketUrl?: unknown }).webSocketUrl;
  return typeof url === "string" ? /\/devtools\/page\/([^/?#]+)/.exec(url)?.[1] : undefined;
}
