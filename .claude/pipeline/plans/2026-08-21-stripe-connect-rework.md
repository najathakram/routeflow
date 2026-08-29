# Plan: Stripe Connect rework — close every confirmed review finding on PR #388

> Authored by Fable 5 on 2026-08-21. Status: SHIPPED
> This file is the ONLY context the implementation and review agents receive. It must stand alone.

## ⚠️ WORKING TREE — READ FIRST

ALL file paths in this plan are relative to the git worktree
**`C:\ClaudeCode\routeflow\.claude\worktrees\fix-unconfirm-reason`** (branch `reb-388`).
Edit files ONLY under that absolute path. The main checkout at `C:\ClaudeCode\routeflow` sits on a
DIFFERENT branch owned by another session — touching it corrupts unrelated work. Run every command
(`npx prisma generate`, tests) from inside the worktree, which has its own complete `node_modules`.

## Objective

PR #388 implements tenant→retailer payments (tenants link their own Stripe via Connect; buyers pay
invoices by card through Stripe-hosted Checkout, or declare cash) but an adversarial review
confirmed 8 blockers and ~11 majors against the approved architecture. This rework closes ALL of
them on the rebased branch. The approved invariants are restated inline below as acceptance
criteria — where the branch's committed plan file disagrees with them, THIS document wins.

Modules involved: `apps/api/src/stripe-connect/` (OAuth link/unlink + account status),
`apps/api/src/payment-requests/` (BuyerPaymentRequest lifecycle, checkout, webhook, settle),
web buyer portal `apps/web/app/buyer/portal/[seller]/payments/_components/MakePaymentPanel.tsx`,
operator approvals UI (find its callers of `/payment-requests`), Prisma schema + one NEW migration.
Money lands as `InvoicePayment` rows via the EXISTING `InvoicesService.recordStandalonePayment`
(allocation + excess→AdvancePayment) — that stays the only money writer.

## Constraints & conventions

- NestJS 11 + Prisma 7; Jest specs colocated (`*.spec.ts`), `Test.createTestingModule`, mock at
  module boundary. Prettier: semicolons, double quotes, printWidth 100, trailing commas.
- Money: dollars internally through `apps/api/src/common/pricing.ts` `roundMoney`; convert to
  Stripe cents in EXACTLY ONE place (the provider adapter). USD-only for v1: the adapter must
  `if (currency !== "usd") throw` rather than silently mis-convert zero-decimal currencies.
- Tenant scoping: every tenant-scoped Prisma access via `prisma.forTenant()` inside
  `tenantCtx.run(...)` (webhooks resolve tenant first, then enter the ALS context — mirror
  `recurring-invoices.service.ts` which does exactly this). Where a raw-client claim is
  unavoidable, the `where` MUST carry `tenantId` explicitly.
- The migration is AUTHORED, never executed. All schema additions nullable/additive. New
  migration folder must sort after `20260825000000_stripe_connect_buyer_payments`.
- Do NOT touch: the SaaS billing module's own controllers/services beyond removing the
  payment-requests dependency on them; `apps/mobile/**`; anything outside the two payment modules,
  the named web files, schema+migrations, and the two plan/docs files named in WP4.

## The approved invariants (= acceptance criteria the spec-compliance reviewer walks)

1. **Settlement event**: `payment_intent.succeeded` is the ONLY event that writes money. Checkout
   sessions are created with `payment_intent_data.metadata = { tenantId, buyerPaymentRequestId }`
   so the PI itself carries resolution metadata. `checkout.session.completed` may update request
   status display but never writes an InvoicePayment.
2. **Anti-spoof**: before any state/money write driven by a webhook, resolve the tenant from event
   metadata and REQUIRE `event.account === TenantStripeConnect.stripeAccountId` for that tenant
   (and that the row is connected/not disconnected). Mismatch → log CRITICAL, ack 200, write
   nothing.
