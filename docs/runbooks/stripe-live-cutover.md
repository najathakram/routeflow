# Stripe live-mode cutover

Moving the platform from Stripe **test** mode to **live** mode (#2437). Owner-run: every step
that touches production data or Railway variables is done by the owner, in this order. The
purge in step 2 **must run before** step 4 — once `STRIPE_SECRET_KEY` is a live key, test ids
can no longer be verified.

## Why a purge

Every Stripe id stored today (`cus_…`, `sub_…`, `price_…`, `si_…`, Connect `acct_…`) was minted
by the test account. Stripe ids do not encode their mode, and
`BillingService.ensureStripeCustomer()` reuses a stored `TenantSubscription.stripeCustomerId`
as-is, so after the flip a tenant would check out in live mode against a test customer and fail.

`apps/api/scripts/purge-test-stripe-ids.mjs` retrieves each stored id with the **current test
key**. It clears only ids the test account returns with `livemode: false`:

| Table                 | Field(s)                          | Action                                                                                   |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `TenantSubscription`  | `stripeCustomerId`, `stripeSubId` | set to `NULL` when verified test                                                         |
| `TenantAddon`         | `stripePriceId`, `stripeItemId`   | set to `NULL` when verified test                                                         |
| `TenantStripeConnect` | `livemode = false`, still active  | `disconnectedAt = now()`, `chargesEnabled = false` (account id kept), as Disconnect does |

- An id the test account does not know (`resource_missing`) or that errors is **not proven
  test-mode**. It is listed as skipped and never cleared. Investigate those by hand.
- An id the test account reports as live makes `--apply` refuse outright.
- Free-pilot rule: the overdue sweep's `stripeSubId: { not: null }` filter in
  `billing.service.ts` is not touched. A cleared test subscription never charged anyone, so the
  tenant keeps being treated as a free pilot.
- `--apply` runs in one transaction. Each update is compare-and-set on the value the dry run saw,
  so a row that changed meanwhile rolls the whole run back. Each change writes an `AuditLog` row
  (`action = billing.stripe_test_id_purged`, `meta.issue = "#2437"`, with the old values).

## Steps

### 1. Backup

Take a fresh production database backup (the standard Railway backup routine) and note its id.

### 2. Purge the test ids (still on the test key)

Dry run, with the **current** test key:

```bash
STRIPE_SECRET_KEY=sk_test_… railway run --service postgres node apps/api/scripts/purge-test-stripe-ids.mjs
```

It prints the target (redacted), the rows read, every planned change, every skipped id, and the
change count `N`. Nothing is written. Review the skipped list before going on.

Apply, typing back the count the dry run printed:

```bash
STRIPE_SECRET_KEY=sk_test_… railway run --service postgres node apps/api/scripts/purge-test-stripe-ids.mjs --apply --backup-taken --confirm N
```

The script refuses a live key, a missing key, an unknown flag (exit 2), a count that doesn't
match, a missing `--backup-taken`, and any target other than the Railway proxy (locally, pass
`--local`, which accepts only a provably-local host). Re-running the dry run afterwards should
show `changes: 0`.

### 3. Stripe dashboard (live mode)

1. **Billing webhook**: add endpoint `https://<api-host>/api/v1/billing/webhook` with events
   `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy its signing secret
   (`whsec_…`).
2. **Connect**: copy the live Connect client id (`ca_…`). Register the redirect URI
   `{API_PUBLIC_URL}/api/v1/settings/stripe-connect/callback` in the Connect settings. It must be
   registered in **both** test and live mode.
3. **Connect webhook**: add a Connect endpoint `https://<api-host>/api/v1/billing/webhook/connect`
   with events `payment_intent.succeeded`, `checkout.session.completed`,
   `checkout.session.expired`, `checkout.session.async_payment_failed`, `account.updated`,
   `charge.refunded`, `charge.dispute.created`, `account.application.deauthorized`. Copy its
   signing secret.
4. **Add-on prices**: create the live prices for any paid add-on. Add-on grants take a
   `stripePriceId` from platform admin, and the test `price_…` ids do not exist in live mode.
   Plan checkout uses inline `price_data`, so it needs no stored price ids. The legacy
   `STRIPE_PRICE_STARTER/PROFESSIONAL/ENTERPRISE` variables are config-only.

### 4. Railway variables (`@routeflow/api`)

Set all of them together; the service redeploys once:

| Variable                        | Value                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`             | `sk_live_…`                                                                                       |
| `STRIPE_WEBHOOK_SECRET`         | the live billing webhook's `whsec_…` (step 3.1)                                                   |
| `STRIPE_CONNECT_CLIENT_ID`      | the live `ca_…` (step 3.2)                                                                        |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | the live Connect webhook's `whsec_…` (step 3.3)                                                   |
| `FRONTEND_URL`                  | the web origin (Checkout success/cancel and portal return URLs; defaults to localhost when unset) |
| `API_PUBLIC_URL`                | the public API origin (Connect OAuth redirect)                                                    |

Keep the test values in the password manager, not in Railway, so a rollback is a variable swap.

### 5. Verify

1. Wait for the api deployment to reach `SUCCESS`, then run `npm run post-deploy-check`.
2. In the Stripe live dashboard, send a test event to each webhook endpoint and confirm a 2xx.
3. On a test tenant (`test`, `e2e-*`, `qa-*`), open Settings → Billing and start a checkout. It
   should create a **new** live customer and never reuse a purged id. Cancel it before paying.
4. Tenants whose test Connect account was disconnected in step 2 reconnect from the Stripe Connect
   card on the Settings page (live OAuth). Tell them before the cutover.

## Rollback

Swap the four Stripe variables back to the test values. Purged ids are not restored
automatically. The old values are in each `AuditLog` row's `meta.cleared` and in the step 1 backup.
