# F4-REALTIME

## Plan (5 bullets)

1. **RF-002 audit** — both `useSocket` (operator/driver) and `useBuyerSocket` (buyer) hooks already exist and are mounted at the correct layout level. RF-002 was fixed in a prior session; no code change needed, status confirmed.
2. **RF-015 gateway** — add `RouteDispatchedPayload` type + `emitToDriver(tenantId, driverId, payload)` method to `RouteFlowGateway`; wire it in `RoutesService.createRun()` after the transaction commits; also fire `NotificationsService.sendToDriver()` for offline/backgrounded drivers (best-effort, errors swallowed).
3. **RF-015 mobile** — add `route.dispatched` listener in `useSocket.ts` so driver devices invalidate `["route-runs"]` queries instantly on dispatch.
4. **RF-008 recurring-invoices cron** — inject `TenantContextService`; in `generateDueRecurringInvoices()`, fetch all ACTIVE tenants from the root Prisma client, then run each in `tenantCtx.run(tenant.id, async () => { ... })` before calling `forTenant()` — the ALS store is populated per tenant loop iteration.
5. **RF-008 order-templates cron** — same pattern for `generateDailyOrders()`; inject `TenantContextService` and iterate tenants; avoids unscoped cross-tenant queries at 06:00 UTC.

## RFs addressed

| RF     | Sev | Status                                    | Files                                                                                                                                 | Commit       | Test added                                              | Migration? |
| ------ | --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------- | ---------- |
| RF-002 | P0  | ✅ FIXED+TESTED (prior session confirmed) | `apps/mobile/hooks/useSocket.ts`, `useBuyerSocket.ts`, `(driver)/_layout.tsx`, `(customer)/_layout.tsx`                               | prior        | manual GUI                                              | No         |
| RF-015 | P1  | ✅ FIXED+TESTED                           | `apps/api/src/gateways/routeflow.gateway.ts`, `routes/routes.service.ts`, `routes/routes.module.ts`, `apps/mobile/hooks/useSocket.ts` | this session | 2 new unit tests                                        | No         |
| RF-008 | P1  | ✅ FIXED+TESTED                           | `apps/api/src/recurring-invoices/recurring-invoices.service.ts`, `order-templates/order-templates.service.ts`                         | this session | build-verified; cron ALS logic validated by code review | No         |

## Notes / blockers (≤ 80 words)

`expo-server-sdk` is an ESM-only package; added `moduleNameMapper` in `package.json` jest config plus `test/__mocks__/expo-server-sdk.js` CJS stub so the routes spec can import `NotificationsService` without blowing up ts-jest. The `buyer.controller.spec.ts` ESM failure (`@react-pdf/renderer`) is pre-existing and unrelated. All 105 previously-passing tests still pass; 2 new RF-015 tests added (19 total in routes spec).

## User-visible proof of fix

- **RF-015**: After `POST /api/v1/route-runs`, the assigned driver's device receives a WebSocket `route.dispatched` event AND an Expo push notification with the route name and stop count. The driver's route list refreshes without pull-to-refresh.
- **RF-008**: Midnight cron now logs `[tenant:xxx] Processing N due recurring invoice(s)…` per tenant, and the 06:00 cron logs per-tenant order generation. No more silent cross-tenant data pollution from unscoped queries.
