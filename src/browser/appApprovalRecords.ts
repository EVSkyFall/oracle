import type { BrowserAppApprovalRecord } from "./types.js";

const recordKey = (record: BrowserAppApprovalRecord) =>
  `${record.app}\u0000${record.button}\u0000${record.approvedAt}\u0000${record.toolText}`;

/** Approval records from several sources, oldest source first, without duplicates. */
export function mergeAppApprovalRecords(
  ...lists: Array<readonly BrowserAppApprovalRecord[] | null | undefined>
): BrowserAppApprovalRecord[] {
  const seen = new Set<string>();
  const merged: BrowserAppApprovalRecord[] = [];
  for (const list of lists) {
    for (const record of list ?? []) {
      const key = recordKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
  }
  return merged;
}

/**
 * The runtime with every approval recorded earlier kept. Error and recovery paths replace the
 * session runtime with the runtime of the failing step, which may not carry them.
 */
export function withAppApprovals<
  T extends { appApprovals?: BrowserAppApprovalRecord[] } | null | undefined,
>(
  runtime: T,
  ...earlier: Array<{ appApprovals?: BrowserAppApprovalRecord[] } | null | undefined>
): T {
  if (!runtime) return runtime;
  const merged = mergeAppApprovalRecords(
    ...earlier.map((entry) => entry?.appApprovals),
    runtime.appApprovals,
  );
  return merged.length > 0 ? { ...runtime, appApprovals: merged } : runtime;
}
