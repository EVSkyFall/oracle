import type { ChromeClient } from "./types.js";

/**
 * After the run's time for an answer is spent, a CDP call still gets this long to answer (the
 * timeout path reads the page once more for its diagnostics); once one has not answered in time,
 * later calls get only a moment until one answers again.
 */
const AFTER_DEADLINE_GRACE_MS = 2_000;
const AFTER_DEADLINE_UNANSWERED_MS = 250;

/**
 * A CDP call that did not answer before the run's time for the answer ran out. Its message is a
 * response-wait timeout, so the run ends as its timeout always has (same error, same hints).
 */
export class RunTimeExpiredError extends Error {
  constructor(what: string) {
    super(
      `assistant-response-watchdog-timeout: ${what} did not answer before the run's time for the answer ran out`,
    );
    this.name = "RunTimeExpiredError";
  }
}

const LISTENER_METHODS = new Set(["on", "once", "addListener"]);
const UNLISTEN_METHODS = new Set(["off", "removeListener"]);
const PASS_THROUGH = new Set(["emit", "removeAllListeners", "listeners", "listenerCount"]);

export interface RunClient {
  /** Stable stand-in for the run's CDP client: its domains act on the current tab. */
  client: ChromeClient;
  /** The tab's own client the run acts on now. */
  current(): ChromeClient;
  /**
   * Moves the run to another tab's client: listeners and event subscriptions made through
   * `client` move with it, so the retired client's events (its disconnect included) no longer
   * reach the run. Returns the retired client, which the caller closes.
   */
  replace(next: ChromeClient): ChromeClient;
  /**
   * While an answer is awaited, every call is raced against the time left; after that time, a
   * short grace (see above). Null: no bound (the submission and what follows a captured answer).
   */
  setDeadline(at: number | null): void;
  deadline(): number | null;
}

type Listener = { owner: "client" | string; event: string; fn: (...args: unknown[]) => unknown };
type Subscription = { domain: string; method: string; args: unknown[]; unsubscribe: unknown };

/**
 * Wraps a run's CDP client so the run can move to another tab of the same Chrome (a frozen
 * renderer is replaced) and so no call holds the run past its time for an answer.
 */
