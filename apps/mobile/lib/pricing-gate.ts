/**
 * B62 + B1038 (money): is the customer's pricing (their tier + per-product prices) usable by the order editor?
 * `ready` is true only when both queries SETTLED OK, or there is no customer (a disabled query stays pending forever).
 * A FAILED fetch is NOT ready: falling back to tier 1 would show and start lines at LIST while the server bills the
 * customer's tier price. `failed` drives the "Price unavailable" banner and its Retry.
 */
export function pricingGate(args: {
  customerId: string | undefined;
  customerPending: boolean;
  customerFailed: boolean;
  pricesPending: boolean;
  pricesFailed: boolean;
}): { ready: boolean; loading: boolean; failed: boolean } {
  if (!args.customerId) return { ready: true, loading: false, failed: false };
  const failed = args.customerFailed || args.pricesFailed;
  if (failed) return { ready: false, loading: false, failed: true };
  const loading = args.customerPending || args.pricesPending;
  return { ready: !loading, loading, failed: false };
}
