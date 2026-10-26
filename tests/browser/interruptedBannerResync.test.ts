import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTurnResync, type TurnResyncAttempt } from "../../src/browser/turnResync.js";
import {
  interruptedBannerRetryMs,
  type InterruptedBannerDiagnostic,
} from "../../src/browser/interruptedBanner.js";
import type { ChromeClient } from "../../src/browser/types.js";

// The turn resync and ChatGPT's "Connection interrupted. Waiting for the complete answer" banner
// (2026-10-26, ask-20261026-134247-ynwq: the page sat on it with Stop shown; the stall reloads came
// at 8 and 24 minutes, then the run waited about 1 h 40 min until it was killed).
const MINUTE = 60_000;
const CONVERSATION = "https://chatgpt.com/c/6add23d8-0000-0000-0000-0000000000b2";
const BANNER = "connection interrupted. waiting for the complete answer";

/**
 * A ChatGPT tab whose progress read reports the banner as `page.banner` says; the thread itself
 * never changes. Reloads are recorded with their time, and `onLoad` runs on each.
 */
function bannerTab(page: { banner: string | null }, onLoad: (load: number) => void = () => {}) {
  let mark: string | null = null;
  const reloads: number[] = [];
  const Runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("readTurnProgress")) {
        return {
          result: {
            value: { key: "same", length: 9, url: CONVERSATION, interrupted: page.banner },
          },
        };
      }
      if (expression.includes("ancestors.push")) {
        return {
          result: {
            value: page.banner
              ? {
                  url: CONVERSATION,
                  text: page.banner,
                  bannerHtml: "<span>Connection interrupted</span>",
                  bannerHtmlLength: 35,
                  html: "",
                  htmlLength: 0,
                  ancestors: [],
                  withheld: false,
                  stopVisible: true,
                }
              : null,
          },
        };
      }
      const set = /window\.__oracleResyncMark = "([^"]+)"/.exec(expression);
      if (set) {
        mark = set[1]!;
        return { result: { value: mark } };
      }
      const asked = /window\.__oracleResyncMark === "([^"]+)"/.exec(expression);
      if (asked) return { result: { value: asked[1] === mark ? "old" : "complete" } };
      if (expression === "location.href") return { result: { value: CONVERSATION } };
      if (expression.endsWith(").length")) return { result: { value: 6 } };
      return { result: { value: null } };
    }),
  };
  const load = () => {
    reloads.push(Date.now());
    mark = null;
    onLoad(reloads.length);
    return Promise.resolve({});
  };
  const Page = { reload: vi.fn(load), navigate: vi.fn(load) };
  return {
    Runtime: Runtime as unknown as ChromeClient["Runtime"],
    Page: Page as unknown as ChromeClient["Page"],
    reloads,
  };
}

const waitUntilAborted = (attempt: TurnResyncAttempt) =>
  new Promise<string>((_, reject) => {
    attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason), { once: true });
  });

const lines = (logger: ReturnType<typeof vi.fn>) => logger.mock.calls.map(([line]) => String(line));