export function createRunClient(initial: ChromeClient): RunClient {
  let currentClient = initial;
  let deadlineAt: number | null = null;
  let unanswered = false;
  const listeners = new Set<Listener>();
  const subscriptions = new Set<Subscription>();

  const bounded = <T>(what: string, call: () => T): T | Promise<unknown> => {
    const result = call() as unknown;
    if (
      deadlineAt === null ||
      !result ||
      typeof (result as PromiseLike<unknown>).then !== "function"
    ) {
      return result as T;
    }
    const now = Date.now();
    const wait =
      now < deadlineAt
        ? deadlineAt - now
        : unanswered
          ? AFTER_DEADLINE_UNANSWERED_MS
          : AFTER_DEADLINE_GRACE_MS;
    const pastDeadline = now >= deadlineAt;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (deadlineAt !== null && Date.now() >= deadlineAt) unanswered = true;
          reject(new RunTimeExpiredError(what));
        },
        Math.max(0, wait),
      );
      timer.unref?.();
      Promise.resolve(result).then(
        (value) => {
          clearTimeout(timer);
          if (pastDeadline) unanswered = false;
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };

  const domainTarget = (domain: string): Record<string, unknown> | undefined =>
    (currentClient as unknown as Record<string, Record<string, unknown> | undefined>)[domain];

  const domainProxies = new Map<string, object>();
  const domainProxy = (domain: string): object => {
    const cached = domainProxies.get(domain);
    if (cached) return cached;
    const proxy = new Proxy(
      {},
      {
        has: (_object, key) => {
          const target = domainTarget(domain);
          return Boolean(target) && key in (target as object);
        },
        get: (_object, key) => {
          if (typeof key === "symbol") return undefined;
          const target = domainTarget(domain);
          const value = target?.[key];
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const live = domainTarget(domain);
            const method = live?.[key];
            if (typeof method !== "function") {
              throw new TypeError(`${domain}.${key} is not available on this tab`);
            }
            if (LISTENER_METHODS.has(key) && typeof args[1] === "function") {
              listeners.add({
                owner: domain,
                event: String(args[0]),
                fn: args[1] as Listener["fn"],
              });
              return method.apply(live, args);
            }
            if (UNLISTEN_METHODS.has(key) && typeof args[1] === "function") {
              for (const entry of listeners) {
                if (entry.owner === domain && entry.event === args[0] && entry.fn === args[1]) {
                  listeners.delete(entry);
                }
              }
              return method.apply(live, args);
            }
            // An event subscription (a handler as the only argument) moves with the run.
            if (typeof args[0] === "function") {
              const subscription: Subscription = {
                domain,
                method: key,
                args,
                unsubscribe: method.apply(live, args),
              };
              subscriptions.add(subscription);
              return () => {
                subscriptions.delete(subscription);
                if (typeof subscription.unsubscribe === "function") subscription.unsubscribe();
              };
            }
            return bounded(`${domain}.${key}`, () => method.apply(live, args));
          };
        },
      },
    );
    domainProxies.set(domain, proxy);
    return proxy;
  };

  const client = new Proxy(
    {},
    {
      has: (_object, key) => key in (currentClient as object),
      get: (_object, key) => {
        if (typeof key === "symbol") return undefined;
        const raw = currentClient as unknown as Record<string, unknown>;
        const value = raw[key];
        if (LISTENER_METHODS.has(key)) {
          return (event: string, fn: Listener["fn"]) => {
            listeners.add({ owner: "client", event, fn });
            return (raw[key] as (...args: unknown[]) => unknown).call(currentClient, event, fn);
          };
        }
        if (UNLISTEN_METHODS.has(key)) {
          return (event: string, fn: Listener["fn"]) => {
            for (const entry of listeners) {
              if (entry.owner === "client" && entry.event === event && entry.fn === fn) {
                listeners.delete(entry);
              }
            }
            const off = raw[key] ?? raw.removeListener;
            return typeof off === "function" ? off.call(currentClient, event, fn) : undefined;
          };
        }
        if (/^[A-Z]/.test(key) && value && typeof value === "object") return domainProxy(key);
        if (typeof value === "function") {
          if (key === "close" || PASS_THROUGH.has(key)) return value.bind(currentClient);
          return (...args: unknown[]) => bounded(key, () => value.apply(currentClient, args));
        }
        return value;
      },
    },
  ) as ChromeClient;

  const move = (from: ChromeClient, to: ChromeClient) => {
    const fromRaw = from as unknown as Record<
      string,
      Record<string, unknown> & ((...a: unknown[]) => unknown)
    >;
    const toRaw = to as unknown as Record<string, Record<string, unknown>>;
    for (const entry of listeners) {
      const source = entry.owner === "client" ? fromRaw : fromRaw[entry.owner];
      const target = entry.owner === "client" ? toRaw : toRaw[entry.owner];
      const off =
        (source as Record<string, unknown> | undefined)?.removeListener ??
        (source as Record<string, unknown> | undefined)?.off;
      if (typeof off === "function") off.call(source, entry.event, entry.fn);
      const on = (target as Record<string, unknown> | undefined)?.on;
      if (typeof on === "function") on.call(target, entry.event, entry.fn);
    }
    for (const subscription of subscriptions) {
      if (typeof subscription.unsubscribe === "function") {
        try {
          subscription.unsubscribe();
        } catch {
          // the retired tab may be gone already
        }
      }
      const method = toRaw[subscription.domain]?.[subscription.method];
      subscription.unsubscribe =
        typeof method === "function"
          ? method.apply(toRaw[subscription.domain], subscription.args)
          : undefined;
    }
  };

  return {
    client,
    current: () => currentClient,
    replace(next) {
      const retired = currentClient;
      move(retired, next);
      currentClient = next;
      return retired;
    },
    setDeadline(at) {
      deadlineAt = at;
      unanswered = false;
    },
    deadline: () => deadlineAt,
  };
}
