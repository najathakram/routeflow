# Web landing 2026-10-12 (MacBook lane pushed branches)

Pushed, not yet merged branches, symbols read at each branch tip. Paths are under `apps/web/` unless noted. Builds on `landing-2026-10-11-r4.md`. Tests are not indexed.

## Merged-draft POS confirm (`fix/row-311-pos-merge-draft-confirm`, `6614c7adf`)

- `lib/api/pos-orders.ts`: `usePosFinish()` mutation input gains `fromStatus?`; when it is `DRAFT` the flow is PATCH `PENDING`, then `CONFIRMED`, then `POST /invoices/from-order/:id`, because the API transition table has no DRAFT to CONFIRMED edge. The status PATCHes are not idempotent. NEW (module-private) `promotedAlready(orderId, err)`: on a 400/409 it re-reads `GET /orders/:id` and returns the order only if it reads PENDING or CONFIRMED; a CONFIRMED re-read skips the confirm PATCH.
- `orders/_components/CreateOrderModal.tsx`: `finishPosOrder(created, ..., merged?)` passes `created.status ?? merged.fromStatus` (a merge returns the target order, the merge prompt's status says whether it is still a DRAFT). `lib/pos-copy.ts` `POS_COPY.mergedConfirmMissing`.

## POS mode, web (`feat/pos-mode-p2-web`, `cc81fc79c`)

- Already an ancestor of master (landed via Release 4); see `landing-2026-10-11-r4.md` "POS mode". No new entries.

## Delivery + POS profile UI (`feat/sa2-delivery-pos-profile`, `df643f3f7`)

- `app/(platform-admin)/admin/tenants/[id]/page.tsx`: the feature console and the per-feature overrides sit under one collapsible "Advanced" section (`data-testid="setup-advanced"`, both children stay mounted when collapsed) below the business-profile picker. `_features/profile-plain-copy.ts` and `__fixtures__/profiles.fixtures.ts` gain the `delivery_pos` row.

## Dashboard KPIs never read unknown as zero (`fix/b1015-dashboard-kpi-unknown-v2`, `054378ebc`)

- `app/(dashboard)/dashboard/page.tsx`: order KPIs and the pipeline come from the server's own per-status `meta.total` at `limit: 1` (PENDING, CONFIRMED, OUT_FOR_DELIVERY, DELIVERED, CANCELLED, plus the SHIP-path ready, awaiting-tracking and shipped-this-week cards), never from counting a capped list. `UNKNOWN_KPI = "—"` renders for any figure whose request failed or is unanswered (`null` upstream); `shipCount(q)` returns `string | number` (the dash while unknown). NEW `PanelLoadError({ message, onRetry })`.