describe('the turn resync and the "Connection interrupted" banner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function start(
    page: { banner: string | null },
    onLoad?: (load: number) => void,
    extra: { frozenOnly?: boolean } = {},
  ) {
    const tab = bannerTab(page, onLoad);
    const logger = Object.assign(vi.fn(), { verbose: false });
    const saved: InterruptedBannerDiagnostic[] = [];
    const resync = createTurnResync({
      Runtime: tab.Runtime,
      Page: tab.Page,
      logger,
      conversationUrl: () => CONVERSATION,
      saveInterruptedBannerDiagnostic: async (diagnostic) => {
        saved.push(diagnostic);
        return `artifacts/interrupted-banner-diag-${saved.length}.html`;
      },
      ...extra,
    });
    const startedAt = Date.now();
    void resync.run(waitUntilAborted).catch(() => undefined);
    const since = () => tab.reloads.map((at) => at - startedAt);
    return { tab, logger, saved, since };
  }

  test("the banner on a generating turn reloads within seconds, with no 8-minute wait", async () => {
    const page = { banner: BANNER as string | null };
    // The reload brings the answer in: the banner is gone.
    const { logger, saved, since } = start(page, () => {
      page.banner = null;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(since()).toHaveLength(1);
    // Two progress reads 5 s apart.
    expect(since()[0]).toBeLessThan(11_000);
    expect(lines(logger)).toContain(
      '[browser] ChatGPT shows "Connection interrupted"; reloading the conversation now',
    );
    expect(lines(logger).filter((line) => line.includes("Turn looks stalled"))).toEqual([]);
    // Its diagnostic, once, from the first sighting.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      reason: 'ChatGPT shows "Connection interrupted"',
      page: { text: BANNER, stopVisible: true },
    });
    expect(lines(logger)).toContain(
      '[browser] "Connection interrupted" diagnostic saved: artifacts/interrupted-banner-diag-1.html',
    );
  });

  test("the banner reload does not advance the stall backoff: a quiet page after it reloads 8 minutes later, not 16", async () => {
    const page = { banner: BANNER as string | null };
    const { logger, since } = start(page, () => {
      page.banner = null;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const bannerReload = since()[0]!;
    await vi.advanceTimersByTimeAsync(7 * MINUTE);
    expect(since()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(since()).toHaveLength(2);
    expect(since()[1]! - bannerReload).toBeGreaterThanOrEqual(8 * MINUTE);
    expect(since()[1]! - bannerReload).toBeLessThan(8 * MINUTE + 15_000);
    expect(
      lines(logger).filter((line) => line.startsWith("[browser] Turn looks stalled")),
    ).toHaveLength(1);
  });

  test("a banner that stays reloads on its own backoff (30 s, 1, 2, 4, 8, 8 minutes), never on the stall one", async () => {
    const page = { banner: BANNER as string | null };
    const { logger, since } = start(page);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    const times = since();
    expect(times.length).toBeGreaterThanOrEqual(7);
    expect(times[0]).toBeLessThan(11_000);
    for (let index = 1; index < 7; index += 1) {
      const gap = times[index]! - times[index - 1]!;
      const retry = interruptedBannerRetryMs(index);
      // The backoff, then up to two progress reads (5 s apart) and the previous reload's settle.
      expect(gap, `reload ${index + 1}`).toBeGreaterThanOrEqual(retry);
      expect(gap, `reload ${index + 1}`).toBeLessThan(retry + 15_000);
    }
    expect([1, 2, 3, 4, 5, 6].map(interruptedBannerRetryMs)).toEqual([
      30_000,
      MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
      8 * MINUTE,
    ]);
    expect(lines(logger).filter((line) => line.includes("Turn looks stalled"))).toEqual([]);
    expect(lines(logger)).toContain(
      '[browser] ChatGPT still shows "Connection interrupted" after 1 reload; reloading the conversation now',
    );
    expect(lines(logger)).toContain(
      '[browser] ChatGPT still shows "Connection interrupted" after 2 reloads; reloading the conversation now',
    );
  });

  test("a banner on one read only (a flicker) does not reload", async () => {
    const page = { banner: BANNER as string | null };
    const { logger, since } = start(page);
    // The first progress read sees it; it is gone by the next one.
    await vi.advanceTimersByTimeAsync(1_000);
    page.banner = null;
    await vi.advanceTimersByTimeAsync(7 * MINUTE);
    expect(since()).toEqual([]);
    expect(lines(logger).filter((line) => line.includes("reloading"))).toEqual([]);
  });

  test("a banner gone for a moment keeps its backoff; gone for minutes, it starts over", async () => {
    const page = { banner: BANNER as string | null };
    // After the first reload it is gone for one read, after the second for three minutes; from
    // the third on it stays.
    const { logger, since } = start(page, (load) => {
      if (load > 2) return;
      page.banner = null;
      setTimeout(
        () => {
          page.banner = BANNER;
        },
        load === 1 ? 6_000 : 3 * MINUTE,
      );
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(since()).toHaveLength(1);
    // Back after one read without it: the next reload waits the 30 s backoff.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(since()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(since()).toHaveLength(2);
    expect(since()[1]! - since()[0]!).toBeGreaterThanOrEqual(30_000);
    // Gone for three minutes, then back: its backoff started over, so the reload after the next
    // one waits 30 s again (not the 2 minutes of a third reload in a row).
    await vi.advanceTimersByTimeAsync(3 * MINUTE + 5_000);
    expect(since()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(since()).toHaveLength(4);
    expect(since()[3]! - since()[2]!).toBeGreaterThanOrEqual(30_000);
    expect(since()[3]! - since()[2]!).toBeLessThan(45_000);
    expect(
      lines(logger).filter((line) =>
        line.startsWith('[browser] ChatGPT shows "Connection interrupted"; reloading'),
      ),
    ).toHaveLength(2);
  });

  test("the Deep Research wait (frozen pages only otherwise) reloads for the banner too", async () => {
    const page = { banner: BANNER as string | null };
    const { since } = start(
      page,
      () => {
        page.banner = null;
      },
      { frozenOnly: true },
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(since()).toHaveLength(1);
  });

  test("without a conversation URL the banner is reported once and the page is not reloaded", async () => {
    const tab = bannerTab({ banner: BANNER });
    tab.Runtime.evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("readTurnProgress")) {
        return {
          result: {
            value: { key: "same", length: 9, url: "https://chatgpt.com/", interrupted: BANNER },
          },
        };
      }
      if (expression === "location.href") return { result: { value: "https://chatgpt.com/" } };
      return { result: { value: null } };
    }) as never;
    const logger = Object.assign(vi.fn(), { verbose: false });
    const resync = createTurnResync({ Runtime: tab.Runtime, Page: tab.Page, logger });
    void resync.run(waitUntilAborted).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(tab.reloads).toEqual([]);
    expect(lines(logger).filter((line) => line.includes("no conversation URL"))).toEqual([
      '[browser] ChatGPT shows "Connection interrupted", but no conversation URL is known, so the page is not reloaded.',
    ]);
  });
});

describe('the "Connection interrupted" diagnostic is wired wherever a turn is waited for', () => {
  test("both runs (answer and Deep Research waits), both reattach paths and the reattach command", async () => {
    const { readFile } = await import("node:fs/promises");
    const read = (file: string) => readFile(new URL(`../../src/${file}`, import.meta.url), "utf8");
    const count = (source: string, pattern: string) => source.split(pattern).length - 1;
    const index = await read("browser/index.ts");
    const reattach = await read("browser/reattach.ts");
    const deepResearch = await read("browser/deepResearchWait.ts");
    const display = await read("cli/sessionDisplay.ts");
    // Every resync and Deep Research wait of the runs saves it, once per run.
    expect(count(index, "replaceTab: replaceFrozenTab,")).toBe(4);
    expect(count(index, "saveInterruptedBannerDiagnostic: saveBannerDiagnostic,")).toBe(4);
    expect(count(index, "let interruptedBannerDiagnosed = false;")).toBe(2);
    expect(count(reattach, "replaceTab: replaceFrozenTab,")).toBe(4);
    expect(
      count(reattach, "saveInterruptedBannerDiagnostic: deps.saveInterruptedBannerDiagnostic,"),
    ).toBe(4);
    expect(deepResearch).toContain(
      "saveInterruptedBannerDiagnostic: params.saveInterruptedBannerDiagnostic,",
    );
    expect(display).toContain("return saveInterruptedBannerDiagnostic(sessionId, diagnostic);");
  });
});
