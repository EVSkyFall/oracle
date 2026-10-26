import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { installJavaScriptDialogAutoDismissal } from "../../src/browser/actions/navigation.js";
import { BrowserCancellation } from "../../src/browser/cancellation.js";
import { createRunClient, TabReplacedError } from "../../src/browser/runClient.js";
import type { ChromeClient } from "../../src/browser/types.js";

/**
 * A tab client shaped like chrome-remote-interface's (lib/api.js): the client is an
 * EventEmitter; a domain event method subscribes a handler and returns its unsubscribe function,
 * or without a handler returns a promise of the next event; `Domain.on(name, handler)` is that
 * event method; domains have no once/off/removeListener.
 */
function criTab(name: string) {
  const chrome = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const calls: string[] = [];
  const domain = (domainName: string, events: string[], commands: string[]) => {
    const methods: Record<string, unknown> = {};
    for (const command of commands) {
      const handler = async () => {
        calls.push(`${domainName}.${command}`);
        return {};
      };
      Object.assign(handler, { category: "command" });
      methods[command] = handler;
    }
    for (const event of events) {
      const eventName = `${domainName}.${event}`;
      const handler = (sessionId?: unknown, fn?: unknown) => {
        if (typeof sessionId === "function") {
          fn = sessionId;
          sessionId = undefined;
        }
        const raw = sessionId ? `${eventName}.${String(sessionId)}` : eventName;
        if (typeof fn === "function") {
          const listener = fn as (...args: unknown[]) => void;
          chrome.on(raw, listener);
          return () => chrome.removeListener(raw, listener);
        }
        return new Promise((resolve) => chrome.once(raw, resolve));
      };
      Object.assign(handler, { category: "event" });
      methods[event] = handler;
    }
    methods.on = (eventName: string, fn: unknown) =>
      (methods[eventName] as (handler: unknown) => unknown)(fn);
    chrome[domainName] = methods;
  };
  domain("Page", ["javascriptDialogOpening", "loadEventFired"], ["handleJavaScriptDialog"]);
  chrome.close = async () => {};
  return {
    name,
    client: chrome as unknown as ChromeClient,
    calls,
    emit: (event: string, params: unknown = {}) => chrome.emit(event, params),
    listeners: (event: string) => chrome.listenerCount(event),
  };
}

const quietLogger = () => Object.assign(vi.fn(), { verbose: false });

describe("the run client moves event subscriptions with the run", () => {
  test("a domain subscription made through Page.on leaves the old tab: its events no longer reach the run", async () => {
    const tabA = criTab("A");
    const tabB = criTab("B");
    const runClient = createRunClient(tabA.client);
    const remove = installJavaScriptDialogAutoDismissal(runClient.client.Page, quietLogger());
    expect(tabA.listeners("Page.javascriptDialogOpening")).toBe(1);

    runClient.replace(tabB.client);
    expect(tabA.listeners("Page.javascriptDialogOpening")).toBe(0);
    expect(tabB.listeners("Page.javascriptDialogOpening")).toBe(1);

    // A dialog on the old tab is not handled against the new one.
    tabA.emit("Page.javascriptDialogOpening", { type: "alert", message: "old tab" });
    await Promise.resolve();
    expect(tabB.calls).toEqual([]);
    expect(tabA.calls).toEqual([]);
    // One on the new tab is.
    tabB.emit("Page.javascriptDialogOpening", { type: "alert", message: "new tab" });
    await Promise.resolve();
    expect(tabB.calls).toEqual(["Page.handleJavaScriptDialog"]);

    // The remover returned before the move removes it from the new tab.
    remove();
    expect(tabB.listeners("Page.javascriptDialogOpening")).toBe(0);
  });

  test("a once listener fires once in all: it is not replayed on the new tab after it fired, and one that did not fire yet fires once there", () => {
    const tabA = criTab("A");
    const tabB = criTab("B");
    const runClient = createRunClient(tabA.client);
    const fired = vi.fn();
    const pending = vi.fn();
    const emitter = runClient.client as unknown as EventEmitter;
    emitter.once("Page.loadEventFired", fired);
    tabA.emit("Page.loadEventFired");
    expect(fired).toHaveBeenCalledTimes(1);
    emitter.once("Page.loadEventFired", pending);

    runClient.replace(tabB.client);
    tabA.emit("Page.loadEventFired");
    tabB.emit("Page.loadEventFired");
    tabB.emit("Page.loadEventFired");
    expect(fired).toHaveBeenCalledTimes(1);
    expect(pending).toHaveBeenCalledTimes(1);
    expect(tabA.listeners("Page.loadEventFired")).toBe(0);
    expect(tabB.listeners("Page.loadEventFired")).toBe(0);
  });

  test("a wait for the next event of the old tab ends when the run moves, and an old-tab event never settles it", async () => {
    const tabA = criTab("A");
    const tabB = criTab("B");
    const runClient = createRunClient(tabA.client);
    const wait = (
      runClient.client.Page as unknown as { loadEventFired: () => Promise<unknown> }
    ).loadEventFired();
    const settled: { value?: unknown; error?: unknown } = {};
    wait.then(
      (value) => {
        settled.value = value;
      },
      (error: unknown) => {
        settled.error = error;
      },
    );
    runClient.replace(tabB.client);
    tabA.emit("Page.loadEventFired", { from: "A" });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled.value).toBeUndefined();
    expect(settled.error).toBeInstanceOf(TabReplacedError);

    // A wait started after the move is answered by the new tab.
    const next = (
      runClient.client.Page as unknown as { loadEventFired: () => Promise<unknown> }
    ).loadEventFired();
    tabB.emit("Page.loadEventFired", { from: "B" });
    await expect(next).resolves.toEqual({ from: "B" });
  });
});

describe("the run client over a cancellable tab client (as runs build it)", () => {
  test("subscriptions and event waits behave the same through the cancellation wrapper", async () => {
    const cancellation = new BrowserCancellation(new AbortController().signal);
    const tabA = criTab("A");
    const tabB = criTab("B");
    const runClient = createRunClient(cancellation.client(tabA.client));
    const remove = installJavaScriptDialogAutoDismissal(runClient.client.Page, quietLogger());
    const wait = (
      runClient.client.Page as unknown as { loadEventFired: () => Promise<unknown> }
    ).loadEventFired();
    const outcome = wait.then(
      () => "resolved",
      (error: unknown) => error,
    );
    runClient.replace(cancellation.client(tabB.client));
    expect(tabA.listeners("Page.javascriptDialogOpening")).toBe(0);
    expect(tabB.listeners("Page.javascriptDialogOpening")).toBe(1);
    tabA.emit("Page.loadEventFired");
    expect(await outcome).toBeInstanceOf(TabReplacedError);
    remove();
    expect(tabB.listeners("Page.javascriptDialogOpening")).toBe(0);
  });
});
