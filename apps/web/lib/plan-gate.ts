/**
 * Client mirror of the server PLAN_GATE contract (apps/api/src/billing/plan-gate.ts).
 * When a gated endpoint 403s, parse the structured body and render the matching gate.
 */
export type PlanGateState = "LOCKED_PAGE" | "INLINE_RESOLVE" | "GRACE";

export interface PlanGateUpgrade {
  planKey: string | null;
  planMonthlyPrice: string | null;
  addonSku: string | null;
  addonMonthlyPrice: string | null;
}

export interface PlanGateBody {
  code: "PLAN_GATE" | "PLAN_GATE_UNAVAILABLE";
  state?: PlanGateState;
  flag?: string;
  message: string;
  upgrade?: PlanGateUpgrade;
}

/** Extract a PLAN_GATE body from an axios error, or null if it isn't a plan gate. */
export function parsePlanGate(err: unknown): PlanGateBody | null {
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    PlanGateBody | undefined;
  if (data && (data.code === "PLAN_GATE" || data.code === "PLAN_GATE_UNAVAILABLE")) return data;
  return null;
}
