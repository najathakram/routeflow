# Stripe Connect — buyer payments, oldest-first allocation, statement visibility

## Context

Buyers can see what they owe but cannot pay. Stripe exists only for SaaS billing (platform
`STRIPE_SECRET_KEY`, not even set on prod). Owner decisions (2026-08-21):

1. **Stripe Connect, Standard accounts, direct charges, no application fee** — each tenant
   links their own Stripe account; buyers pay the tenant directly.
2. Buyers can alternatively **declare a cash payment**, which the tenant approves.
3. Tenant-recorded payments already reflect to the buyer (works today — not rebuilt).
4. **Payments apply to the OLDEST invoice first, then by age.** A payment is against the
   ACCOUNT, not one invoice; partial coverage of the last-reached invoice is expected and
   must be visible.
5. Both sides must clearly show: running balance, which payments applied to which invoices,
   partially-paid invoices, paid vs pending — and the buyer side needs an unmissable
   "Make a payment".

## What already exists (reuse, don't rebuild)

| Need                                | Existing mechanism                                                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One payment split across N invoices | `InvoicesService.recordStandalonePayment(StandalonePaymentDto)` — customer + totalAmount + method + `allocations[]`, writes an `InvoicePayment` per invoice sharing a `paymentGroupId`, `PAY-…` numbering, status recompute per invoice |
| Oldest-first allocation precedent   | AP mirror: `vendor-bills.service.ts` `paySupplier` (~1879) — allocates across bills oldest-first, excess becomes `SupplierCredit`                                                                                                       |
| Excess-over-balance landing place   | `AdvancePayment` (customer on-account credit) + `method: ADVANCE` application flow                                                                                                                                                      |
| Running-balance ledger, buyer side  | `GET /buyer/statement` (`StatementService`) → transactions with `runningBalance`; rendered at `/buyer/portal/[seller]/finances`                                                                                                         |
| Running-balance ledger, tenant side | Same `StatementService` (takes `customerId`), already imported by `customers.module`; customer file page renders it                                                                                                                     |
| Payment → invoice visibility        | `InvoicePayment.invoiceId` rows (grouped by `paymentGroupId`); buyer payments page + invoice detail already list them                                                                                                                   |
| Partial visibility                  | `InvoiceStatus.PARTIAL` + per-invoice `balanceDue` (derived in `findAll`)                                                                                                                                                               |
| Seller notification bell            | `gateway.emitBuyerConnectRequest` pattern                                                                                                                                                                                               |
| Stripe SDK + webhook verification   | `billing/stripe.service.ts`, `billing-webhook.controller.ts` (`rawBody` already enabled)                                                                                                                                                |

The genuinely new pieces: the Connect link, the buyer-initiated request objects, the
**oldest-first allocation builder**, the connect webhook, approve/reject UI, and the buyer
"Make a payment" UI.

## Design decisions

- **Standard accounts, direct charges** (`stripeAccount` header per call). No
  `application_fee_amount`, no `transfer_data`. Tenant keeps their own dashboard/payouts.
- **Account-level payments, strictly oldest-first.** Every buyer payment (card or declared
  cash) allocates `issueDate` asc (tie-break `invoiceNumber` asc) across open non-VOID/DRAFT
  invoices, capped per invoice at its balance due. The invoice-detail "Pay" button is just an
  entry point that prefills the amount with that invoice's balance — the UI states plainly
  that payments settle oldest invoices first. Card amounts are capped at the account balance
  (no card-created credit); a cash declaration above balance books the excess as
  `AdvancePayment` at approval, mirroring the AP flow.
- **A `BuyerPaymentRequest` table, NOT a new `PaymentStatus`.** A pending request must be
  invisible to the money ledger (`recomputeStatus` sums `InvoicePayment` rows; the
  DRAFT-payment trap is this class of bug). `InvoicePayment` rows are written only on
  approval (cash) or verified webhook (card), through `recordStandalonePayment`, so
  numbering/grouping/status stay in one place.
- **Webhooks are the only proof of card payment.** The `success_url` redirect proves nothing.
  Idempotency via unique `stripeSessionId` on the request row — Stripe retries webhooks.

## Owner prerequisites in Stripe (blocks go-live, not the build) — test mode is fine

1. Dashboard → Connect → Get started → platform type **Standard**.
2. Connect → Settings → Integration: copy **client ID** (`ca_…`); add redirect URI
   `https://routeflowapi-production.up.railway.app/api/v1/settings/stripe-connect/callback`.
3. Developers → Webhooks → Add endpoint → **"Events on connected accounts"**, URL
   `https://routeflowapi-production.up.railway.app/api/v1/billing/webhook/connect`, events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `account.updated`. Copy the signing secret.
4. Railway `@routeflow/api` env: `STRIPE_SECRET_KEY` (**currently unset**),
   `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`.

## Work packages

### WP1 — Schema (one additive migration)

