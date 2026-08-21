# Stripe Connect — buyer-initiated payments

## Context

Buyers can see what they owe but cannot pay. `/buyer/portal/[seller]/payments` renders a
read-only "How to pay" remittance card and a payment history; there is no payment action
anywhere in the buyer portal. Stripe exists in the codebase only for **SaaS billing** —
tenants paying RouteFlow for their subscription (`billing/stripe.service.ts`, one
platform-level `STRIPE_SECRET_KEY`). Nothing connects a tenant's own Stripe account, and no
money has ever flowed buyer → tenant.

Owner decision (2026-08-21): **Stripe Connect, Standard accounts, direct charges, no
application fee.** Each tenant links the Stripe account they already own; buyers pay that
account directly; RouteFlow never touches the funds and takes no cut.

Goal: a buyer looking at an unpaid invoice can either **pay by card** (Stripe) or **declare a
cash payment** that the tenant approves. A tenant recording a payment already reflects to the
buyer — that half works today and is not rebuilt.

## Design decisions

**Standard accounts over Express/Custom.** The tenant keeps their own Stripe dashboard,
handles their own payouts, disputes and compliance. RouteFlow only needs an OAuth link. With
no application fee there is no reason to take on Express's platform liability.

**Direct charges** (`stripeAccount` header on every call), so the charge, the customer and the
funds all live on the tenant's account. No `application_fee_amount`, no `transfer_data`.

**A separate `BuyerPaymentRequest` table — NOT a new `PaymentStatus`.** A declared-but-
unapproved cash payment must never be visible to the money ledger: `recomputeStatus` sums
`InvoicePayment` rows to decide PAID/PARTIAL, so a pending row inside that table would mark
invoices paid on a buyer's say-so. Adding a `PENDING` member to `PaymentStatus` would also
mean auditing every `status` filter in the codebase, and the DRAFT-payment trap
(`project_deep_dive_findings_2026-08-17`) is precisely this class of bug already biting. So a
request lives in its own table and an `InvoicePayment` is written **only** on approval (cash)
or on a verified webhook (card) — through the existing `recordPayment`, so numbering, status
recompute and the row lock all stay in one place.

## Prerequisites the owner must do in Stripe (blocks the connect flow, not the build)

1. Stripe Dashboard → **Connect → Get started**, platform type **Standard**.
2. Connect → Settings → **Integration**: copy the **client ID** (`ca_…`) and add the redirect
   URI `https://routeflowapi-production.up.railway.app/api/v1/settings/stripe-connect/callback`.
3. Developers → Webhooks → **Add endpoint**, "Events **on connected accounts**", URL
   `https://routeflowapi-production.up.railway.app/api/v1/billing/webhook/connect`, events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `account.updated`. Copy the signing secret.
4. Railway → `@routeflow/api` variables: `STRIPE_SECRET_KEY` (platform key, may already be
   set), `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`.

Test-mode keys are fine and preferable for a demo — Stripe's `4242…` test card then works.

## Work packages

### WP1 — Schema (one migration, additive)

- `TenantStripeConnect` — `tenantId` (unique), `stripeAccountId`, `livemode`,
  `chargesEnabled`, `detailsSubmitted`, `connectedAt`, `disconnectedAt`, `connectedByName`.
  Kept off `Tenant` so the connect state can be revoked and re-established without touching
  the tenant row, and so `account.updated` has an obvious landing place.
- `BuyerPaymentRequest` — `tenantId`, `customerId`, `invoiceId`, `buyerAccountId`, `amount`,
  `kind` (`CARD` | `CASH`), `status` (`PENDING` | `APPROVED` | `REJECTED` | `FAILED` |
  `EXPIRED`), `note`, `stripeSessionId`, `stripePaymentIntentId`, `invoicePaymentId`
  (set on approval), `decidedById`/`decidedByName`/`decidedAt`, `createdAt`.
  `@@unique([stripeSessionId])` so a replayed webhook cannot double-pay.

### WP2 — API: connect the account (`src/stripe-connect/`)

- `StripeConnectService` — wraps the existing `StripeService` client, adding `stripeAccount`
  to each call. `oauthUrl()`, `exchangeCode()`, `getStatus()`, `disconnect()`,
  `assertChargesEnabled()`.
- `StripeConnectController` (`@Roles(OPERATOR)`, so TENANT_ADMIN passes):
  `GET /settings/stripe-connect` (status), `POST /settings/stripe-connect/link` (OAuth URL,
  signed `state` carrying tenantId), `GET /settings/stripe-connect/callback` (public, verifies
  `state`, exchanges the code, stores the account, redirects to the web settings page),
  `DELETE /settings/stripe-connect`.

### WP3 — API: buyer pays

- `POST /buyer/invoices/:id/pay/card` → Checkout Session on the connected account
  (`mode: payment`, line item = the invoice balance, `metadata.invoiceId`,
  `success_url`/`cancel_url` back to the portal); records a `PENDING` CARD request; returns
  the session URL.
- `POST /buyer/invoices/:id/pay/cash` → records a `PENDING` CASH request with an optional
  note and emits the seller bell (mirrors `emitBuyerConnectRequest`).
- `GET /buyer/invoices/:id/payment-options` → `{ cardEnabled, balanceDue, pendingRequest }`
  so the portal can render the right buttons.
- Guard: balance must be > 0, invoice not VOID/DRAFT, no PENDING request already open.

### WP4 — API: the money actually moves

- `POST /billing/webhook/connect` — separate controller, its own signing secret, verifies with
  `constructEvent` then dispatches on `event.account`. On `checkout.session.completed` with
  `payment_status: "paid"`: look up the request by `stripeSessionId`, and inside one
  transaction mark it APPROVED and call `InvoicesService.recordPayment` with
  `method: CREDIT_CARD`, `reference: <payment_intent>`, `settledAt: now`. Idempotent on the
  unique `stripeSessionId` — Stripe retries webhooks and will replay this.
- `GET /payment-requests` + `POST /payment-requests/:id/approve` | `/reject` for the tenant.
  Approve writes the `InvoicePayment` (`method: CASH`) through `recordPayment`.

### WP5 — Web

- Tenant settings → a Stripe card: connect / disconnect, account id, charges-enabled badge,
  and a plain warning when charges are not yet enabled.
- Tenant → pending payment requests: list + approve/reject, surfaced on the bell.
- Buyer invoice detail → **Pay by card** and **I've paid cash** when a balance is due;
  a "payment pending approval" state once a request is open.
- Buyer payments page → pending requests alongside history.

### WP6 — Verification

- Unit: webhook idempotency (same session twice ⇒ one `InvoicePayment`), approval writes
  exactly one payment, a pending request never counts toward the invoice balance, cross-tenant
  request access is refused.
- Manual, in Stripe **test mode**: connect the demo tenant, pay an open demo invoice with
  `4242 4242 4242 4242`, confirm the invoice flips PARTIAL/PAID and the payment shows on both
  sides; then a cash declaration approved by the operator.

## Risks

- **Webhooks are the only proof of payment.** Never mark paid from the `success_url` redirect —
  a buyer can open it without paying.
- Connect OAuth `state` must be signed and single-use, or one tenant could bind another
  tenant's Stripe account.
- The demo tenant is on the test-tenant allowlist, but this touches shared `invoices.service`
  code paths used by live clients — nothing may change for a tenant with no Connect row.
