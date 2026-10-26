import { describe, expect, test, vi } from "vitest";
import {
  scopeToSentTurnNow,
  waitAtSentTurn,
  type SentTurnScope,
} from "../../src/browser/sentTurnScope.js";

// One answer-wait attempt scoped to the user turn the run sent, found by its identity. The page's
// latest user turn is a fake that the test moves: before the send it is u4 (index 3 of a window
// of four); the sent turn u5 mounts at index 3 once the oldest exchange unmounts.
type PageTurn = {
  index: number;
  messageId: string;
  text?: string;
  /** No pre-send user turn is rendered (the page's read flags it). */
  presendUnrendered?: boolean;
};
function page(latest: PageTurn | null) {
  const state = { latest };
  const runtime = {
    evaluate: vi.fn(async () => ({
      result: { value: state.latest ? { text: "x", ...state.latest } : null },
    })),
  };
  return { state, runtime: runtime as never, evaluate: runtime.evaluate };
}

const SENT_PROMPT = "Follow-up 5: print 1..150, one per line";
function scopeAt(start: number, sentMessageId: string | null = null) {
  const moves: number[] = [];
  let current: number | null = start;
  const scope: SentTurnScope = {
    turn: {
      previousUserMessageIds: ["u1", "u2", "u3", "u4"],
      messageId: sentMessageId,
      prompt: SENT_PROMPT,
    },
    current: () => current,
    moveTo: (index) => {
      moves.push(index);
      current = index;
    },
  };
  return { scope, moves, current: () => current };
}

const attempt = (signal = new AbortController().signal) => ({
  signal,
  remainingMs: (total: number) => total,
});

describe("an answer-wait attempt at the sent user turn", () => {
  test("starts at the sent turn when it is mounted (a reload's window can put it elsewhere)", async () => {
    const { runtime } = page({ index: 2, messageId: "u5" });
    const { scope, moves, current } = scopeAt(3);
    const scopes: Array<number | null> = [];
    const result = await waitAtSentTurn(runtime, scope, attempt(), 10_000, async () => {
      scopes.push(current());
      return "answer";
    });
    expect(result).toBe("answer");
    expect(moves).toEqual([2]);
    expect(scopes).toEqual([2]);
  });

  test("is never held back while the sent turn has not mounted, and restarts there once it mounts", async () => {
    const view = page({ index: 3, messageId: "u4" });
    const { scope, moves, current } = scopeAt(4);
    const scopes: Array<number | null> = [];
    // The exchange mounts after the commit window: here, shortly after the wait began.
    setTimeout(() => {
      view.state.latest = { index: 3, messageId: "u5" };
    }, 100);
    const result = await waitAtSentTurn(view.runtime, scope, attempt(), 10_000, (inner) => {
      scopes.push(current());
      if (scopes.length === 1) {
        // The wait at the old scope (4) never sees the new exchange at 3: it waits until stopped.
        return new Promise<string>((_, reject) => {
          inner.signal.addEventListener("abort", () => reject(new Error("wait aborted")));
        });
      }
      return Promise.resolve(`answer after turn ${current()}`);
    });
    expect(scopes).toEqual([4, 3]);
    expect(moves).toEqual([3]);
    expect(result).toBe("answer after turn 3");
  });

  test("an answer found before the sent turn shows up ends the attempt; the watcher stops", async () => {
    const view = page({ index: 3, messageId: "u4" });
    const { scope, moves } = scopeAt(4);
    const result = await waitAtSentTurn(view.runtime, scope, attempt(), 10_000, async () => "done");
    expect(result).toBe("done");
    expect(moves).toEqual([]);
    const reads = view.evaluate.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(view.evaluate.mock.calls.length).toBe(reads);
  });

  test("a reload that ends the attempt is never turned into a restart", async () => {
    const view = page({ index: 3, messageId: "u4" });
    const { scope } = scopeAt(4);
    const reload = new AbortController();
    const outcome = waitAtSentTurn(view.runtime, scope, attempt(reload.signal), 10_000, (inner) => {
      return new Promise<string>((_, reject) => {
        inner.signal.addEventListener("abort", () => reject(new Error("reloaded")));
      });
    });
    setTimeout(() => reload.abort(), 50);
    await expect(outcome).rejects.toThrow("reloaded");
  });

  test("with the sent turn's id known, an older turn rendered later never moves the scope", async () => {
    // A window above the send's own (a scroll or a reload): u0 was never among the pre-send ids.
    const view = page({ index: 2, messageId: "u0", presendUnrendered: true });
    const { scope, moves } = scopeAt(3, "u5");
    expect(await scopeToSentTurnNow(view.runtime, scope)).toBe(false);
    view.state.latest = { index: 1, messageId: "u6" };
    expect(await scopeToSentTurnNow(view.runtime, scope)).toBe(false);
    expect(moves).toEqual([]);
    // The sent turn itself, wherever the window puts it.
    view.state.latest = { index: 2, messageId: "u5" };
    expect(await scopeToSentTurnNow(view.runtime, scope)).toBe(true);
    expect(moves).toEqual([2]);
  });

  test("with the id unknown, a latest turn after no rendered pre-send turn counts only when it shows the sent prompt", async () => {
    const view = page({
      index: 2,
      messageId: "u0",
      text: "Earlier question 0",
      presendUnrendered: true,
    });
    const { scope, moves } = scopeAt(3);
    expect(await scopeToSentTurnNow(view.runtime, scope)).toBe(false);
    expect(moves).toEqual([]);
    expect(scope.turn.messageId).toBeNull();
    view.state.latest = { index: 2, messageId: "u5", text: SENT_PROMPT, presendUnrendered: true };
    expect(await scopeToSentTurnNow(view.runtime, scope)).toBe(true);
    expect(moves).toEqual([2]);
  });

  test("the first find records the sent turn's id: from then on only that turn moves the scope", async () => {
    const view = page({ index: 3, messageId: "u5" });
    const { scope, moves } = scopeAt(4);
    expect(await scopeToSentTurnNow(view.runtime, scope)).toBe(true);
    expect(scope.turn.messageId).toBe("u5");
    // Another turn not among the pre-send ids, after the send's own window went away.
    view.state.latest = { index: 1, messageId: "u0" };
    expect(await scopeToSentTurnNow(view.runtime, scope)).toBe(false);
    expect(moves).toEqual([3]);
  });

  test("a pre-send turn is never the sent one", async () => {
    const view = page({ index: 3, messageId: "u4" });
    const { scope, moves } = scopeAt(4);
    expect(await scopeToSentTurnNow(view.runtime, scope)).toBe(false);
    expect(moves).toEqual([]);
  });

  test("without the pre-send ids the attempt runs as before", async () => {
    const view = page(null);
    const operation = vi.fn(async () => "answer");
    await expect(waitAtSentTurn(view.runtime, null, attempt(), 10_000, operation)).resolves.toBe(
      "answer",
    );
    expect(view.evaluate).not.toHaveBeenCalled();
  });
});
