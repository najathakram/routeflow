# API landing 2026-10-18, fixes-4 (#3510, #3511)

Range `127bac4ce..32fbe0542` (master after the fixes-4 train), api side. Read at the tip; paths under `apps/api/src/` unless noted. Web: `web/landing-2026-10-18-fixes-4.md`; packages note at the end of `packages.md`. Tests not indexed. Earlier: `landing-2026-10-17-units-v2-3.md`.

## One web base for every return URL (#3510)

- `config/web-base-url.ts` (NEW) `webBaseUrl(env = process.env) -> string`: `WEB_URL`, then legacy `FRONTEND_URL`, trailing slashes stripped. Outside production an unset value gives `http://localhost:3001`; in production a missing, non-absolute-http(s) or loopback value (localhost, `*.localhost`, 127.x, 0.0.0.0, ::1) THROWS, never defaults.
- `config/web-base-url.ts` also: `assertWebBaseUrlAtBoot(env)` resolves once and, in production, writes the result back into `WEB_URL` so every direct `WEB_URL` reader (auth, tenants, email) sees the same value. `main.ts` `bootstrap()` calls it right after `assertSecrets()`, before anything listens.
- `config/configuration.ts` `urls.web` is `webBaseUrl()` (so `configuration()` throws in production without a usable base). `apps/api/.env.example`: `FRONTEND_URL` is now documented as a legacy name; leave it unset.
- Callers now using the helper instead of `FRONTEND_URL ?? localhost`: `billing/billing.service.ts` (checkout session, billing-portal return), `billing/catchup-checkout.service.ts` (`open()` joins the success and cancel PATHS to the base), `billing/settings-billing.controller.ts` (subscribe checkout URLs).
- `buyer/buyer-merge.service.ts` verify-merge link base is `webBaseUrl()` (was `WEB_APP_URL ?? NEXTAUTH_URL ?? localhost`).
- `billing/billing-notification.templates.ts`: the local `webBaseUrl` is replaced by `emailWebBase()`: nothing configured gives `https://www.routeflow.info`, else it delegates to the shared helper and falls back to the same domain if it throws; an email never carries a localhost link. `billingSettingsUrl()` uses it.
- `billing/payment-due.service.ts` `openSessionUrl` reads `success_url` / `cancel_url` of the stored Stripe session. New private `returnUrlsOffBase(tenantId, sessionId, session)`: true (and logs `return_url_off_base`) when either URL is not on the web base.
- `billing/payment-due.service.ts` an off-base session is stale even when its terms match: it takes the same Stripe-confirmed expire, release and recreate path. A lost race (`raced`) re-plans only when the verdict is not `match`; a matching winner with off-base URLs is still expired, never reused. `warnIfUnsignedAfterSigning` runs only for a non-match.

## Customer prices read strictly (units flag, SA-812a G-1)

- `billing/feature-override.service.ts` `get(tenantId, key, opts?: {strict?: boolean})`: default stays fail-open to null on a DB error; `strict: true` rethrows. `billing/entitlements.service.ts` NEW `hasFlagStrict(tenantId, flagKey)`: same order as `hasFlag` (override GRANT/DENY, then plan flags) but a failed override or plan read THROWS instead of answering false.
- `orders/units-prices-v2.ts` `UnitsPricesV2Deps.entitlements` is typed `{hasFlagStrict}` only (a plain `hasFlag` reader no longer compiles). `loadUnitsPricesV2`: a failed flag read with typed `CustomerUnitPrice` rows throws a coded 503 `CUSTOMER_PRICES_UNAVAILABLE` (nothing written, retryable).
- `orders/units-prices-v2.ts` `loadUnitsPricesV2`: a failed read with NO typed rows (only an odd raw tier) still prices as master (returns null); a clean `false` (DENY, never granted) prices as master as before. A deps object without `hasFlagStrict` returns null.
- `common/api-error-codes.ts` (+ the union in `packages/types/api/error-codes.ts`): NEW `CUSTOMER_PRICES_UNAVAILABLE` (503; buyer checkout, standing orders, returns, order edits).
- `orders/unit-line-edit.ts` NEW `preflightCustomerPrices(svc, order, dto, user, ctx)`: for OPERATOR, TENANT_ADMIN and CUSTOMER it runs the same `customerPricing` read over the payload, substitute and existing-line product ids, and discards the answer; a driver edit reads nothing.
- `orders/orders.service.ts` `updateOrderItems` calls `unitEdit.preflightCustomerPrices(...)` BEFORE the un-tx'd `revertLinkedInvoicesForOrderEdit` commits, so a 503 can never leave a SENT invoice mirror reverted to DRAFT with no re-sync.
- `order-templates/order-templates.service.ts` `generateDailyOrders` (06:00 `@LeaderCron`): per-template `attemptOne(tenantId, template, retry)` returns `created | skipped | held | failed`; `held` is the coded 503 (`isCustomerPricesUnavailable`). The cron includes `customer.businessName` in the load.
- `order-templates/order-templates.service.ts` after ALL tenants ran, held templates wait ONE `pause(CUSTOMER_PRICES_RETRY_BACKOFF_MS = 5000)` and are re-attempted once in their own tenant scope. A retry skips `suspendBannedLines` and the regulated-skip notice (`ctx.retry`), carries the first attempt's ban note, so the buyer gets one notice.
- `order-templates/order-templates.service.ts` NEW private `notifyStandingOrderHeldForPrices(template)`: a template still held after the retry tells the tenant's operators, best-effort ("use Generate now"). The held ban notice is deferred to the retry's outcome. Interface `DueTemplate` NEW.

## Carrier-in-transit guard shared (business-profile apply)

- `orders/carrier-in-transit-guard.ts` (NEW) `assertNoCarrierInTransit(db, tenantId, from, to)`: when the fulfilment model crosses `SHIPPING_FULFILMENT_MODES` and a SHIP order is open and shipped, throws 409 `FULFILMENT_CARRIER_IN_TRANSIT` with `count`; same-side change returns.
- `settings-fulfilment/settings-fulfilment.service.ts` update calls it inside its write under the lock (the inline count and `crossesShipping` are gone).
- `billing/business-profile.service.ts` apply (preview and confirm both re-plan) calls it for a planned `fulfilment_model` mode change before any write, so a platform-admin profile apply cannot re-point the billing moment with a carrier order in flight.

## Password policy and tooling

- Password DTOs: the symbol class of the `@Matches` rule is `[\d\W_]` (was `[\d\W]`), so `_` counts as a symbol. Files: `auth/dto/{change,reset,set}-password.dto.ts`, `buyer/dto/{buyer-change-password,buyer-register,buyer-reset-password,buyer-set-password}.dto.ts`, `platform-admin/dto/{create-tenant,create-tenant-admin}.dto.ts`, `tenants/dto/register-tenant.dto.ts`. The named missing-rule message is web side only.
- `scripts/db-lane.mjs` ends with `process.exitCode = main()` (was `process.exit(main())`) so a piped stdout is flushed, not truncated.
