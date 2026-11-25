import { roundMoney } from "@routeflow/pricing";

/**
 * P-30 / SA-1264: the money on an invoice that is on file but not yet confirmed (a post-dated check is
 * PENDING). It is shown BESIDE `balanceDue` and never subtracted from it: the open amount stays
 * `confirmedBalance`. The one reader for the list row's `pendingAmount`.
 */
export function pendingAmountOf(
  payments: ReadonlyArray<{ amount: unknown; status?: string | null }> | null | undefined,
): number {
  return roundMoney(
    (payments ?? [])
      .filter((p) => p.status === "PENDING")
      .reduce((s, p) => s + Number(p.amount), 0),
  );
}
