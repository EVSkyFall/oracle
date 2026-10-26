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

/** A wait for an event of a tab the run has since left (it was replaced by a new tab). */
export class TabReplacedError extends Error {
  constructor(what: string) {
    super(`${what}: the tab was replaced by a new tab while this waited for it`);
    this.name = "TabReplacedError";
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
   * reach the run, and a wait for the retired tab's next event ends (TabReplacedError). Returns
   * the retired client, which the caller closes.
   */
  replace(next: ChromeClient): ChromeClient;
  /**
   * While an answer is awaited, every call is raced against the time left; after that time, a
   * short grace (see above). Null: no bound (the submission and what follows a captured answer).
   */
  setDeadline(at: number | null): void;
  deadline(): number | null;
}

type Handler = (...args: unknown[]) => unknown;
/** A listener on the client's own emitter (`client.on("disconnect", fn)` and the like). */
type ClientListener = { event: string; fn: Handler; registered: Handler; once: boolean };
/**
 * A handler subscribed through a domain: chrome-remote-interface's `Page.on(name, fn)` and
 * `Page.loadEventFired(fn)` return the unsubscribe function; other clients may have emitter
 * methods on the domain instead.
 */
type Subscription = {
  domain: string;
  method: string;
  args: unknown[];
  fn: Handler;
  once: boolean;
  unsubscribe: unknown;
};
/** A promise-form event wait (`Page.loadEventFired()`) on the current tab. */
type PendingEvent = { reject: (error: Error) => void; what: string };

const isEventMethod = (method: unknown): boolean =>
  (method as { category?: unknown } | undefined)?.category === "event";

/**
 * Wraps a run's CDP client so the run can move to another tab of the same Chrome (a frozen
 * renderer is replaced) and so no call holds the run past its time for an answer.
 */
export function createRunClient(initial: ChromeClient): RunClient {
  let currentClient = initial;
  let deadlineAt: number | null = null;
  let unanswered = false;
  const clientListeners = new Set<ClientListener>();
  const subscriptions = new Set<Subscription>();
  const pendingEvents = new Set<PendingEvent>();

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

  const domainOf = (client: ChromeClient, domain: string): Record<string, unknown> | undefined =>
    (client as unknown as Record<string, Record<string, unknown> | undefined>)[domain];

  /** Subscribes `subscription` on `client`'s domain; returns what the domain returned. */
  const subscribeOn = (client: ChromeClient, subscription: Subscription): unknown => {
    const target = domainOf(client, subscription.domain);
    const method = target?.[subscription.method];
    if (typeof method !== "function") {
      subscription.unsubscribe = undefined;
      return undefined;
    }
    const returned = method.apply(target, subscription.args);
    subscription.unsubscribe = returned;
    return returned;
  };

  /** Ends `subscription` on `client` (its unsubscribe function, or the domain's emitter). */
  const unsubscribeFrom = (client: ChromeClient, subscription: Subscription) => {
    try {
      if (typeof subscription.unsubscribe === "function") {
        (subscription.unsubscribe as () => unknown)();
        return;
      }
      const target = domainOf(client, subscription.domain);
      const off = target?.removeListener ?? target?.off;
      const event = subscription.args[0];
      const handler = subscription.args[1];
      if (typeof off === "function" && typeof event === "string" && typeof handler === "function") {
        off.call(target, event, handler);
      }
    } catch {
      // the retired tab may be gone already
    }
  };

  const domainProxies = new Map<string, object>();
  const domainProxy = (domain: string): object => {
    const cached = domainProxies.get(domain);
    if (cached) return cached;
    const removeTracked = (event: unknown, fn: unknown): boolean => {
      let removed = false;
      for (const subscription of subscriptions) {
        const matches =
          subscription.fn === fn &&
          (LISTENER_METHODS.has(subscription.method)
            ? subscription.args[0] === event
            : subscription.method === event);
        if (!matches) continue;
        subscriptions.delete(subscription);
        unsubscribeFrom(currentClient, subscription);
        removed = true;
      }
      return removed;
    };
    const proxy = new Proxy(
      {},
      {
        has: (_object, key) => {
          const target = domainOf(currentClient, domain);
          return Boolean(target) && key in (target as object);
        },
        get: (_object, key) => {
          if (typeof key === "symbol") return undefined;
          const target = domainOf(currentClient, domain);
          const value = target?.[key];
          // Subscriptions made here can always be removed here, also where the domain itself
          // offers only the unsubscribe function (chrome-remote-interface).
          if (UNLISTEN_METHODS.has(key)) {
            return (event: unknown, fn: unknown) => {
              if (removeTracked(event, fn)) return undefined;
              const live = domainOf(currentClient, domain)?.[key];
              return typeof live === "function"
                ? live.call(domainOf(currentClient, domain), event, fn)
                : undefined;
            };
          }
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const live = domainOf(currentClient, domain);
            const method = live?.[key];
            if (typeof method !== "function") {
              throw new TypeError(`${domain}.${key} is not available on this tab`);
            }
            const handlerIndex = args.findIndex((arg) => typeof arg === "function");
            if (handlerIndex >= 0) {
              // An event subscription moves with the run; a once handler leaves when it fires.
              const fn = args[handlerIndex] as Handler;
              const once = key === "once";
              const subscription: Subscription = {
                domain,
                method: key,
                args: [...args],
                fn,
                once,
                unsubscribe: undefined,
              };
              if (once) {
                subscription.args[handlerIndex] = (...eventArgs: unknown[]) => {
                  subscriptions.delete(subscription);
                  return fn(...eventArgs);
                };
              }
              subscriptions.add(subscription);
              const returned = subscribeOn(currentClient, subscription);
              if (typeof returned !== "function") return returned;
              return () => {
                if (!subscriptions.delete(subscription)) return;
                unsubscribeFrom(currentClient, subscription);
              };
            }
            if (isEventMethod(method)) {
              // A wait for this tab's next event: it ends if the run moves to another tab first.
              const what = `${domain}.${key}`;
              const waited = new Promise((resolve, reject) => {
                const pending: PendingEvent = { reject, what };
                pendingEvents.add(pending);
                Promise.resolve(method.apply(live, args)).then(
                  (value) => {
                    if (pendingEvents.delete(pending)) resolve(value);
                  },
                  (error: unknown) => {
                    if (pendingEvents.delete(pending)) reject(error);
                  },
                );
              });
              return bounded(what, () => waited);
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
          return (event: string, fn: Handler) => {
            const once = key === "once";
            const listener: ClientListener = { event, fn, registered: fn, once };
            if (once) {
              listener.registered = (...eventArgs: unknown[]) => {
                clientListeners.delete(listener);
                return fn(...eventArgs);
              };
            }
            clientListeners.add(listener);
            return (raw[key] as Handler).call(currentClient, event, listener.registered);
          };
        }
        if (UNLISTEN_METHODS.has(key)) {
          return (event: string, fn: Handler) => {
            let registered: Handler = fn;
            for (const listener of clientListeners) {
              if (listener.event === event && listener.fn === fn) {
                clientListeners.delete(listener);
                registered = listener.registered;
              }
            }
            const off = raw[key] ?? raw.removeListener;
            return typeof off === "function"
              ? off.call(currentClient, event, registered)
              : undefined;
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
    const fromRaw = from as unknown as Record<string, unknown>;
    const toRaw = to as unknown as Record<string, unknown>;
    for (const listener of clientListeners) {
      const off = fromRaw.removeListener ?? fromRaw.off;
      try {
        if (typeof off === "function") off.call(from, listener.event, listener.registered);
      } catch {
        // the retired tab may be gone already
      }
      const on = toRaw[listener.once ? "once" : "on"] ?? toRaw.on;
      if (typeof on === "function") on.call(to, listener.event, listener.registered);
    }
    for (const subscription of subscriptions) {
      unsubscribeFrom(from, subscription);
      subscribeOn(to, subscription);
    }
    for (const pending of pendingEvents) {
      pendingEvents.delete(pending);
      pending.reject(new TabReplacedError(pending.what));
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
