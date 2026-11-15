import { Logger } from "@nestjs/common";
import type Stripe from "stripe";
import type { CheckoutStart, CheckoutUiMode } from "@routeflow/types";
import { webBaseUrl } from "../config/web-base-url";

/**
 * The ONE place a platform Checkout Session's tax / Managed Payments policy is applied (owner ruling
 * 2026-10-06: no tax on subscriptions; Stripe Managed Payments OFF).
 *
 * Why it must be explicit: on an account where Managed Payments is on by default, a create that says nothing
 * is treated as a Managed Payments session, which then demands a product tax code and fails (503 on the
 * catch-up checkout). Sending `managed_payments: { enabled: false }` opts the session out, whatever the
 * account default is. `SessionCreateParams.managed_payments` is typed by the pinned SDK (stripe ^22.6.2,
 * API `2026-08-26.dahlia`), so no type extension is needed.
 *
 * Every `checkout.sessions.create(` in `apps/api/src` passes its params through {@link withCheckoutPolicy};
 * `checkout-session-policy.pin.spec.ts` fails the build if one does not.
 *
 * SA-1037 r3 PR-1: the same chokepoint carries the ops switch for WHICH payment methods a platform session offers
 * ({@link checkoutPaymentMethodTypes}, env `BILLING_CHECKOUT_PAYMENT_METHODS`). Unset is today: the field is omitted
 * and the Stripe Dashboard decides.
 *
 * SA-1139 PR-1: the same chokepoint carries the ops switch for HOW a tenant-self session is shown
 * ({@link checkoutUiMode}, env `BILLING_CHECKOUT_UI`). Unset is today: Stripe's hosted page. The embedded keys are set
 * here and nowhere else (`checkout-session-policy.pin.spec.ts`).
 */

const logger = new Logger("CheckoutPolicy");

/** The one env var behind the payment-method switch (house shape of `BILLING_PAUSE_MODE`: an ops switch, one reader). */
export const CHECKOUT_PAYMENT_METHODS_ENV = "BILLING_CHECKOUT_PAYMENT_METHODS";

/** The accepted values and the `payment_method_types` each one sends. Anything else is treated as unset. */
const PAYMENT_METHOD_SETS = {
  card_and_bank: ["card", "us_bank_account"],
} as const satisfies Record<
  string,
  readonly Stripe.Checkout.SessionCreateParams.PaymentMethodType[]
>;

const warnedUnknown = new Set<string>();

/**
 * `payment_method_types` for a platform Checkout Session, from env `BILLING_CHECKOUT_PAYMENT_METHODS`:
 * unset, empty or unknown -> `undefined` (the field is omitted, so the Dashboard decides, as today; an unknown value
 * logs one warning per value); `card_and_bank` -> `["card", "us_bank_account"]`. A typo can never narrow what a tenant
 * is offered. Ops sets the env only after the Dashboard side is ready (SA-1037 r3 ruling 1).
 */
export function checkoutPaymentMethodTypes(
  env: Record<string, string | undefined> = process.env,
): Stripe.Checkout.SessionCreateParams.PaymentMethodType[] | undefined {
  const raw = (env[CHECKOUT_PAYMENT_METHODS_ENV] ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  if (Object.prototype.hasOwnProperty.call(PAYMENT_METHOD_SETS, raw)) {
    return [...PAYMENT_METHOD_SETS[raw as keyof typeof PAYMENT_METHOD_SETS]];
  }
  if (!warnedUnknown.has(raw)) {
    warnedUnknown.add(raw);
    logger.warn(
      `${CHECKOUT_PAYMENT_METHODS_ENV}="${raw}" is not a known value (card_and_bank); the payment methods are left to the Dashboard`,
    );
  }
  return undefined;
}

/** Thrown when a caller asks for what the owner ruling forbids (automatic tax or Managed Payments on). */
export class CheckoutPolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutPolicyViolation";
  }
}

/** The one env var behind the checkout-UI switch: `hosted` (default) or `embedded`. */
export const CHECKOUT_UI_ENV = "BILLING_CHECKOUT_UI";

/**
 * Who the session is for. `TENANT_SELF`: the tenant admin pays on our page, so the switch applies. `ADMIN_LINK`: the
 * platform admin hands a URL on, and an embedded session has none, so it is ALWAYS hosted. REQUIRED, never defaulted.
 */
export type CheckoutSurface = "TENANT_SELF" | "ADMIN_LINK";

/** Throws {@link CheckoutPolicyViolation} unless `surface` is a known surface (a JS caller; TypeScript refuses it at compile time). */
export function assertCheckoutSurface(surface: unknown): asserts surface is CheckoutSurface {
  if (surface !== "TENANT_SELF" && surface !== "ADMIN_LINK") {
    throw new CheckoutPolicyViolation(
      "a Checkout Session needs an explicit surface (TENANT_SELF or ADMIN_LINK)",
    );
  }
}

const warnedUnknownUi = new Set<string>();

/**
 * How a session for `surface` is shown, from env `BILLING_CHECKOUT_UI`: unset, empty, `hosted` or unknown -> hosted (an
 * unknown value logs one warning per value, so a typo can never turn embedded on); `embedded` (trimmed, any case) ->
 * embedded for `TENANT_SELF` only.
 */
