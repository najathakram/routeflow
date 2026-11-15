// ─── Billing vocabulary + shared DTOs (WP1, lite-L2 lane) ──────────────────────
//
// Mirrors `apps/api/src/billing/plan-catalog.constants.ts`'s `FLAG_KEYS` — the API mirrors this
// locally rather than value-importing it (the API compiles to `dist/` via `nest build`, which
// does not bundle workspace deps; see that file's REG-743-F1 note), so the two are pinned
// set-equal by `apps/api/src/common/enum-parity.spec.ts`'s WP1 T2 case. Keep both lists in sync
// by hand.

import type { ApiErrorCode } from "./error-codes";

/** The 21 feature-flag / addon keys enforced server-side (pricing-plans.md §Feature-flag keys). */
export const FLAG_KEYS = [
  "flag.dispatch_live",
  "flag.returns",
  "flag.ap_bills",
  "flag.reports",
  "flag.credit_limits",
  "flag.settlement",
  "flag.pricing_tiers",
  "flag.analytics",
  "flag.forecasting",
  "flag.import_integrations",
  "flag.api_sso",
  "addon.buyer_portal",
  "addon.regulated_items",
  "addon.ocr",
  "flag.msrp",
  "flag.sales_agents",
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

/**
 * Mirrors `apps/web/lib/api/billing.ts`'s `SubscriptionView` (the 14 fields defined there) so
 * mobile can share the same shape instead of hand-declaring its own copy — the exact L-072 drift
 * class `packages/types/api/enums.ts` exists to prevent, applied here to a DTO instead of an
 * enum. Generic over `TDate` (default `string`, matching the web shape's ISO-string-over-the-wire
 * fields) so a consumer that parses dates client-side can instantiate `SubscriptionView<Date>`
 * instead of re-declaring the interface with `Date` substituted by hand.
 *
 * `flags` and `paymentRequired` are WP1 additions: `flags` is the resolved list of `FlagKey`
 * strings the tenant's current plan+addons grant (read by client-side gates instead of
 * re-deriving entitlement locally), and `paymentRequired` flags a subscription state where the
 * tenant must supply/update payment before continuing (e.g. converting off an invite-only trial).
 */
export interface SubscriptionView<TDate = string> {
  planKey: string;
  planName: string;
  status: string;
  cycle: "MONTHLY" | "ANNUAL";
  monthlyPrice: number | null;
  annualPrice: number | null;
  isCustom: boolean;
  renewalAt: TDate | null;
  cancelAtPeriodEnd: boolean;
  downgradeToPlanKey: string | null;
  downgradeEffectiveAt: TDate | null;
  trialEndsAt: TDate | null;
  /** Populated only when `status === "READ_ONLY"` — the enforcement reason the tenant-status
   *  guard recorded (`"trial_expired"` | `"subscription_cancelled"` | `"trial_cancelled"` | `"payment_overdue"` (SA-733r7: a dunning pause), or
   *  another server-defined string). `null`/absent renders the generic read-only copy. */
  readOnlyReason?: string | null;
  /** `comp: true` is an add-on RouteFlow granted free on purpose (SA-693): never billed, so `monthly` is
   *  null and the UI shows "Included", never a price. Absent (an older server) reads as a normal paid row. */
  addons: Array<{
    sku: string | null;
    name: string;
    quantity: number;
    comp?: boolean;
    monthly: number | null;
  }>;
  flags?: string[];
  /** SA-1099 A-4: the self-serve add-on SKUs this workspace already has the effect of (the plan or the courtesy serves
   *  every flag they grant, and it holds no row of its own). The add-on list shows each as "You already have this."
   *  with no price and no button. The server decides (`addonOfferState`); `[]` when its resolver cannot answer. Absent
   *  (an older server) reads as `[]`. A capacity SKU is never in it. */
  alreadyHaveAddonSkus?: string[];
  paymentRequired: boolean;
  /** SA-733r6 (B4) - the dunning clock and the banner's facts. All optional/null: a tenant that never failed a
   *  payment (and any older server) simply omits them, and the banner then shows the autopay card only. */
  /** When the first failed payment of the open invoice was stamped; day 0 of the 14-day grace. */
  pastDueSince?: TDate | null;
  /** The Stripe invoice the tenant owes; the Pay action is shown whenever this is set. */
  pastDueInvoiceId?: string | null;
  /** The oldest active TENANT_ADMIN's e-mail - who non-admins are told to contact (SA-776). Null when none, or
   *  when it is an internal sentinel address. There is deliberately NO name field: the User model has no display
   *  name and a username is never shown (the old `billingContactName` was the username and is gone). */
  billingContactEmail?: string | null;
  /** The owed invoice's amount remaining, in dollars (always printed as money). */
  openInvoiceAmount?: number | null;
  /** The card autopay will charge (brand / last4 / expiry); null when none or not a card. */
  paymentMethodSummary?: PaymentMethodSummary | null;
  /** What the next renewal charges and when (dollars, ISO date). */
  nextCharge?: { amount: number; date: TDate; dateLabel?: string } | null;
  /** The month the failed charge was for ("November") and the grace deadline ("Nov 8"), formatted by the SERVER in
   *  the tenant's zone - render verbatim, never re-derive a date in the browser's zone. */
  pastDueMonthLabel?: string | null;
  graceEndsLabel?: string | null;
  /** True only when the server will really pause an unpaid workspace (BILLING_PAUSE_MODE=enforced). In dark / off the
   *  banner never threatens a read-only date. */
  pauseEnforced?: boolean;
  /** SA-775 rollout: true when the rollout pause holds the automatic locks a banner would threaten (the unpaid-invoice
   *  pause, the trial expiry) for THIS tenant, so no banner may promise a read-only date. Computed by the server through
   *  the same gate the lock writers use; absent / false = today's copy. */
  autoLockHeld?: boolean;
  /** SA-777 - server-derived from the tenant's OPEN Stripe invoices (precedence processing > overdue > due >
   *  current). OMITTED, never zeroed, when Stripe could not answer: the UI then hides the amount and never says
   *  "current". `outstandingTotal` and `payNowUrl` are admins only (an operator's view omits them). */
  billingState?: "current" | "due" | "overdue" | "processing";
  /** Σ amount_remaining over the open invoices, dollars (integer cents converted once, server-side). */
  outstandingTotal?: number;
  /** A payment on an open invoice is still settling (a bank debit): the Pay control hides. */
  paymentProcessing?: boolean;
  /** "Oct 15": when the oldest owed invoice fell due / went overdue, formatted by the SERVER in the tenant's zone. */
  openInvoiceDueLabel?: string;
  /** The same moment as `openInvoiceDueLabel`, an ISO instant (a date, not money: staff keep it). SA-1150 S9. */
  openInvoiceDueAt?: string;
  /** The OLDEST owed invoice's hosted page (admins only; omitted while a payment is processing). */
  payNowUrl?: string;
  /** What `payNowUrl` collects (that one invoice's amount remaining, dollars): the Pay button's own figure. */
  payNowAmount?: number;
  /** How many open invoices make up `outstandingTotal` (the card's "Total open: $298.00 · 2 invoices" line). */
  openInvoiceCount?: number;
  /** How many of those are already settling (a bank debit); admins only, like the amounts. */
  settlingCount?: number;
}

/**
 * The 403 body of a write refused while the workspace is READ_ONLY (SA-776; `TenantStatusGuard`). `reason` is the
 * tenant's recorded `readOnlyReason` (null = set by an administrator). Clients compose their copy from the
 * subscription view through `@routeflow/types/read-only-copy` and never render `message`.
 */
export interface ReadOnlyErrorBody {
  /** Always `API_ERROR_CODES.READ_ONLY` (compare through the constant, never a literal). */
  code: ApiErrorCode;
  reason: string | null;
  message: string;
}

/** The autopay card shown on the Billing card ("Your Visa ending 4242 expires Oct 31"). */
export interface PaymentMethodSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** `POST /billing/portal` (TENANT_ADMIN): the Stripe portal to update the card, and - while an invoice is
 *  owed - its hosted page to pay it. */
export interface BillingPortalResult {
  /** Null when only the pay link could be produced (a portal outage never loses the pay link). */
  portalUrl: string | null;
  hostedInvoiceUrl: string | null;
}

/**
 * How a tenant's self-serve add-on is billed (`GET /billing/proration-preview` and the enable
 * response): STRIPE = prorated onto the next Stripe bill; MANUAL = the owner adds it to the next
 * manual invoice; UNBILLED = no Stripe subscription, so nothing is charged online. A TYPE only (no
 * runtime value), so the API's own `AddonBilling` aliases it with `import type` and the two can
 * never drift; the API must never value-import this package (prod boots from compiled CJS).
 */
export type AddonBillingMode = "STRIPE" | "MANUAL" | "UNBILLED";

/**
 * The body of `POST /billing/addons/:sku/enable`: what REALLY happened. `proratedNow` is Stripe's
 * own prorated figure for a STRIPE tenant (null when it could not be read back), 0 for UNBILLED and
 * null/0 for MANUAL; `subscription` is the refreshed subscription view.
 */
export interface EnableAddonResult {
  proratedNow: number | null;
  billing: AddonBillingMode;
  subscription: SubscriptionView;
}

/**
 * `GET /billing/payment-due` (OPERATOR and up): the dashboard's "payment due" banner read. The amount, the period
 * and the eligibility are decided by the API's catch-up planner; the web only prints them. `amountCents` is whole
 * cents (print it through `fromCents` + the money formatter, never `/ 100` by hand).
 */
export interface PaymentDueView {
  due: boolean;
  /** The period started before today (the tenant's zone): the banner says "past due". */
  pastDue: boolean;
  amountCents: number;
  /** "October 2026"; null when nothing is due. */
  periodLabel: string | null;
  /** ISO start of the period the payment covers; null when nothing is due. */
  periodStart: string | null;
  /**
   * SA-801 / SA-806: nothing is charged now but the card must be added by `cardBy`. `due` stays false. The banner
   * reads "Add your card before {cardBy} to keep RouteFlow running." / "You won't be charged until {chargeStartsOn}."
   * and the admin's Add card is the same `POST /billing/payment-due/pay`.
   */
  cardNeeded: boolean;
  /** ISO instant of the first charge (A; print it in the tenant's zone); null unless `cardNeeded`. */
  chargeStartsOn: string | null;
  /**
   * ISO instant of the card deadline D = A - 72 h (the planner's `termsHoldUntil`): the last instant the quoted terms
   * hold. Print its calendar day in the tenant's zone; null unless `cardNeeded`.
   */
  cardBy: string | null;
}

/**
 * Row 542c: the terms the banner showed, sent with the pay click. The API only COMPARES them with its fresh plan and
 * refuses a mismatch with 409 `PAYMENT_TERMS_CHANGED` (nothing created); they never price a session. Copy them
 * straight from the `PaymentDueView` on screen: an Add card banner is `{0, null, cardBy}`, a bill `{amountCents,
 * periodStart, null}`.
 */
export interface PaymentDueShown {
  amountCents: number;
  periodStart: string | null;
  cardBy: string | null;
}

/** `POST /billing/payment-due/pay` body. `shown` is optional for one release (absent = no precondition). */
export interface PaymentDuePayRequest {
  shown?: PaymentDueShown;
}

/** SA-1139: how a platform Checkout Session is shown. `hosted` = Stripe's page (a url); `embedded` = our page (a client secret). */
export const CHECKOUT_UI_MODE_VALUES = ["hosted", "embedded"] as const;
export type CheckoutUiMode = (typeof CHECKOUT_UI_MODE_VALUES)[number];

/**
 * SA-1139 R3: what every tenant-self checkout start answers. Exactly one of `checkoutUrl` and `clientSecret` is set,
 * chosen by `uiMode`: a client branches on `uiMode`, never on which field is null. The secret mounts Stripe's own
 * card form (card data never reaches us); it is returned only to the admin who asked and is never logged.
 */
export type CheckoutStart =
  | {
      uiMode: "hosted";
      sessionId: string;
      checkoutUrl: string;
      clientSecret: null;
      /** Hosted returns through Stripe's own `success_url` redirect, so there is nothing for the web to push. */
      returnPath: null;
    }
  | {
      uiMode: "embedded";
      sessionId: string;
      checkoutUrl: null;
      clientSecret: string;
      /**
       * SA-1154: where the web goes when the form completes, read by the server from the Stripe session it created
       * (its own `return_url` without `session_id`). The web pushes it only when it is one of
       * {@link BILLING_RETURN_PATHS}, and never works it out from the request.
       */
      returnPath: string;
    };

/**
 * SA-1154: the one allowlist of billing return addresses (a tenant lands on its billing page): a plan checkout, a
 * payment, and a card add (nothing was charged, so it must never land on the payment path). The web refuses an
 * embedded start whose `returnPath` is not an exact member.
 */
export const BILLING_RETURN_PATHS = {
  plan: "/settings/billing?checkout=success",
  pay: "/settings/billing?paid=1",
  cardAdd: "/settings/billing?paid=1&card=1",
} as const;

/** `POST /billing/payment-due/pay` (TENANT_ADMIN): the Stripe Checkout to send the admin to. */
export interface PaymentDuePayResult {
  checkoutUrl: string;
}

/**
 * SA-1146 B-4: one row of the Billing "Payments" list. `source` says where it came from: a card payment
 * (`stripe`, a paid Stripe invoice) or a RouteFlow invoice paid by hand (`routeflow`). `date` is an ISO instant the
 * web prints in the tenant's zone. `amount` is dollars, rounded by the API (never recompute on the client).
 * `receiptUrl` is Stripe's hosted invoice page, read live on every request and never stored; a RouteFlow row has none.
 */
export interface BillingPaymentRow {
  id: string;
  source: "stripe" | "routeflow";
  date: string;
  /** Dollars (the currency's major unit), rounded by the API. Null when the currency is unknown: never a wrong figure. */
  amount: number | null;
  currency: string;
  /** When it was paid: an ISO instant, or null when the source did not say. The order key stays `date`. */
  paidAt: string | null;
  /** "Paid {day}" day, formatted by the API in the tenant's zone (e.g. "Nov 1"); null with `paidAt`. */
  paidDayLabel: string | null;
  /** Stripe invoice number or the RouteFlow invoice number (`RF-YYYY-NNNN`); null when Stripe has none. */
  number: string | null;
  receiptUrl: string | null;
}

/**
 * `GET /billing/payments?cursor=`: up to `PAYMENTS_PAGE_SIZE` rows, newest first. `nextCursor` is an opaque
 * string (null on the last page). `stripeUnavailable` is true when the card payments could not be read: the rows are
 * then the RouteFlow ones only and the page must say so (it is never an empty list posing as "no payments").
 */
export interface BillingPaymentsPage {
  rows: BillingPaymentRow[];
  nextCursor: string | null;
  stripeUnavailable: boolean;
}