3. **Event ledger**: new `StripeConnectEvent` table — `id` (Stripe event id, PK/unique),
   `accountRef`, `type`, `createdAt` (Stripe's `event.created`), `processedAt`, `outcome String?`.
   Insert-first (raw client, tenantless — pre-resolution); unique-violation ⇒ duplicate delivery ⇒
   ack and skip. `account.updated` applies only if `event.created` is newer than the last applied
   account event for that accountRef (query the ledger) — stale deliveries can no longer disable a
   live tenant's payments.
4. **Provider port**: `payment-requests/provider/payment-provider.interface.ts` defines the port;
   `stripe-payment-provider.ts` is the ONLY file in either module that imports the Stripe SDK or
   reads a `snake_case` Stripe field. Domain services speak typed normalized objects. The module
   constructs its own Stripe client from env (`STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`)
   — no import from the SaaS billing module.
5. **No second money path**: `cancelOwn`/`reject`/expiry handling NEVER record payments. Settle is
   reachable exclusively from the webhook handler's `payment_intent.succeeded` branch.
6. **Cancel-after-charge closed for real**: cancel of a CARD request must (a) always attempt
   `expireCheckout` when a session id exists — INCLUDING when the seller's account is currently
   not chargeable; (b) on expire failure, re-read the session: if `payment_status === "paid"` (or
   PI succeeded) the cancel is REFUSED — request stays PENDING for the webhook to settle; only a
   confirmed-open-then-expired or already-expired session may flip the row to CANCELLED/EXPIRED.
7. **Idempotent, non-reopening settle**: claim `PENDING → SETTLING` (conditional updateMany WITH
   tenantId); write money via `recordStandalonePayment`; then `SETTLING → SETTLED` storing
   `paymentGroupId` + `providerPaymentId` (the PI id). A crash between record and the final flip
   must NOT reopen to PENDING — on redelivery, a `SETTLING` row whose `providerPaymentId` already
   matches an existing recorded payment (look up `InvoicePayment` by reference = PI id, tenant
   scoped) completes the flip instead of re-recording. `claimed.count === 0` is treated as a
   benign replay ONLY when the row is already SETTLING/SETTLED; any other status (CANCELLED,
   FAILED, EXPIRED, REJECTED) logs CRITICAL "payment arrived for non-pending request", records the
   money anyway via `recordStandalonePayment` (money must never be silently discarded), and marks
   the row SETTLED with an `outcome` note.
8. **Race-proof open-request rule**: partial unique index
   `("tenantId","customerId") WHERE status IN ('PENDING','SETTLING')` in the new migration;
   `assertNoOpenRequest` stays as the friendly pre-check but the create catches the unique
   violation into the same BadRequest message.
9. **Amount truth**: settle records `min(requestRow.amount, providerAmount)` is WRONG — instead:
   if the provider-reported amount (from the PI, converted back to dollars) differs from the row's
   amount by ≥ $0.01, log CRITICAL and record the PROVIDER amount (it is what was actually
   charged), noting the discrepancy in the payment `notes`. Method mapping: PI
   `payment_method_types`/charge details `us_bank_account` → `ACH`, else `CREDIT_CARD`.
   `settledAt`: card → null (cash-basis falls back to `paidAt`); ACH → the success event's time.
10. **Status machine**: add `EXPIRED` handling — `checkout.session.expired` flips
    PENDING → EXPIRED (tenant-scoped claim); buyers with an EXPIRED request can start a new one
    (the partial unique index excludes EXPIRED).
11. **Refunds/disputes/deauthorize**: `charge.refunded`, `charge.dispute.created` → create a
    tenant Notification (reuse the existing notifications service pattern) + ledger `outcome`;
    NO automatic void (v1 manual per owner decision). `account.application.deauthorized` → mark
    the TenantStripeConnect row disconnected (clears chargeable flags) + Notification. Nothing in
    the switch may silently `default: break` an event type the endpoint subscribes to — log each
    ignored type once at debug level.
12. **OAuth single-use**: the Connect `state` JWT gains a `jti`; a `pendingJti` (+ issuedAt) is
    persisted on the TenantStripeConnect row (or a small table if the row may not exist yet — the
    row IS upserted at link time, so a column is fine); `completeOAuth` verifies signature AND
    consumes the jti atomically (conditional update jti→null; count 0 ⇒ reject "link expired").
    The public callback must never reflect internal exception text — map to a fixed set of
    user-safe error codes in the redirect query.
13. **Web**: `MakePaymentPanel` reflects the new statuses (SETTLING shows as processing; EXPIRED
    offers retry), and its stale comment claiming the cancel-after-charge hole is "still open" is
    replaced by one describing invariant 6. Buyer "status" query param on the list endpoint is
    validated against the enum (bad value → 400, not 500). `fromInvoiceId` is validated
    tenant+customer-scoped before being written to the FK.
14. **Throttle**: the webhook controller gets `@SkipThrottle()` (mirrors billing-webhook).

## Work packages (files DISJOINT; edit only under the worktree path above)

### WP1 — Provider port + module disentanglement

- **files:** `apps/api/src/payment-requests/provider/payment-provider.interface.ts` (new),
  `apps/api/src/payment-requests/provider/stripe-payment-provider.ts` (new),
  `apps/api/src/payment-requests/provider/stripe-payment-provider.spec.ts` (new),
  `apps/api/src/payment-requests/payment-requests.module.ts`
- **brief:** Define the port: `createHostedCheckout(req) → { sessionId, url }`,
  `readCheckout(accountRef, sessionId) → NormalizedCheckout { sessionId, paymentIntentId?, status: "open"|"complete"|"expired", paid: boolean, amount?, currency? }`,
  `expireCheckout(accountRef, sessionId) → { outcome: "expired"|"already_completed"|"already_expired" }`
  (the adapter maps Stripe's 400 "not open" by re-reading the session — never a swallowed error),
  `verifyEvent(rawBody, signature) → NormalizedConnectEvent` (typed union for
  pi.succeeded / session.completed / session.expired / account.updated / charge.refunded /
  dispute.created / account.application.deauthorized / other{type}), each carrying
  `eventId, accountRef, created`, and for pi.succeeded: `paymentIntentId, amountDollars,
methodKind: "card"|"us_bank_account"|"other", metadata`. Adapter owns the SINGLE cents
  conversion (`Math.round(roundMoney(d)*100)`, and back), throws on non-USD, and constructs its
  own `new Stripe(env)` — remove the module's import of the SaaS billing `StripeService`
  (invariant 4). Spec: cents round-trip, non-USD throw, expire-outcome mapping incl. the
  completed-session case, verifyEvent normalization per type.
- Checkout creation must set `payment_intent_data: { metadata: { tenantId, buyerPaymentRequestId } }`
  in addition to session metadata (invariant 1 depends on it).

### WP2 — Webhook layer: ledger, anti-spoof, PI settlement, account lifecycle

- **files:** `apps/api/src/payment-requests/connect-webhook.controller.ts`,
  `apps/api/src/stripe-connect/stripe-connect.service.ts`,
  `apps/api/src/stripe-connect/stripe-connect.controller.ts`,
  `apps/api/src/stripe-connect/stripe-connect.service.spec.ts` (new or extend),
  `apps/api/prisma/schema.prisma`,
  `apps/api/prisma/migrations/20260826000000_stripe_connect_event_ledger/migration.sql` (new)
- **brief:** Schema: `StripeConnectEvent` per invariant 3; partial unique index per invariant 8
  (`CREATE UNIQUE INDEX ... ON "BuyerPaymentRequest"("tenantId","customerId") WHERE status IN ('PENDING','SETTLING')`);
  add `BuyerPaymentRequest.providerPaymentId String?` and `outcome String?` and the `SETTLING`,
  `EXPIRED` enum values (check the existing status enum name); `TenantStripeConnect.pendingJti
String?` + `pendingJtiIssuedAt DateTime?`. Migration: additive; enum ADD VALUE statements first,
  un-wrapped. Controller: `@SkipThrottle()`; verify via provider port; insert-first ledger row;
  route typed events — pi.succeeded → WP3's `settleByPaymentIntent(evt)`;
  session.expired → WP3's `expireBySession`; account.updated → `syncAccountStatus` gated on
  ledger-ordering (invariant 3); refund/dispute/deauthorized per invariant 11 (anti-spoof check
  BEFORE each per invariant 2 — the cross-check helper lives in `stripe-connect.service.ts`:
  `assertEventAccount(tenantId, accountRef)`); unknown types → debug log + ledger outcome
  "ignored". OAuth: jti single-use per invariant 12; callback error-code mapping per invariant 12.
  Specs: duplicate event id ⇒ second delivery is a no-op; stale account.updated ⇒ not applied;
  account mismatch ⇒ nothing written + CRITICAL log; deauthorized ⇒ disconnected + notification;
  jti consumed once ⇒ replay rejected.

### WP3 — Request lifecycle + settlement in the domain service

- **files:** `apps/api/src/payment-requests/payment-requests.service.ts`,
  `apps/api/src/payment-requests/payment-requests.controller.ts`,
  `apps/api/src/payment-requests/payment-requests.service.spec.ts`
- **brief:** Swap all direct Stripe usage for the WP1 port (code against the interface; it is
  authored in a parallel package — match the signatures EXACTLY as written in WP1's brief).
  Implement `settleByPaymentIntent(evt)` per invariants 1/2/7/9 (tenant resolved from
  `evt.metadata.tenantId`, `tenantCtx.run`, claims carry tenantId, money only via
  `recordStandalonePayment`, non-reopening SETTLING semantics, amount-discrepancy rule, ACH
  mapping + settledAt convention). Rewrite `cancelOwn` per invariants 5/6 (no money path; always
  expire; refuse cancel on a paid session). Add `expireBySession` per invariant 10. Fix
  `assertNoOpenRequest` to also catch the unique violation (invariant 8). `approve`/`reject`
  claims gain tenantId predicates; every access moves to `forTenant()` or carries explicit
  tenantId (invariant + review finding). Controller: validate `status` query against the enum
  (400 on garbage); validate `fromInvoiceId` belongs to (tenant, customer) before persisting.
  Specs (extend the existing file): non-reopening settle crash-path (record succeeded, final flip
  fails, redelivery completes without double-record — assert recordStandalonePayment called ONCE);
  money-for-cancelled-row records anyway + CRITICAL; paid-session cancel refused; expire-flow;
  amount-mismatch records provider amount; ACH method/settledAt mapping; status-param 400.

### WP4 — Web panel, docs truth, ledger note

- **files:** `apps/web/app/buyer/portal/[seller]/payments/_components/MakePaymentPanel.tsx`,
  `apps/web/lib/api/payment-requests.ts` (or wherever the web hooks for /payment-requests live —
  locate by grep; list the actual file in your handback),
  `.claude/pipeline/plans/2026-08-21-stripe-connect-buyer-payments.md`,
  `.claude/code-map/api.md`
- **brief:** Web: statuses SETTLING ("Processing…", no cancel button) and EXPIRED ("Link expired —
  start again") per invariant 13; replace the stale cancel-after-charge comment; keep the panel's
  existing visual language. Plan file: rewrite the "Webhook & settlement" and "Risks" sections to
  document the AS-BUILT architecture = the invariants above (state explicitly that
  `payment_intent.succeeded` is the only money event and why the session-completed variant was
  rejected in review). Code map `api.md`: update the stripe-connect/payment-requests entries
  (provider port, event ledger, SETTLING/EXPIRED, anti-spoof) — surgical edit of those bullets
  only; do not touch other sections; do not edit `_meta.json` (the integrator bumps it).

## Verification commands (run FROM THE WORKTREE root `C:\ClaudeCode\routeflow\.claude\worktrees\fix-unconfirm-reason`)

- `npx prisma generate --schema apps/api/prisma/schema.prisma`
- `npx prisma validate --schema apps/api/prisma/schema.prisma`
- `npm run verify`

## Risks & rollback

- The feature is dormant until a tenant connects Stripe, so the blast radius pre-connection is
  zero; correctness still matters because the owner will connect real tenants.
- Highest-risk logic: the SETTLING crash-path. The spec pinning "recordStandalonePayment called
  exactly once across redelivery" is the non-negotiable test of this rework.
- Rollback: revert the branch; nothing deploys until merged; the new migration is additive.
