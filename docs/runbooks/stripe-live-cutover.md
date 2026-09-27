# Stripe live-mode cutover

Moving the platform from Stripe **test** mode to **live** mode (#2437). Owner-run: every step
that touches production data or Railway variables is done by the owner, in this order.

- The purge (step 4) must run while the api is still on the **test** key. Once
  `STRIPE_SECRET_KEY` is a live key, test ids can no longer be verified.
- The variables (step 5) must be set **immediately** after the purge. Every minute the api stays
  on the test key, `ensureStripeCustomer()` or a Connect OAuth can mint a new test id the purge
  never saw. All the dashboard work is therefore done first (step 2), so steps 3–5 are one
  short, uninterrupted window.

## Prerequisites (do not start without all of them)

1. **#2446 merged AND deployed** (`@routeflow/api` deployment at `SUCCESS`). It reads the
   subscription period from the items and pins the Stripe `apiVersion`. Without it, a live
   `checkout.session.completed` fails with a 500 and the new `stripeSubId` is lost.
2. **#2441 merged and deployed before step 6.4** (tenants reconnecting Connect). Without it, the
   tenant "Connect Stripe" flow can offer the platform's own account.
3. A fresh-backup routine you can run on demand (step 3).
4. The current test values of the four Stripe secrets, saved in the password manager, for
   rollback.

## Why a purge

Every Stripe id stored today (`cus_…`, `sub_…`, `price_…`, `si_…`, Connect `acct_…`) was minted
by the test account. Stripe ids do not encode their mode, and
`BillingService.ensureStripeCustomer()` reuses a stored `TenantSubscription.stripeCustomerId`
as-is. After the flip, a tenant would check out in live mode against a test customer and fail.

`apps/api/scripts/purge-test-stripe-ids.mjs` retrieves each stored id with the **current test
key** and clears only the ids the test account returns with `livemode: false`:

| Table                 | Field(s)                          | Action                                                         |
| --------------------- | --------------------------------- | -------------------------------------------------------------- |
| `TenantSubscription`  | `stripeCustomerId`, `stripeSubId` | set to `NULL` when verified test                               |
| `TenantAddon`         | `stripePriceId`, `stripeItemId`   | set to `NULL` when verified test                               |
| `TenantStripeConnect` | `livemode = false`, still active  | `disconnectedAt = now()`, `chargesEnabled = false` (see below) |

- **Connect rows:** the purge keeps `stripeAccountId`. Unlike the in-app Disconnect, it does
  **not** deauthorize the account at Stripe and does not touch `pendingJti`. A test-mode
  authorization has no effect on the live platform.
- **Unproven ids:** an id the test account does not know (`resource_missing`), or that errors, is
  **not proven test-mode**. It is listed as skipped and never cleared. Investigate those by hand.
- **Live ids:** an id the test account reports as live makes `--apply` refuse outright.
- **`--exclude-tenant <slug,...>`:** drops every row of the named tenants before planning, so
  they can never be written. The owner supplies the slugs **at run time only**; never write a
  tenant slug into git, this runbook, a ticket or a PR. An unknown slug aborts the run.
- **Free-pilot rule:** the overdue sweep's `stripeSubId: { not: null }` filter in
  `billing.service.ts` is not touched. A cleared test subscription never charged anyone, so the
  tenant keeps being treated as a free pilot.
- **Atomic apply:** `--apply` runs in one transaction. Each update is compare-and-set on the value
  the dry run saw, so a row that changed meanwhile rolls the whole run back. Each change writes an
  `AuditLog` row (`action = billing.stripe_test_id_purged`, `meta.issue = "#2437"`, with the old
  values).

## Steps

### 1. Confirm the prerequisites

Check each item above. Record the #2446 deployment id and its `SUCCESS` status.

### 2. Stripe dashboard (live mode): everything before touching data

1. **Billing webhook.** Add the endpoint `https://<api-host>/api/v1/billing/webhook`.
   - Pin its **API version to `2026-08-26.dahlia`**, the `STRIPE_API_VERSION` #2446 pins in code.
     Payloads in any other version will not match what the handlers read.
   - Events: `checkout.session.completed`, `invoice.payment_succeeded`,
     `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.
   - Copy its signing secret (`whsec_…`).
2. **Connect settings.** Copy the live Connect client id (`ca_…`). Register the redirect URI
   `{API_PUBLIC_URL}/api/v1/settings/stripe-connect/callback`. It must be registered in **both**
   test and live mode.
3. **Connect webhook.** Add a Connect endpoint `https://<api-host>/api/v1/billing/webhook/connect`.
   - Pin the same API version.
   - Events: `payment_intent.succeeded`, `checkout.session.completed`,
     `checkout.session.expired`, `checkout.session.async_payment_failed`, `account.updated`,
     `charge.refunded`, `charge.dispute.created`, `account.application.deauthorized`.
   - Copy its signing secret.
4. **Add-on prices.** Create the live prices for any paid add-on.
   - Add-on grants take a `stripePriceId` from platform admin, and the test `price_…` ids do not
     exist in live mode.
   - Plan checkout uses inline `price_data`, so it needs no stored price ids.
   - The legacy `STRIPE_PRICE_STARTER/PROFESSIONAL/ENTERPRISE` variables are config-only.

Have the four live values ready to paste (step 5) before continuing.

### 3. Backup

Take a fresh production database backup with the standard Railway backup routine, and note its
id.

### 4. Purge the test ids (still on the test key)

1. **Dry run**, with the **current** test key. Name the tenants that must not be touched on the
   command line only:

   ```bash
   STRIPE_SECRET_KEY=sk_test_… railway run --service postgres node apps/api/scripts/purge-test-stripe-ids.mjs --exclude-tenant <slug,...>
   ```

   It prints:
   - the target (redacted);
   - the rows read and each `EXCLUDED` tenant (slug and UUID);
   - every planned change and every skipped id, each with its tenant's slug beside its UUID;
   - a **tenants touched** list and the change count `N`.

   Nothing is written.

2. **Owner's yes, per tenant.** Go through the **tenants touched** list one tenant at a time.
   Continue only if the owner has said yes to **every** listed tenant.
   - Any tenant with real, paying live billing must be in `--exclude-tenant` and must not appear
     in the list.
   - If one does appear, stop, add it to `--exclude-tenant` and re-run the dry run.

   Also review the skipped list.

3. **Apply** with the **same** `--exclude-tenant` value, typing back the count the dry run
   printed:

   ```bash
   STRIPE_SECRET_KEY=sk_test_… railway run --service postgres node apps/api/scripts/purge-test-stripe-ids.mjs --exclude-tenant <slug,...> --apply --backup-taken --confirm N
   ```

   The script refuses:
   - a live or missing key;
   - an unknown flag (exit 2) or an unknown exclude slug;
   - a count that doesn't match, or a missing `--backup-taken`;
   - any target other than the Railway proxy. Locally, `--local` accepts only a provably-local
     host.

### 5. Railway variables (`@routeflow/api`): immediately after step 4

Set all of them in one edit; the service redeploys once:

| Variable                        | Value                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`             | `sk_live_…`                                                                                       |
| `STRIPE_WEBHOOK_SECRET`         | the live billing webhook's `whsec_…` (step 2.1)                                                   |
| `STRIPE_CONNECT_CLIENT_ID`      | the live `ca_…` (step 2.2)                                                                        |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | the live Connect webhook's `whsec_…` (step 2.3)                                                   |
| `FRONTEND_URL`                  | the web origin (Checkout success/cancel and portal return URLs; defaults to localhost when unset) |
| `API_PUBLIC_URL`                | the public API origin (Connect OAuth redirect)                                                    |

Keep the test values in the password manager, not in Railway, so a rollback is a variable swap.

After the redeploy, re-run the step 4 dry run on the test key. It should show `changes: 0`
(nothing new was minted in the window).

### 6. Verify

1. Wait for the api deployment to reach `SUCCESS`, then run `npm run post-deploy-check`.
2. In the Stripe live dashboard, send a test event to each webhook endpoint and confirm a 2xx.
3. On a test tenant (`test`, `e2e-*`, `qa-*`), open Settings → Billing and start a checkout.
   - It should create a **new** live customer and never reuse a purged id.
   - Cancel it before paying.
4. **Only after #2441 is deployed:** tenants whose test Connect account was disconnected in step 4
   reconnect from the Stripe Connect card on the Settings page (live OAuth). Tell them before
   the cutover.

### 7. Follow up with the cleared tenants

List every tenant the purge touched, so each one re-checks out (or reconnects Connect) on live.
Run it read-only:

```sql
SELECT t.slug, a."entityType", count(*) AS changes, min(a."createdAt") AS purged_at
FROM "AuditLog" a JOIN "Tenant" t ON t.id = a."tenantId"
WHERE a.action = 'billing.stripe_test_id_purged'
GROUP BY t.slug, a."entityType"
ORDER BY t.slug;
```

- `TenantSubscription` rows: the tenant starts a new checkout on live when they choose a paid
  plan.
- `TenantAddon` rows: re-grant paid add-ons with the live price.
- `TenantStripeConnect` rows: the tenant reconnects (step 6.4).

The output names live tenants: keep it out of git, tickets and PRs.

## Rollback

Swap the four Stripe variables back to the test values. Purged ids are not restored
automatically. The old values are in each `AuditLog` row's `meta.cleared` and in the step 3
backup.
