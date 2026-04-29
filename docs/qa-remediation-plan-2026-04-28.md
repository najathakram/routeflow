# RouteFlow Remediation Plan — 2026-04-28

Companion to [`qa-audit-2026-04-28.md`](qa-audit-2026-04-28.md). Each finding includes:

- **Where** — file path(s) and line ranges
- **Issue** — observed symptom and root cause
- **Fix** — concrete code-level plan
- **Derived risks** — related bugs that share the same root cause or that the fix could trigger

Severity rubric: **S1** = blocks a primary flow; **S2** = functional gap; **S3** = polish/cosmetic.

Issues are grouped by severity, then by surface. Cross-cutting/architectural fixes are at the end.

---

## S1 Blockers

### F-04 · Buyer catalog and cart show `$0.00` for every product

**Where**
- [apps/mobile/app/(customer)/(tabs)/catalog.tsx:130-133](apps/mobile/app/(customer)/(tabs)/catalog.tsx) — reads `product.price`
- [apps/mobile/app/(customer)/orders/cart.tsx:100-102](apps/mobile/app/(customer)/orders/cart.tsx) — reads `item.unitPrice` (depends on the catalog's price)
- API source of truth: [apps/api/src/buyer/buyer-catalog.service.ts:6-20, 71-88](apps/api/src/buyer/buyer-catalog.service.ts) — `GET /buyer/products` returns `buyerPrice`

**Issue**
The buyer catalog reads `product.price` but the buyer-catalog endpoint returns the per-buyer price under the field `buyerPrice` (and a `basePrice` for the non-tier price). The catalog never reads either, so every card renders `$0.00`. Cart inherits the same `0` because items are added with `unitPrice: 0`. Order placement still works because the backend re-calculates pricing server-side from `buyerPrice` at order creation, which is why the order detail shows correct prices.

**Fix**
1. In `catalog.tsx`, read `product.buyerPrice ?? product.basePrice ?? 0` for both the rendered unit price and when adding to cart.
2. In `cart.tsx`, the `unitPrice` will then be correct end-to-end. No extra change needed once the catalog passes the right value.
3. Add a TypeScript type for the buyer-product DTO that mirrors `BuyerProduct` in `buyer-catalog.service.ts` so this kind of field-name drift fails at compile time. Put it in `apps/mobile/api/buyer-types.ts` (or wherever buyer types live) and import it from both screens.
4. Add an integration test: `GET /buyer/products` → assert response contains `buyerPrice`, and a unit test on the catalog renderer that asserts the price string for a known product.

**Derived risks**
- **F-04b · "Total Spend" stat shows `$0`** ([apps/mobile/app/(customer)/(tabs)/more.tsx:55](apps/mobile/app/(customer)/(tabs)/more.tsx)) — the dashboard.stats.totalSpend may aggregate from order line items that were stored at correct prices, in which case fixing F-04 won't fix this stat. Verify by inspecting the buyer dashboard endpoint that produces `totalSpend`. If it's derived from `Order.subtotal`/`Order.total`, the stat will be correct as soon as orders are placed at non-zero prices going forward, but historic $0 orders (placed during the audit) will always be miscounted. Decide whether to backfill or accept.
- **Cart total in placement confirmation** — if any code path uses the cart total locally for a user-facing summary, it will read `0` until F-04 lands.

---

### F-03 · Buyer "Cancel order" UI freezes on "Cancelling…" forever

**Where**
- [apps/mobile/app/(customer)/orders/[id].tsx:43-54, 128-134](apps/mobile/app/(customer)/orders/[id].tsx) — cancel handler and button label
- API: [apps/api/src/buyer/buyer.controller.ts:303-318](apps/api/src/buyer/buyer.controller.ts) — `POST /buyer/orders/:id/cancel` cancels then **deletes** the order

**Issue**
Two compounding bugs:
1. The buyer cancel endpoint cancels and then **hard-deletes** the order in a single call. Subsequent `GET /buyer/orders/:id` returns 404, and the order is gone from `GET /buyer/orders` too.
2. The frontend's cancel handler calls `cancelMut.mutate(...)`. On `onSuccess`, the order detail query refetches and 404s; the loading state (`isPending`) flips back to false but the screen is now showing "Order not found" empty space (or stays on the old data because the screen never re-renders). The button label is bound to `isPending` and so resolves to its idle text, but the user perceives it as stuck because there's no confirmation toast and no navigation away from the now-deleted record.

**Fix**
The cleanest fix is on both sides:

1. **API: stop deleting on cancel.** Change `cancelOrder()` in the buyer service to set status to `CANCELLED` and **return the cancelled order**, not delete it. Soft-delete or status-only is the correct semantics — buyers and operators should be able to see their cancellation history. The current behaviour is also why audit Buyer 1 had cancelled orders showing in the list (those were not deleted) but ORD-00010 disappeared (this one was). Pick one model and apply it consistently.
   - File: [apps/api/src/buyer/buyer.service.ts](apps/api/src/buyer/buyer.service.ts) (or wherever `cancelOrder` lives — search the controller's import).
   - Reuse the orders service's existing `changeStatus(orderId, "CANCELLED", userContext)` and remove the `deleteOrder()` call.

2. **Frontend: navigate after cancel.** In [apps/mobile/app/(customer)/orders/[id].tsx](apps/mobile/app/(customer)/orders/[id].tsx) `cancelMut.onSuccess`, push a toast ("Order cancelled") and call `router.replace('/orders')`. Even if the API still returned a 404 (status quo), the screen would recover.

3. **Frontend: handle 404 on the order-detail query.** In the `useBuyerOrder(id)` hook, if the response is 404, surface `isError` to the screen so the screen can render "This order is no longer available" with a Back-to-orders button. Don't leave the user staring at a stale "Cancelling…" screen.

**Derived risks**
- **F-03b · Lost cancellation history** — once cancel-deletes is removed, buyers will see their cancelled orders in the list. The list is currently sorted by date desc; a flood of old cancellations could push real orders off the first page. Add a default filter "Active" (Pending/Confirmed/OUT_FOR_DELIVERY/Delivered) or paginate properly.
- **F-03c · Operator-side reporting** — if any operator KPI counts "orders by status" and was tuned to the current behaviour (cancelled orders disappear), those KPIs will jump after this fix. Audit before merging.
- **F-03d · Foreign-key cascade** — if other tables (invoices, returns) reference `Order` and the deletion was cascading, leaving the order in place will surface those relationships. Verify the schema's `onDelete` rules.

---

### F-02 · Editing a CONFIRMED order does not revert it to PENDING

**Where**
- Operator: [apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx:84-108](apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx) — `save()` handler
- API: [apps/api/src/orders/orders.service.ts:512-660](apps/api/src/orders/orders.service.ts) — `updateOrderItems` only mutates line items
- (Buyer side does not have an edit UI at all — see F-16.)

**Issue**
When an operator changes line items on a CONFIRMED order and saves:
1. The line items endpoint persists the change.
2. The order's status field is left unchanged at CONFIRMED.
3. There is no audit/diff trail showing what changed, no notification to the assigned driver, and no UI cue to re-confirm.

A driver dispatched with an old pick list will deliver the wrong quantities with no alert. This is the highest-impact data-correctness defect in the audit.

**Fix**
1. **API: revert status on item change.** In `updateOrderItems`, when the order is in CONFIRMED, OUT_FOR_DELIVERY, or any post-PENDING state, after the items are updated:
   - Set status to `PENDING` (operator must re-confirm).
   - Write a new row to an `OrderEdit`/`OrderRevision` table with `{orderId, editedBy, editedAt, before: {...lineItemsSnapshot}, after: {...lineItemsSnapshot}, reason?}` so the diff is queryable. If the table doesn't exist, add it via Prisma migration.
   - If the order has been dispatched (assigned to a route stop / route run started), block the edit with a `409 Conflict` and a message asking the operator to recall the order first. This avoids the worst case of a driver in the field with a now-stale order.
2. **API: notify driver.** If a `RouteRunStop` exists for this order and is in `Pending`/`Skipped`, push a notification (websocket / push) to the driver: "Order ORD-00008 was edited — please re-check items before delivery."
3. **Frontend: surface the revert.** After save, refetch the order detail and show a toast: "Order saved — status reverted to Pending. Confirm again before dispatch." Re-render the order detail; the "Confirm order" / "Send for delivery" actions should reappear.
4. **Frontend: change-diff UI.** Add a section to the order detail that shows the latest revision's diff (added items, removed items, qty changes). Source from the new `OrderEdit` table. Also expose this on the driver's stop screen so the driver sees "items were edited at <time> — please verify".

**Derived risks**
- **F-02b · Editing items on a DELIVERED order** — should be blocked outright. Confirm `updateOrderItems` rejects DELIVERED orders. If not, add the guard at the same time.
- **F-02c · Cascading recalculation** — the order's `subtotal`, `total`, `tax`, and any associated invoice draft must recalculate when line items change. Verify the existing service does this; if not, that's part of the same fix.
- **F-02d · Standing-order-generated orders** — the auto-generated orders from "Order now" are PENDING. If the buyer or operator later edits one, this same status-revert logic must apply uniformly.

---

### F-01 · Dashboard "0 runs today" / "Dispatch Readiness 0%" hides active routes

**Where**
- [apps/mobile/app/(operator)/(tabs)/home.tsx:59-90, 195-216](apps/mobile/app/(operator)/(tabs)/home.tsx) — fetches route-runs with `date: today`; readiness is `runsRolling / runsScheduledToday`

**Issue**
The dashboard filters runs to today (`new Date().toISOString().slice(0, 10)`). Route A's run was seeded for 2026-04-27 but was still actively rolling on 2026-04-28 when the audit ran. Because the run's `scheduledDate` is yesterday, the filter excludes it, but the run is genuinely in-flight. The "Routes today" widget on the same dashboard does include it (different query), so the dashboard contradicts itself.

**Fix**
1. The run-counter and readiness should consider any run with status `IN_PROGRESS` or `SCHEDULED-for-today`, not just runs whose `scheduledDate == today`. Update the query to:
   ```ts
   where: { OR: [{ status: 'IN_PROGRESS' }, { scheduledDate: today, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } }] }
   ```
   This is two predicates: "currently rolling" OR "scheduled for today".
2. The KPI label should match the predicate. If you only count today + in-flight, label it "Active runs". Don't say "0 today" when there's clearly a run on the road.
3. Add a unit test against the dashboard service with fixtures: yesterday-IN_PROGRESS, yesterday-SCHEDULED, today-IN_PROGRESS, today-SCHEDULED, today-COMPLETED. Assert each is counted (or excluded) correctly.

**Derived risks**
- **F-01b · Timezone bug** — `new Date().toISOString().slice(0, 10)` is UTC. A driver in Sydney at 10am has UTC `00:00`-ish; a driver at 11pm Sydney has UTC of the next day. This can flip "today" arbitrarily for users near midnight UTC. Fix by passing the tenant's timezone explicitly or by deriving "today" on the API server with a known clock + offset.
- **F-01c · Other "today" KPIs** likely share this bug — any metric that filters by `scheduledDate = today`. Audit `home.tsx` and the API for similar predicates and fix in one pass.
- **F-01d · "0 Overdue invoices"** is a separate issue (F-05/F-13) but combined with F-01 the dashboard is essentially showing zeros for several KPIs simultaneously, which makes operators distrust the whole dashboard.

---

## S2 Functional Gaps

### F-05 / F-13 · "Overdue invoices" KPI shows 0 + Overdue filter empty

**Where**
- [apps/mobile/app/(operator)/(tabs)/invoices/index.tsx:68-72](apps/mobile/app/(operator)/(tabs)/invoices/index.tsx) — fetches with status filter
- [apps/mobile/app/(operator)/(tabs)/home.tsx:195-216](apps/mobile/app/(operator)/(tabs)/home.tsx) — KPI card

**Issue**
INV-2026-0007 was seeded with status `PAID` (not OVERDUE). Whatever filter the dashboard and Overdue tab use is correctly returning zero rows. The bug is **definitionally**: there is no rule that flips an invoice to OVERDUE when its `dueDate` passes; the status is whatever was last written.

**Fix**
1. **Definitional**: an invoice is OVERDUE if `status IN ('SENT')` AND `dueDate < today` AND `outstandingAmount > 0`. Treat OVERDUE as a *derived* status, not a stored one.
2. **API**: add a computed `isOverdue` field to invoice DTOs, or expose an `overdueCount` endpoint that uses the predicate above.
3. **Frontend**: the Overdue tab should filter where `isOverdue === true`. The dashboard KPI should hit the new endpoint or filter the same way.
4. If you keep OVERDUE as a stored status, you need a daily cron that flips SENT→OVERDUE when `dueDate` passes. That's more moving parts; the derived-field approach is simpler.

**Derived risks**
- **Aging buckets** — once overdue is computed, exposing 0–30 / 31–60 / 60+ aging buckets is a small follow-up. Worth doing.
- **Invoice list sort** — if the operator's primary need is "what's overdue", the default list sort should put overdue first.

---

### F-06 · Operator orders list doesn't auto-refresh

**Where**
- [apps/mobile/app/(operator)/(tabs)/orders/index.tsx:75-79, 124](apps/mobile/app/(operator)/(tabs)/orders/index.tsx) — `useAdminOrders()` with 30s `staleTime`; `RefreshControl` for manual pull

**Issue**
After cancelling, confirming, or creating an order, the list shows stale data. React Query's `staleTime: 30_000` plus no invalidation on mutations means the list is only fresh after 30s or a manual pull-to-refresh. Mutations on order detail don't invalidate the list cache.

**Fix**
1. After every order mutation (status change, cancel, edit, create), invalidate the orders list query:
   ```ts
   queryClient.invalidateQueries({ queryKey: ['adminOrders'] });
   ```
   Do this in each mutation hook's `onSuccess`. Simplest place is the shared `useChangeOrderStatus`, `useCreateOrder`, `useCancelOrder` etc. — set the invalidation there once.
2. Add focus-based refetch: `useAdminOrders` should set `refetchOnWindowFocus: true` so when the user nav-back to the list it refetches automatically.
3. (Optional, longer-term) Add a websocket or SSE channel for `orders.changed` events that invalidate the list. The operator dashboard is precisely the kind of surface that benefits from realtime.

**Derived risks**
- **F-06b · K7 across other lists** — same pattern probably exists on Routes, Invoices, Returns, Vendor Bills lists. Audit each: does the mutation hook invalidate the corresponding list query? Add `refetchOnWindowFocus: true` to all of them as a baseline.

---

### F-07 · Operator-created PENDING orders for the same buyer are not merged

**Where**
- API: [apps/api/src/orders/orders.service.ts](apps/api/src/orders/orders.service.ts) — order create flow
- Buyer-side merge logic exists somewhere in the buyer service or order create branch (audit confirmed buyer-portal merges; operator path doesn't)

**Issue**
Buyer-portal "Place order" merges new items into an existing PENDING order for the same buyer. Operator-created orders bypass this — each `POST /orders` creates a separate row. Inconsistent UX and data shape.

**Fix**
1. **Refactor**: extract the merge-into-existing-PENDING logic from the buyer flow into a shared helper in `OrdersService`:
   ```ts
   async createOrMerge(customerId, items, opts) {
     const existing = await prisma.order.findFirst({ where: { customerId, status: 'PENDING' } });
     if (existing) return this.appendItems(existing.id, items);
     return this.create({ customerId, items, ...opts });
   }
   ```
2. Operator's `POST /orders` should call `createOrMerge` by default; expose an explicit `forceNew=true` query param if the operator genuinely wants a separate order.
3. Or, simpler: keep the operator-create path as-is but show a "There is already a pending order for this buyer — merge or create new?" prompt in the operator UI before creating.

**Derived risks**
- **F-07b · Concurrent merges** — two operators (or one operator + one buyer) creating orders simultaneously could race and produce two PENDING orders again. Add a unique constraint `@@unique([customerId, status])` only on `(customerId, status='PENDING')` — Postgres supports a partial unique index. Or wrap `createOrMerge` in a transaction with `SERIALIZABLE` isolation.
- **F-07c · Standing-order-generated orders** — these are explicitly intended to be separate (audit confirmed they don't merge). Make sure the merge helper has an opt-out flag and standing orders pass it.

---

### F-08 · Purchase Orders list shows `$0.00`; detail shows "Expected Invalid Date"

**Where**
- List: [apps/mobile/app/(operator)/purchase-orders/index.tsx:147-164](apps/mobile/app/(operator)/purchase-orders/index.tsx) — `fmtCurrency(po.totalAmount)`
- Detail: [apps/mobile/app/(operator)/purchase-orders/[id].tsx:127-135](apps/mobile/app/(operator)/purchase-orders/[id].tsx) — `new Date(`${po.expectedDate}T00:00:00`).toLocaleDateString()`

**Issue (list)**
`po.totalAmount` is null/undefined on the list endpoint. The list response probably omits the calculated total (cost endpoint). Detail response has it correctly.

**Issue (detail)**
`po.expectedDate` may be null or already an ISO string. `new Date('null T00:00:00')` or `new Date('2026-04-29T00:00:00T00:00:00')` produces NaN → "Invalid Date".

**Fix**
1. **List**: Either include `totalAmount` in the list endpoint's PO DTO, or compute it on the client by summing `lineItems`. Server-side is cleaner — extend `PurchaseOrdersService.findAll` to project the sum.
2. **Detail**: Guard the date parsing:
   ```ts
   const expectedDate = po.expectedDate
     ? new Date(po.expectedDate).toLocaleDateString()
     : "Not set";
   ```
   Also stop appending `T00:00:00` — if the API returns a full ISO string, that double-suffix breaks parsing. Check what the API returns and parse accordingly. Use `date-fns` or `dayjs` for safe parsing.

**Derived risks**
- **Other date renderers** — search the codebase for `T00:00:00` to find any other location with the same defensive-but-broken parsing pattern.
- **Currency on other list endpoints** — Vendor Bills list, Expenses list, Invoices list. Audit each for the same DTO trim.

---

### F-09 / F-14 · "Add your API key in Settings → AI & Integrations" — section doesn't exist

**Where**
- API error string: [apps/api/src/vendor-bills/vendor-bills.service.ts:377](apps/api/src/vendor-bills/vendor-bills.service.ts)
- Settings UI: [apps/mobile/app/(operator)/(tabs)/more.tsx:40-159](apps/mobile/app/(operator)/(tabs)/more.tsx) — no "AI & Integrations" group

**Issue**
The error message tells operators to go somewhere that doesn't exist. Even if the operator wanted to self-serve, they'd have nowhere to put the key.

**Fix**
Two paths — pick one and stop saying both:

**Option A (per-tenant key, self-serve)**
1. Add a `Tenant.anthropicApiKey` (encrypted at rest) field. Migration + DTO.
2. Add an "AI & Integrations" section to Settings with one input ("Anthropic API key"), masked after entry, with a "Test connection" button that calls a `POST /settings/ai/test` endpoint and validates by making a 1-token Claude call.
3. The vendor bill service reads `tenant.anthropicApiKey` first, falls back to env if not set.

**Option B (platform-managed key)**
1. Set `ANTHROPIC_API_KEY` at infrastructure level (Railway env vars).
2. Update the error string to say "AI invoice scanning is temporarily unavailable. Please contact support." — don't leak the existence of a settings page that isn't there.

The audit recommends Option B in the short term (fastest path to fixing the UX gap) and Option A as a follow-up if you want self-serve.

**Derived risks**
- **F-09b · Cost control** — Option A means anyone with operator access can run scans against their own (or worse, your) Anthropic credits. Add per-tenant rate limiting, and pricing tiers if scan-invoice becomes a paid feature.
- **F-09c · Other AI features** — if there are any other Claude-powered features (chat, summarisation), they likely have the same key issue. Solve once, share the helper.

---

### F-10 · Driver detail shows "undefined undefined" as name

**Where**
- [apps/mobile/app/(operator)/driver.tsx:68](apps/mobile/app/(operator)/driver.tsx) — `${driver.user.firstName} ${driver.user.lastName}`

**Issue**
For audit-seeded driver accounts, both `firstName` and `lastName` are null. The UI literal-templates `null + ' ' + null` → `"undefined undefined"`. The Fleet view (1K) reads a different field that resolves correctly, which is why only the driver detail page shows this.

**Fix**
1. **Frontend**: write a `formatDriverName(driver)` helper:
   ```ts
   const fullName = [driver.user.firstName, driver.user.lastName].filter(Boolean).join(' ');
   return fullName || driver.user.username || 'Driver';
   ```
   Use this everywhere a driver name is shown.
2. **Breadcrumb**: same helper. The malformed breadcrumb ("Fleetundefined undefined · UX Route A") concatenates the back-label and driver name without a separator. Add a separator in the layout, or render them in two `<Text>` components.
3. **Schema**: optionally make `User.firstName` and `User.lastName` nullable=true (they probably already are) and add a `displayName` virtual that the API computes. Keeps the formatting logic out of every renderer.

**Derived risks**
- Audit every place that constructs a string with `${user.firstName} ${user.lastName}` — typically there are 5+ such sites in a NestJS codebase. Search for `firstName} ${`.

---

### F-11 · Delete stop returns 500

**Where**
- API: [apps/api/src/routes/routes.service.ts:198-205](apps/api/src/routes/routes.service.ts) — `removeStop` deletes from `routeStop` directly

**Issue**
`DELETE /routes/:id/stops/:stopId` invokes Prisma `routeStop.delete`. A `RouteRunStop` likely references the `RouteStop` row by foreign key. With `onDelete: Restrict` (default) the delete fails with a constraint violation, surfaced as 500.

**Fix**
1. **Prisma schema**: change `RouteRunStop.routeStop` relation to `onDelete: Cascade` (deletes the run-stop when the template stop is deleted). Or: change to `onDelete: SetNull` if the run-stop should retain a snapshot of the address even after the route is altered (probably the better choice — preserves audit trail for completed runs).
2. **Service**: pre-check whether any `RouteRunStop` for this stop is in `Delivered` or `InProgress` state — if yes, throw a 409 "Cannot delete a stop that has been delivered. Remove it from the route by reassigning the order instead."
3. **Migration**: add the schema change + a backfill migration if `SetNull` is the choice (set existing rows' `routeStopId` to null where the parent has been deleted via prior workarounds).

**Derived risks**
- **F-11b · Reorder stops** — if reorder also touches `RouteStop` rows and `RouteRunStop` references them by id rather than position, reordering on a route with an in-flight run could corrupt the run. Verify.
- **F-11c · Cascade on route delete** — the Routes detail has a "Delete route" action. If the cascade on `RouteStop` is now SetNull, the route delete might also start to fail. Audit the whole onDelete chain in one pass.

---

### F-12 / F-15 · "Optimize stops" / "Re-optimize from here" — no API call fires

**Where**
- Operator handler: [apps/mobile/app/(operator)/routes/[id].tsx:118-136](apps/mobile/app/(operator)/routes/[id].tsx) — `handleOptimize` calls `optimizeMut.mutate(id)`
- API: [apps/api/src/route-optimization/route-optimization.controller.ts:42-51](apps/api/src/route-optimization/route-optimization.controller.ts) — `POST /routes/:id/optimize` exists
- Driver handler: somewhere in the driver app (see below)

**Issue**
Audit confirmed clicking the button fires zero network requests. The handler exists and looks wired. The likely cause is one of:
- The button's `onPress` isn't bound to `handleOptimize` (typo, `onClick` instead of `onPress` on a non-Pressable, or wrapped in a disabled state).
- The mutation is gated by a precondition that silently early-returns (e.g., `if (!route?.stops?.length) return;` with a missing toast).
- The button is rendered behind another absolute-positioned element.

**Fix**
1. Read the button's JSX in `routes/[id].tsx`. Add a `console.log` (temporary) to confirm whether `handleOptimize` is even called. If yes, the fix is in the mutation; if no, the fix is in the JSX.
2. If the issue is a missing toast/feedback path, ensure `optimizeMut.mutate` has `onSuccess` (toast: "Stops re-ordered") and `onError` (toast with error). Without either, a successful but slow request looks like a no-op.
3. Same investigation on the driver app's "Re-optimize from here" button. The driver-side flow probably calls `POST /route-runs/:id/optimize-from-here` (or similar) — if missing, add it; if present, audit the wiring.

**Derived risks**
- The optimize endpoint exists but is untested in the audit (the button never called it). Add an API integration test that posts to `/routes/:id/optimize` and asserts the stops are re-ordered. If the algorithm is broken/missing, that test will catch it before the next audit.

---

### F-16 · Buyer has no edit UI on any order

**Where**
- [apps/mobile/app/(customer)/orders/[id].tsx](apps/mobile/app/(customer)/orders/[id].tsx) — order detail shows items + Cancel only

**Issue**
Buyers cannot modify their own orders at any status. Spec (per K8) says editing should be possible, with the order reverting to PENDING and showing a diff to the operator. Today the only way to change an order is to cancel and re-place — friction-y and loses the order number.

**Fix**
1. Add an "Edit items" action on the order detail when status is PENDING or CONFIRMED. Open a buyer version of `edit-items.tsx` (or share the operator one with role-aware affordances).
2. Wire the API: buyer endpoint `PATCH /buyer/orders/:id/items` that goes through the same orders.service `updateOrderItems`. Reuses the F-02 fix automatically — status reverts to PENDING and the diff is recorded.
3. Permissions: the buyer can only edit their own orders, and only when status ∈ {PENDING, CONFIRMED}. Guard at the controller level with a custom guard, not just at the service level.

**Derived risks**
- **F-16b · Pricing drift** — if a buyer adds a new item, the new line uses the *current* `buyerPrice` for that buyer (which may have changed since the original order). The diff UI must show "added: Apple Juice 1L @ $4.49 (current price)" so the operator sees the current-price snapshot.
- **F-16c · Inventory** — adding items to an in-flight order might exceed available stock. Validate at the API layer.

---

## S3 Polish

### F-17 · K3 · Edit-items screen layout

**Where**
- [apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx:127-136 (header), 266 (Sub button), 330-344 (footer)](apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx)

**Issue**
- Sub (substitute) button is in the same row as `−` qty `+`, making the row visually cluttered.
- Two save affordances: header "Save" and footer "Save changes".
- Product names truncated.

**Fix**
1. Move the Sub button to a kebab menu (3-dot) on the row, or to the line item's detail expansion. Keeps the row at qty controls only.
2. Pick one save button. The bottom "Save changes" is primary on mobile (thumb-reachable). Remove the header one (keep the header back/cancel only).
3. Increase the product name's width / set `numberOfLines={2}` and `ellipsizeMode="tail"` instead of single-line truncation. Or show the full name in a popover on tap.

**Derived risks**
- **Tablet width** — if the same screen is used on tablet (768+), the cramped row probably has plenty of space. Don't apply mobile fixes that break tablet. Use responsive breakpoints.

---

### F-18 · Status badge renders raw enum "OUT_FOR_DELIVERY"

**Where**
- [apps/mobile/app/(customer)/(tabs)/orders.tsx:28-37 (orderPill function)](apps/mobile/app/(customer)/(tabs)/orders.tsx) — switch with default that emits the raw enum

**Issue**
The switch handles PENDING/CONFIRMED/DELIVERED/CANCELLED; OUT_FOR_DELIVERY falls through to default which renders the raw enum text.

**Fix**
1. Add the missing cases:
   ```ts
   case 'OUT_FOR_DELIVERY': return { label: 'Out for delivery', variant: 'info' };
   ```
2. Replace the default with `{ label: humanize(status), variant: 'neutral' }` where `humanize` lowercases and replaces underscores with spaces. Now any future enum addition gets a usable label without a code change.
3. Audit other status renderers (operator orders list, driver stop screen, dispatch) for the same omission. Use a shared `formatOrderStatus(status)` helper across all of them.

**Derived risks**
- **Internationalisation** — once the helper centralises labels, it's the right time to wrap them in i18n (`t('order.status.outForDelivery')`). Don't redo this work twice.

---

### F-19 · Order filter tabs missing "Cancelled" and "Out for Delivery"

**Where**
- [apps/mobile/app/(customer)/(tabs)/orders.tsx:19-24](apps/mobile/app/(customer)/(tabs)/orders.tsx) — `FILTERS` array

**Fix**
Add the two filters. Decide whether to also add a "Cancelled" filter on the operator side (audit didn't check operator's filter completeness — verify before merging).

**Derived risks**
- A "Cancelled" filter on a list that previously hid cancelled orders (per F-03) will suddenly show a lot. Coordinate with F-03 rollout.

---

### F-20 · Standing order card lacks schedule + detail view

**Where**
- [apps/mobile/app/(customer)/standing-orders.tsx:67-70](apps/mobile/app/(customer)/standing-orders.tsx)
- Schema: `OrderTemplate.daysOfWeek Int[]` in [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma)

**Issue**
- Card shows name + item count. No frequency, no next-delivery date.
- Card body is not tappable; no detail view where the buyer can see items, change the cadence, or see history.

**Fix**
1. **Card subtitle**: render frequency as "Mon · Wed · Fri" derived from `daysOfWeek`. The component already references `t.frequencyLabel` — make sure the API returns it (compute server-side from `daysOfWeek` for stability). Also render "Next delivery: Wed 30 Apr".
2. **Detail view**: tap the card → `/standing-orders/:id` showing items, schedule, "Pause" / "Resume" / "Order now" / "Edit items" actions and history of recent generated orders.
3. **Schedule edit**: out of scope for first pass — readonly is fine. Phase 2.

**Derived risks**
- **History query** — the detail view's "recent orders" list needs an endpoint. Reuse `GET /buyer/orders?templateId=...` or add a dedicated `/standing-orders/:id/history`.

---

## Notes (worth tracking even if not failing)

These didn't block flows but are worth a small fix.

### N-01 · Native browser confirm dialogs throughout

**Where**
- Many places: cancel order, sign out, delete stop, "Order now" for standing orders, etc.

**Issue**
The app uses `window.confirm()` for destructive actions. Inconsistent with the in-app bottom-sheet pattern used elsewhere; also blocks automated testing (CDP can't dismiss).

**Fix**
- Replace each `window.confirm(...)` with the existing `<ConfirmSheet>` component (or whatever the in-app modal is named — search for an existing usage). Same primitive, consistent UX, automation-friendly.
- One PR per surface to keep diffs reviewable.

### N-02 · Sign-out doesn't clear all session tokens

**Where**
- Driver more menu sign-out logic
- Buyer more menu sign-out logic

**Issue**
Audit observed that signing out as a driver sometimes left a stale buyer JWT in localStorage (or vice versa), so the next page load picked up the wrong session. The two surfaces use separate token keys (`buyerAccessToken` vs the operator/driver JWT) and the logout handlers each only clear their own.

**Fix**
- Sign-out should clear: `buyerAccessToken`, `buyerRefreshToken`, `buyerActiveSeller`, the operator/driver token (whatever its key is), and `tenantSlug`. Wrap in a `clearAllSessions()` helper used by every logout path.

### N-03 · Direct URL to bogus resource silently redirects to /home

**Where**
- Operator surface: `/orders/nonexistent-id` → `/home` with no message.
- Buyer surface: similar.

**Issue**
Users typing/sharing URLs get no error feedback when an id is bad. Looks like the app is broken.

**Fix**
- Render a "Order not found" screen with a "Back to orders" button. Same for routes, customers, suppliers, etc. Use a single `<NotFound>` layout and have the ID-based screens render it on `isError && error.status === 404`.

### N-04 · Buyer invoice detail is minimal

**Where**
- Buyer invoice detail screen — shows Invoice #, Status, Total only.

**Fix**
- Add: line items breakdown (qty × price), subtotal, GST line, total, payment history (date + amount + method), download PDF button. The data is all already on the operator-side invoice detail; just expose it on the buyer endpoint.

### N-05 · Standing-order-generated order shows total inconsistent with line items

**Where**
- "Order now" on a standing order template generates an order whose total includes 10% GST but no GST line is rendered. Audit observed $85.73 total vs. $77.94 line-item sum.

**Fix**
- Render a GST line in the order detail's totals section. The data is already there (`order.tax`); the buyer screen just doesn't show it.
- Same issue probably affects ad-hoc orders — check the buyer order detail screen and add the GST line consistently.

### N-06 · Suppliers row opens edit form directly (no detail view)

**Where**
- [apps/mobile/app/(operator)/contacts/...](apps/mobile/app/(operator)/contacts/) (suppliers tab)

**Fix**
- Add a supplier read-only detail screen. Edit should be an explicit action.

### N-07 · Expense detail DETAILS section empty when category not set

**Fix**
- Render "Category: —" or hide the section entirely. Don't leave a header with no body.

---

## Cross-cutting / Architectural

### X-01 · Status formatting helper

Replace ad-hoc switch statements across the codebase with a single `formatOrderStatus()` (and `formatInvoiceStatus`, etc.) helper. Solves F-18 globally. Place at [apps/mobile/utils/formatStatus.ts](apps/mobile/utils/formatStatus.ts) (or wherever `utils` lives).

### X-02 · Currency / date formatters

Wrap `new Date(s).toLocaleDateString()` and `Number(x).toFixed(2)` in helpers that handle null/invalid input. Solves F-08 globally.

### X-03 · React Query cache invalidation discipline

Audit every mutation hook in the app. Each one should:
- Invalidate the corresponding list query in `onSuccess`.
- Set a sensible `staleTime` (30s is too long for active operator surfaces).
- Use `refetchOnWindowFocus: true` for interactive lists.

Solves F-06 globally.

### X-04 · Field-name contracts (DTOs)

The `buyerPrice` vs `price` field mismatch is a class of bug. Generate frontend types from the API DTOs (e.g., NestJS `class-transformer` + `openapi` schema → `openapi-typescript-codegen`) so renaming a field in the API breaks the frontend at compile time.

### X-05 · Status-revert on order edit (F-02 generalised)

Any state change that invalidates a downstream artefact (driver pick list, invoice draft) should:
1. Revert the parent's status to a pre-confirmation state.
2. Record an audit row in a generic `<Entity>Revision` table.
3. Notify dependents (drivers, invoice receivers) via push.

Don't solve this only for orders — apply the same pattern to invoice line edits, route stop changes, etc.

---

## Suggested Execution Order

Ordered by user impact × engineering cost. Phase 1 = ship this week.

**Phase 1 — S1 blockers (highest priority)**

1. F-04 — buyer catalog `$0.00` price (small JSX change, 30 min)
2. F-03 — buyer cancel-order UI (API + frontend, 2 hr)
3. F-02 — order edit status-revert (API logic + audit table migration, 1 day)
4. F-01 — dashboard date filter (API query change, 1 hr)

**Phase 2 — S2 functional gaps**

5. F-06 — orders list auto-refresh (cache invalidation pass, 2 hr)
6. F-11 — delete stop 500 (schema + service, 2 hr)
7. F-12/15 — optimize stops button (debug + wire, 1 hr)
8. F-13/05 — overdue invoices (derived field, 2 hr)
9. F-10 — driver name formatter (1 hr)
10. F-16 — buyer order edit UI (depends on F-02; 1 day)
11. F-07 — operator-side merge (refactor, 1 day)
12. F-08 — PO total/date (small, 1 hr)
13. F-09/14 — AI key path (decide A vs B, 1 day if A)

**Phase 3 — S3 polish + notes**

14. F-17 — edit-items layout
15. F-18 — status enum formatting
16. F-19 — missing filter tabs
17. F-20 — standing order schedule + detail
18. N-01 — replace `window.confirm`
19. N-02 — clear all tokens on sign-out
20. N-03 — 404 screens
21. N-04, N-05 — invoice detail / GST line
22. N-06, N-07 — supplier detail / expense category

**Phase 4 — Architectural**

23. X-01 status helpers
24. X-02 formatters
25. X-03 cache invalidation audit
26. X-04 DTO codegen
27. X-05 generalised status-revert pattern

---

## Verification Plan

After each phase, re-run a slimmed audit against the same `ux-audit-1777265477001` tenant:

- After Phase 1: re-test K1, K8, F-04, dashboard KPIs.
- After Phase 2: re-test K4, K5, K7, F-13, F-08, F-09.
- After Phase 3: re-test K3, K6 (re-confirm), F-19, F-20.
- After Phase 4: full audit re-run; should see 0 FAILs in audit categories.

Each phase merges with passing tests and a re-audit screenshot before the next phase starts.
