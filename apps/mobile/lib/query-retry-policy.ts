/**
 * Shared TanStack Query `retry` predicates. Kept free of any react-native-touching import (unlike
 * ./api/customers.ts, which pulls in api-client.ts -> react-native's Platform) so mobile's
 * pure-logic-only Jest lane (__tests__/*.test.ts) can import and pin these directly.
 */

/**
 * useCustomerPrices (Opus W/N, #1339): the pricing_tiers plan gate 403s for LITE/STARTER — the
 * default `retry: 3` would keep isFetching true through ~7s of exponential backoff (drafts.ts:29's
 * same pattern) before NewOrderScreen's resume-hydration effect could ever settle. A gated tenant
 * never gains the flag mid-retry: don't retry it.
 */
export function shouldRetryCustomerPrices(count: number, err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status !== 403 && count < 3;
}
