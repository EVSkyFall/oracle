import { describe, expect, test } from "vitest";
import { mergeAppApprovalRecords, withAppApprovals } from "../../src/browser/appApprovalRecords.js";

const record = (approvedAt: string) => ({
  app: "CODEXish",
  button: "Always allow",
  toolText: "shell: echo hi",
  approvedAt,
});

describe("app approval records", () => {
  test("merges sources in order without duplicates", () => {
    expect(
      mergeAppApprovalRecords([record("1")], undefined, [record("1"), record("2")], null),
    ).toEqual([record("1"), record("2")]);
  });

  test("keeps earlier approvals on a runtime that lacks them", () => {
    const runtime: { tabUrl: string; appApprovals?: ReturnType<typeof record>[] } = { tabUrl: "x" };
    expect(withAppApprovals(runtime, { appApprovals: [record("1")] })).toEqual({
      tabUrl: "x",
      appApprovals: [record("1")],
    });
    expect(withAppApprovals(runtime, undefined)).toEqual({ tabUrl: "x" });
    expect(withAppApprovals(undefined, { appApprovals: [record("1")] })).toBeUndefined();
  });
});
