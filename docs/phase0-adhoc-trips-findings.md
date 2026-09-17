# Phase 0 findings — ad-hoc order trips (2026-08-24)

Recon notes from before implementing the ad-hoc trips + fulfillment-mode feature
(`.claude/pipeline/plans/2026-08-24-adhoc-order-trips.md`).

## Live check: optimize 400s on the demo tenant

Dispatch flow was verified live against `routeflow-demo` on 2026-08-24. Route
optimization returns `400` on that tenant. Root cause, confirmed live:

- Demo customer addresses were seeded with `lat = null` / `lng = null` — the
  Prisma seed script writes rows directly and bypasses the normal
  geocode-on-create path that runs for addresses created through the app.
- The optimize-time geocode fallback also failed — but NOT because the key is
  missing. **CORRECTED 2026-08-24 (probed live):** `GOOGLE_MAPS_API_KEY` IS set
  on the prod API (confirmed via the authenticated `GET /public/places/config`),
  and the Geocoding API rejects it with
  `REQUEST_DENIED: You must enable Billing on the Google Cloud Project`. The
  Places (New) autocomplete proxy 403s the same way. Every Google Maps feature
  (geocoding, address autocomplete) is dead on prod until Google Cloud billing
  is restored — same day GitHub Actions started refusing jobs over failed
  payments, so likely one shared payment method failed.

**Fix (this pipeline, WP13):** `apps/api/scripts/demo-seed.js` now writes
deterministic, idempotent Austin-area `lat`/`lng` coordinates on every demo
customer address (both the initial `create` and the `update` branch of the
upsert, so re-running the seed repairs existing null rows). With real
coordinates present, the optimizer's local NN+2-opt fallback works correctly
with no Google Maps API key.

**Owner action:** re-enable **Billing on the Google Cloud project** that owns
the `RouteFlowRoute` API key (console.cloud.google.com → Billing). No env-var
change is needed — the key is already set on the prod API. While billing is
down, geocoding and address autocomplete fail closed and the optimizer falls
back to seeded/stored coordinates.

## Driver payments are per-tenant opt-in (added 2026-08-24, same PR)

At-door money collection by drivers is now gated by the `driver_payments`
TenantAddon (owner direction: acme collects at the door; acme-distribution bills on
account only). Enforcement is `DriverPaymentsGuard` on
`POST /route-runs/:id/stops/:stopId/complete-with-payment` — body-aware, so
completions with no payment (or $0 "on account") keep working for every tenant;
only `payment.amount > 0` requires the addon. Mobile hides the collection UI
(method picker, keypad, payment photo) without the addon and completes on
account. **Rollout:** enable `driver_payments` for `acme` (platform-admin →
tenant → addons) at deploy time; `routeflow-demo` gets it from `demo-seed.js`;
every other tenant stays off (bills on account) until asked.

## ⚠️ Owner sign-off required: `fulfillPath` guard on the SCHEDULED dispatch sweep

The plan's acceptance criterion 3 says a SCHEDULED dispatch must produce a sweep
`where`-object deep-equal to the pre-feature one. The shipped code **deliberately
deviates** by one key — `fulfillPath: FulfillPath.ROUTE` in the
`order.updateMany` sweep in `apps/api/src/routes/routes.service.ts` (`createRun`).

**Why the deviation.** Without it, "Ships via carrier — won't appear on delivery
routes" (the copy shown on the orders list, order detail, and both customer/order
forms) would only be true for ad-hoc trips. A SHIP order would still attach to a
scheduled run, put a carrier-shipped delivery in front of a driver, and let them
complete the stop and take a delivery payment against goods they never carried.

**What the risk is.** Every EXISTING order is unaffected: the column defaults to
`ROUTE` and the migration performs no backfill. The exposure is on NEW orders —
`OrdersService.create` seeds `fulfillPath` from `Customer.fulfillPath`, a column
that has been writable through DTOs since launch while nothing read it. A live
tenant with a legacy customer row left on `SHIP` (from an import or an API
client) would silently see that customer's new orders drop off scheduled runs as
well as off trips.

**Pre-deploy audit (read-only, run before the app deploy).** From
`railway run --service postgres`:

```sql
SELECT "tenantId", count(*) FROM "Customer" WHERE "fulfillPath" = 'SHIP' GROUP BY 1;
```

Expect exactly one hit on `routeflow-demo` — `apps/api/scripts/demo-seed.js`
deliberately seeds one demo customer as `SHIP` to exercise the shipping path.
Any other row is unintended legacy data: reset it to `ROUTE` before deploying, or
confirm with that tenant that carrier shipping is genuinely wanted for it.

Owner decision needed: **accept the criterion-3 deviation** (keep the guard) after
the audit comes back clean, or say so and it gets reverted to the byte-identical
sweep, which re-opens the driver-takes-payment-on-a-carrier-shipment hole.

## Route PATCH "replace-all" landmine — confirmed absent from this feature's path

Checked whether `PATCH /routes/:id` (or any route-update path this feature
touches) replaces a route's stop list wholesale, which would be a landmine for
ad-hoc trip building/dispatch. It does not:

- `updateRoute` in `apps/api/src/routes/routes.service.ts` updates route
  scalars only (name, driver, date, depot, etc.).
- Stops are mutated exclusively through separate add/reorder/remove endpoints,
  each guarded against mutating a stop list while a run is active.

This landmine does **not** exist in the ad-hoc trips feature's path — stated
here for the record per the plan's Phase 0 note.