export function checkoutUiMode(
  surface: CheckoutSurface,
  env: Record<string, string | undefined> = process.env,
): CheckoutUiMode {
  assertCheckoutSurface(surface);
  const raw = (env[CHECKOUT_UI_ENV] ?? "").trim().toLowerCase();
  if (raw && raw !== "hosted" && raw !== "embedded" && !warnedUnknownUi.has(raw)) {
    warnedUnknownUi.add(raw);
    logger.warn(
      `${CHECKOUT_UI_ENV}="${raw}" is not a known value (hosted, embedded); sessions stay hosted`,
    );
  }
  return raw === "embedded" && surface === "TENANT_SELF" ? "embedded" : "hosted";
}

export type WithCheckoutPolicy<T> = T & { managed_payments: { enabled: false } } & Pick<
    Stripe.Checkout.SessionCreateParams,
    "payment_method_types" | "ui_mode" | "return_url" | "redirect_on_completion"
  >;

/**
 * Returns `params` with `managed_payments: { enabled: false }` set (idempotent), every other key untouched, plus
 * `payment_method_types` from {@link checkoutPaymentMethodTypes} when the env names a set and the caller did not name its own.
 * Throws {@link CheckoutPolicyViolation} when the caller passed `automatic_tax.enabled: true` or
 * `managed_payments.enabled: true` - a silent rewrite would hide a policy change from review - or no `surface`.
 *
 * SA-1139: in embedded mode the session is `ui_mode: "embedded_page"` with `redirect_on_completion: "if_required"`; its
 * `success_url` becomes `return_url` (plus `session_id={CHECKOUT_SESSION_ID}`) and `success_url` / `cancel_url` are dropped
 * (Stripe refuses them). The caller's success_url is the ONE return guard: each caller builds it from its own safe base/path.
 */
export function withCheckoutPolicy<T extends Stripe.Checkout.SessionCreateParams>(
  params: T,
  opts: { surface: CheckoutSurface },
): WithCheckoutPolicy<T> {
  assertCheckoutSurface(opts?.surface);
  if (params.automatic_tax?.enabled === true) {
    throw new CheckoutPolicyViolation(
      "automatic_tax.enabled=true is not allowed on a Checkout Session (owner ruling: no tax on subscriptions)",
    );
  }
  if (params.managed_payments?.enabled === true) {
    throw new CheckoutPolicyViolation(
      "managed_payments.enabled=true is not allowed on a Checkout Session (owner ruling: Managed Payments off)",
    );
  }
  const paymentMethodTypes = params.payment_method_types ?? checkoutPaymentMethodTypes();
  const policy = {
    ...(paymentMethodTypes ? { payment_method_types: paymentMethodTypes } : {}),
    managed_payments: { ...params.managed_payments, enabled: false as const },
  };
  if (checkoutUiMode(opts.surface) !== "embedded") return { ...params, ...policy };

  const { success_url, cancel_url: _cancel, ...rest } = params;
  void _cancel;
  if (!success_url) {
    throw new CheckoutPolicyViolation(
      "an embedded Checkout Session needs a success_url to return to",
    );
  }
  const sessionParam = "session_id={CHECKOUT_SESSION_ID}";
  return {
    ...rest,
    ...policy,
    ui_mode: "embedded_page",
    redirect_on_completion: "if_required",
    return_url: success_url.includes("session_id=")
      ? success_url
      : `${success_url}${success_url.includes("?") ? "&" : "?"}${sessionParam}`,
  } as unknown as WithCheckoutPolicy<T>;
}

/**
 * SA-1154: the web path an EMBEDDED session returns to, read from the session's own `return_url` (the one Stripe
 * itself navigates to for a redirect-required method) with `session_id` removed. Throws when the session has no
 * `return_url` or it is not on the web base: the same rule as the off-base expiry of a stored session
 * (`payment-due.service` returnUrlsOffBase), so a path the web would push can never leave the web.
 */
function returnPathOf(session: { id: string; return_url?: string | null }): string {
  const url = session.return_url;
  if (typeof url !== "string" || url === "") {
    throw new Error(`embedded Checkout session ${session.id} returned no return_url`);
  }
  const base = webBaseUrl();
  if (!url.startsWith(`${base}/`)) {
    throw new Error(
      `embedded Checkout session ${session.id} has a return_url that is not on the web base`,
    );
  }
  const rest = new URL(url.slice(base.length), "http://web.invalid");
  rest.searchParams.delete("session_id");
  return `${rest.pathname}${rest.search}`;
}

/**
 * The shared answer of a tenant-self checkout start (SA-1139 R3), read from the session Stripe returned: its own
 * `ui_mode` is the truth of what was created, so the answer can never disagree with it. Never logs or echoes the
 * secret; a missing url (hosted) or secret (embedded) throws. SA-1154: an embedded answer also carries the
 * `returnPath` the session itself returns to (the only place that path is built); hosted answers `null`.
 */
export function checkoutStartFromSession(session: {
  id: string;
  url?: string | null;
  client_secret?: string | null;
  ui_mode?: string | null;
  return_url?: string | null;
}): CheckoutStart {
  if (session.ui_mode === "embedded_page") {
    if (!session.client_secret) {
      throw new Error(`embedded Checkout session ${session.id} returned no client_secret`);
    }
    return {
      uiMode: "embedded",
      sessionId: session.id,
      checkoutUrl: null,
      clientSecret: session.client_secret,
      returnPath: returnPathOf(session),
    };
  }
  if (!session.url) throw new Error(`hosted Checkout session ${session.id} returned no url`);
  return {
    uiMode: "hosted",
    sessionId: session.id,
    checkoutUrl: session.url,
    clientSecret: null,
    returnPath: null,
  };
}
