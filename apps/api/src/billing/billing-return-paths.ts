import { InternalServerErrorException, Logger } from "@nestjs/common";
import { webBaseUrl } from "../config/web-base-url";

/**
 * SA-1146 B-1 (B446): the ONE home of every Checkout success / cancel / return address the API builds. Each is a PATH
 * on the web base (`webBaseUrl()`), a page that exists: the Billing page, with a query the return notice reads.
 *
 * Compiled API code cannot value-import `@routeflow/types` (no-runtime-types-import.spec), so these are a local copy of
 * the shared `BILLING_RETURN_PATHS` / `BILLING_CANCEL_PATH` / `BILLING_PORTAL_RETURN_PATH`, pinned equal to them in billing-return-paths.spec.ts,
 * which also fails on any other `/settings/billing?...` literal in the API.
 */
export const API_BILLING_RETURN_PATHS = {
  plan: "/settings/billing?checkout=success",
  pay: "/settings/billing?paid=1",
  cardAdd: "/settings/billing?paid=1&card=1",
} as const;

/** Where the Stripe billing portal returns to (own constant: not a Checkout return path). */
export const API_BILLING_PORTAL_RETURN_PATH = "/settings/billing";

export const API_BILLING_CANCEL_PATH = "/settings/billing?checkout=cancelled";

/** `base` + `path` with exactly one slash between them. */
export function billingReturnUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

const logger = new Logger("BillingReturnPaths");

/** The `session_id` token Stripe fills in; the ONE suffix a success or embedded-return address may carry. */
const SESSION_ID_SUFFIX = "&session_id={CHECKOUT_SESSION_ID}";

export type BillingReturnKind = "success" | "cancel" | "embedded_return" | "portal";

/**
 * SA-1146 B-1 pin (b): the RUNTIME check at the two boundaries where a platform return address reaches Stripe
 * (`withCheckoutPolicy`'s output, and the StripeService portal wrapper). Exact string equality against the addresses
 * `billingReturnUrl(base, P)` builds, never "contains" or "starts with". Anything else is a code bug, so it fails closed:
 * a logged ERROR and a 500, never a business sent to a wrong page. A source scan cannot follow a value through a
 * shorthand, an alias, an assignment or a spread; this reads the final value.
 */
export function assertBillingReturnUrl(
  kind: BillingReturnKind,
  url: string,
  base: string = webBaseUrl(),
  tenantId?: string,
): void {
  const at = (p: string) => billingReturnUrl(base, p);
  let allowed: string[];
  if (kind === "success" || kind === "embedded_return") {
    allowed = Object.values(API_BILLING_RETURN_PATHS).flatMap((p) => [
      at(p),
      at(p) + SESSION_ID_SUFFIX,
    ]);
  } else if (kind === "cancel") {
    allowed = [at(API_BILLING_CANCEL_PATH)];
  } else {
    allowed = [at(API_BILLING_PORTAL_RETURN_PATH)];
  }
  if (allowed.includes(url)) return;
  // ONE line: the code, the kind, the address received (a concrete session_id redacted), the allowed list, the tenant.
  // Never a customer id or any card or payment value. The client gets a plain 500 with no address in it.
  logger.error(
    `BILLING_RETURN_URL_MISMATCH kind=${kind} received=${redactSessionId(url)} allowed=${JSON.stringify(allowed)} tenant=${tenantId ?? "unknown"}`,
  );
  throw new InternalServerErrorException("Billing return address is not allowed.");
}

/** A concrete `session_id=<value>` becomes `<redacted>`; the literal `{CHECKOUT_SESSION_ID}` template stays. */
function redactSessionId(url: string): string {
  return url.replace(/(session_id=)(?!\{CHECKOUT_SESSION_ID\}(?:&|$))[^&#\s]*/g, "$1<redacted>");
}
