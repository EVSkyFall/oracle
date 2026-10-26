import { describe, expect, test, vi } from "vitest";
import { waitAtSentTurn, type SentTurnScope } from "../../src/browser/sentTurnScope.js";

// One answer-wait attempt scoped to the user turn the run sent, found by its identity. The page's
// latest user turn is a fake that the test moves: before the send it is u4 (index 3 of a window
// of four); the sent turn u5 mounts at index 3 once the oldest exchange unmounts.
function page(latest: { index: number; messageId: string } | null) {
  const state = { latest };
  const runtime = {
    evaluate: vi.fn(async () => ({
      result: { value: state.latest ? { ...state.latest, text: "x" } : null },
    })),
  };
  return { state, runtime: runtime as never, evaluate: runtime.evaluate };
}

function scopeAt(start: number) {
  const moves: number[] = [];
  let current: number | null = start;
  const scope: SentTurnScope = {
    previousUserMessageIds: ["u1", "u2", "u3", "u4"],
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

  test("without the pre-send ids the attempt runs as before", async () => {
    const view = page(null);
    const operation = vi.fn(async () => "answer");
    await expect(waitAtSentTurn(view.runtime, null, attempt(), 10_000, operation)).resolves.toBe(
      "answer",
    );
    expect(view.evaluate).not.toHaveBeenCalled();
  });
});
