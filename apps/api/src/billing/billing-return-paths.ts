/**
 * SA-1146 B-1 (B446): the ONE home of every Checkout success / cancel / return address the API builds. Each is a PATH
 * on the web base (`webBaseUrl()`), a page that exists: the Billing page, with a query the return notice reads.
 *
 * Compiled API code cannot value-import `@routeflow/types` (no-runtime-types-import.spec), so these are a local copy of
 * the shared `BILLING_RETURN_PATHS` / `BILLING_CANCEL_PATH`, pinned equal to them in billing-return-paths.spec.ts,
 * which also fails on any other `/settings/billing?...` literal in the API.
 */
export const API_BILLING_RETURN_PATHS = {
  plan: "/settings/billing?checkout=success",
  pay: "/settings/billing?paid=1",
  cardAdd: "/settings/billing?paid=1&card=1",
  portal: "/settings/billing",
} as const;

export const API_BILLING_CANCEL_PATH = "/settings/billing?checkout=cancelled";

/** `base` + `path` with exactly one slash between them. */
export function billingReturnUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}