- `TenantStripeConnect`: `tenantId` unique, `stripeAccountId`, `livemode`, `chargesEnabled`,
  `detailsSubmitted`, `connectedAt`, `disconnectedAt`, `connectedByName`.
- `BuyerPaymentRequest`: `tenantId`, `customerId`, `buyerAccountId?`,
  `invoiceId?` (**provenance only** — which screen it started from; allocation ignores it),
  `kind` (CARD|CASH), `status` (PENDING|APPROVED|REJECTED|FAILED|EXPIRED|CANCELLED),
  `amount`, `note?`, `stripeSessionId? @unique`, `stripePaymentIntentId?`,
  `paymentGroupId?` (set on approval → joins the written `InvoicePayment` rows),
  `failureReason?`, `decidedById/Name/At`, timestamps. Indexes on `[tenantId, status]`,
  `[customerId]`.
- Back-relations on Tenant, Customer, Invoice, BuyerAccount. Config: `stripe.connectClientId`,
  `stripe.connectWebhookSecret`.

### WP2 — API: account linking (`src/stripe-connect/`)

`StripeConnectService` (wraps existing `StripeService` client; signed single-use OAuth
`state` carrying tenantId; `assertChargesEnabled`). `StripeConnectController`:
`GET /settings/stripe-connect` · `POST /settings/stripe-connect/link` →
`GET /settings/stripe-connect/callback` (public; verifies state, `oauth.token` exchange,
upsert row, redirect to web settings) · `DELETE /settings/stripe-connect`.

### WP3 — API: allocation + buyer requests

- `buildOldestFirstAllocations(customerId, amount)` in `InvoicesService` (or a small
  `PaymentAllocationService`): open invoices → `AllocationDto[]` + `excess`.
- `GET /buyer/payment-context` → `{ balanceDue, cardEnabled, openInvoices: [{id, number,
issueDate, total, balanceDue, status}], pendingRequests }`.
- `POST /buyer/payments/card` `{ amount }` → assert Connect + charges enabled, cap at
  balance, Checkout Session on the connected account (metadata: requestId), PENDING CARD
  request, return session URL.
- `POST /buyer/payments/cash` `{ amount, note?, reference? }` → PENDING CASH request + seller
  bell.
- `POST /buyer/payments/requests/:id/cancel` (own, PENDING only).

### WP4 — API: money movement

- `POST /billing/webhook/connect` (own controller + `STRIPE_CONNECT_WEBHOOK_SECRET`).
  `checkout.session.completed` (`payment_status: "paid"`) → in one tx: request PENDING→
  APPROVED, `buildOldestFirstAllocations`, `recordStandalonePayment` (method CREDIT_CARD,
  reference = payment intent, settledAt = now), store `paymentGroupId` on the request.
  Replays no-op on the unique session id. `async_payment_failed` → FAILED.
  `account.updated` → sync `chargesEnabled`/`detailsSubmitted`.
- Tenant: `GET /payment-requests?status=` · `POST /payment-requests/:id/approve` (cash →
  same allocation path, method CASH; excess → `AdvancePayment`) · `/reject` (with reason).

### WP5 — Web

- **Tenant settings → Payments card**: connect/disconnect Stripe, status badges.
- **Tenant → payment requests**: pending list (bell + invoices area), approve/reject with
  allocation preview ("$X across INV-A, INV-B, $Y remains on INV-C").
- **Buyer finances page**: keep the statement; add a prominent **Make a payment** panel —
  balance due, amount input (default = full balance), "applies to your oldest invoices
  first" note with the computed allocation preview, then [Pay by card] / [I paid cash].
  Pending requests shown with status.
- **Buyer invoice detail**: Pay button → same panel prefilled with that invoice's balance.
- **Visibility audit** (mostly exists): per-invoice payment list shows its `InvoicePayment`
  rows; a grouped payment links to every invoice it touched (via `paymentGroupId`); PARTIAL
  rows show paid-vs-due. Only fill genuine gaps — do not rebuild the statement.

### WP6 — Verification

- Unit: allocation math (exact cover, partial tail, excess→advance, skips VOID/DRAFT/paid;
  ordering by issueDate then number); webhook idempotency (same session twice ⇒ one group);
  approval writes exactly once; pending request affects no balance; cross-tenant access
  refused; buyer of tenant-without-Connect sees `cardEnabled: false` and no card button.
- Manual on the demo tenant (Stripe test mode): connect → buyer pays $X covering 1.5
  invoices with `4242…` → oldest goes PAID, next PARTIAL, statement + both payment pages
  show the split; cash declare → approve → same; reject → nothing moves.

## Risks

- Never mark paid from redirect; webhook only.
- Signed single-use OAuth `state` or tenant A could bind tenant B's Stripe account.
- Shared `invoices.service` paths — behavior for tenants without a Connect row must be
  byte-identical (card UI hidden, cash declaration still fine? **No** — cash declaration is
  independent of Stripe and works for every tenant).
- `recordStandalonePayment` may reject over-allocation — excess handling verified/added in
  WP3, mirroring AP's excess→credit.
