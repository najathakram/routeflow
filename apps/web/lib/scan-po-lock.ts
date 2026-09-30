import type { PlanFlagState } from "@/lib/plan-gated-nav";

/** What the "Scan supplier invoice" button does, learned from the plan-flag client state for
 *  `flag.ap_bills` (the scan route's gate). Never inferred from a 403. */
export type ScanPoAccess = "open" | "locked" | "pending";

export function scanPoAccess(flag: PlanFlagState): ScanPoAccess {
  if (!flag.resolved) return flag.failed ? "open" : "pending"; // a failed read lets the server decide
  return flag.enabled ? "open" : "locked";
}

export const SCAN_LOCK_TITLE = "Invoice scanning isn't on your plan";
export const SCAN_LOCK_BODY =
  "Scanning a supplier invoice into a purchase order is part of a higher plan. You can still create purchase orders by hand on any plan.";

/** True for the 403 the scan route answers with when the plan gate closes after the page loaded. */
export function isScanPlanLock(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 403;
}
