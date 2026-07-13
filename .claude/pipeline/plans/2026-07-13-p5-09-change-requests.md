# Plan: P5-09 — Post-dispatch change-request engine (API only) `[money][compliance]`

> Authored by Fable 5 on 2026-07-13. Status: DRAFT
> This file is the ONLY context the implementation and review agents receive.
> Branch: `feat/p5-09-change-requests` (already created off master @ 7265c34). Repo root: `C:\ClaudeCode\routeflow`.

## Objective

Once an order's `RouteRun` dispatches, direct edits are refused with `409 EDIT_WINDOW_CLOSED` (P5-08, decision G7). This increment builds the engine that takes over past that point: a buyer or driver files a **`ChangeRequest`** against the dispatched order (`ADD_ITEM` / `CHANGE_QTY` / `REMOVE_ITEM` / `NOTE`); a driver at the stop (primary authority) or the office (only while PENDING) resolves it. **Approve-at-stop** merges the delta into the order's live line set — recorded via a `DeliveryMutation` row — so the existing `completeStop` delivery/invoice machinery bills the merged lines through the one existing money path. **Approve-as-next-delivery** (item not on the truck) drafts the line onto a new DRAFT order instead. **Decline** notifies the requester with the reason. All P5-08b guards (stock, credit, regulated license) re-run on approval (decision G6), and the **first resolution wins and locks** via an atomic conditional update. API only — the buyer UI (P5-10) and tenant/driver facilitation UI (P5-11) are separate later increments and must NOT be built here.

## Constraints & conventions

- **Stack**: NestJS 11 (`apps/api`), Prisma 7 + Postgres, Jest specs (`*.spec.ts`). Global route prefix `/api/v1`. `TENANT_ADMIN` satisfies `@Roles(UserRole.OPERATOR)` via the existing RolesGuard.
- **Money**: line subtotals ONLY via `computeLineSubtotal` from `apps/api/src/common/pricing.ts`; totals via `roundMoney`; box/piece splits via `normalizeBoxesPieces`. **Never `qty*unitPrice` for a boxed line** (over-charges by unitsPerBox). Existing lines keep their stored (agreed) `unitPrice` — never re-price an agreed line. New buyer lines price through the existing `resolveBuyerLinePrice` path (tier → sticky upsell → promo), never a new formula. The invoice merge happens **indirectly**: the approved delta lands on the order's `OrderItem` rows + the pending-mirror draft invoice is re-synced via `invoicesService.reconcileOrderDraftInvoice(orderId, { basis: "order" })`; the eventual `completeStop` (orders.service.ts:2561–2919) then bills delivered lines by copying/prorating **stored** subtotals (orders.service.ts:2822–2888). Do NOT write any new invoice-total arithmetic.
- **Tenant scoping**: every read/write through `this.prisma.forTenant()` or `this.prisma.tenantTransaction(fn)`. Bare `this.prisma.<model>` bypasses scoping — forbidden.
- **Actor snapshots are FK-less** (`requestedById/Name/Role`, `resolvedById/Name/Role`) — mirror `OrderRevision.editedBy*` (schema.prisma:1182–1202).
- **Migration**: additive only (new enums + one new table + back-relation fields). Repo `.gitignore` excludes `*.sql` → the migration must be staged with `git add -f`. **Do NOT apply the migration to any prod DB — prod apply is a separate user-gated step.** After editing `schema.prisma`, run `cd apps/api && npx prisma generate` so the new model/enums exist in `@prisma/client`.
- **No new npm dependencies.**
- **Existing tests must pass unmodified.** New tests only append.
- **Notifications**: use `NotificationsService` (`apps/api/src/notifications/notifications.service.ts` — `sendToCustomer(customerId, title, body, data?)` :140, `sendToUser(userId, payload)` :79), the same mechanism `completeStop` already uses (orders.service.ts:2937–2955), always `.catch(() => {})`. **Do NOT use `MessagingService.notify`** (`apps/api/src/messaging/messaging.service.ts:184`): it only sends when per-tenant `NotificationRule` + `MessageTemplate` rows exist and are enabled, and the P6-5 trigger wiring that seeds/uses them is not built — a call would silently no-op for every tenant. The `NotificationEvent.ORDER_CHANGED_AT_DOOR` enum value already exists (schema.prisma:2321) for P6-5 to wire later; leave a `// P6-5:` comment at the notify site.
- **What must NOT change**: the P5-08 edit gate in `updateOrderItems` (orders.service.ts:1622–1628) stays exactly as is; `completeStop`'s money path is untouched; no UI code; no changes to web/mobile.
- **Repo gotcha**: `prisma-mock.ts`'s `tenantTransaction` spreads the same model mocks as `forTenant()` — stubbing `prisma.changeRequest.updateMany` works inside and outside transactions.

### Architecture decision (state this in code comments too)

- **Create contract**: a **dedicated `POST /orders/:id/change-requests`** endpoint (not an opt-in flag on `updateOrderItems`). The existing `409 EDIT_WINDOW_CLOSED` from `PATCH /orders/:id/items` remains the client's signal to offer "request a change"; the create endpoint conversely refuses with `409 EDIT_WINDOW_OPEN` while the run is still `SCHEDULED` (direct edit still applies). This keeps both writers single-purpose and the G7 boundary crisp.
- **The at-stop merge lives on `OrdersService`** (`approveChangeRequestAtStop`) because it must reuse the private helpers `resolveBuyerLinePrice`, `loadActivePromotions`, `getCustomerPriceHistory`, `assertStockAvailableForEdit`, `assertWithinCreditLimit`, and `appendOrderRevision`. Lifecycle (create/list/decline/next-delivery/notify) lives in a new `ChangeRequestsService`.
- **Stock is never decremented by the merge** — mirrors the P5-08b edit posture ("edits never touch stock", orders.service.ts:2324–2345): the stock guard is validate-only; the real movement happens when `completeStop` calls `InventoryService.recordSale`.

## Work packages

Sequencing: WP1 first (schema + `prisma generate` unblocks compilation). WP2, WP3, WP4 are file-disjoint and can then run in parallel (all cross-file signatures are fully specified below). WP5 last.

---

### WP1 — Schema, migration, test-infra mock

- **files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260721000000_add_change_requests/migration.sql`, `apps/api/src/testing/prisma-mock.ts`
- **effort:** low
- **brief:** Add the `ChangeRequest` model + two enums to the schema, add back-relation fields on `Order`/`OrderItem`/`Product`/`RouteRunStop`/`Tenant`, hand-write the additive migration (folder name `20260721000000_add_change_requests` — sorts after `20260720000000_add_order_revisions`), add `changeRequest: modelProxy()` to the prisma mock. Then run `cd apps/api && npx prisma generate`. Stage the SQL with `git add -f apps/api/prisma/migrations/20260721000000_add_change_requests/migration.sql`. Do NOT run `prisma migrate deploy`/`migrate dev` against any remote DB.
- **exact code — schema additions** (place the model after `OrderRevision`, the enums next to `MutationType` ~line 105):

```prisma
enum ChangeRequestType {
  ADD_ITEM
  CHANGE_QTY
  REMOVE_ITEM
  NOTE
}

enum ChangeRequestStatus {
  PENDING
  APPROVED
  DECLINED
}

/// P5-09: post-dispatch change request. Created when the G7 edit window is
/// closed (order's RouteRun dispatched) and a buyer/driver wants a change.
/// Resolution authority (G6): driver-at-stop primary; office only while
/// PENDING; FIRST resolution wins and locks (atomic conditional update).
/// `payload` is the typed delta:
///   ADD_ITEM   { productId, qty, boxes?, pieces?, productName }
///   CHANGE_QTY { orderItemId, newQty, productName }
///   REMOVE_ITEM{ orderItemId, productName }
///   NOTE       { text }
/// Actor fields are immutable FK-less snapshots (mirror OrderRevision).
/// `resolution` = MERGED_AT_STOP | NEXT_DELIVERY | DECLINED;
/// `nextOrderId` = plain pointer (no FK) to the next-delivery draft order.
model ChangeRequest {
  id               String              @id @default(uuid())
  tenantId         String?
  orderId          String
  orderItemId      String?
  productId        String?
  routeRunStopId   String?
  type             ChangeRequestType
  status           ChangeRequestStatus @default(PENDING)
  payload          Json
  note             String?
  requestedById    String?
  requestedByName  String?
  requestedByRole  String?
  resolvedById     String?
  resolvedByName   String?
  resolvedByRole   String?
  resolution       String?
  resolutionReason String?
  nextOrderId      String?
  resolvedAt       DateTime?
  createdAt        DateTime            @default(now())
  updatedAt        DateTime            @updatedAt

  order        Order         @relation(fields: [orderId], references: [id], onDelete: Cascade)
  tenant       Tenant?       @relation(fields: [tenantId], references: [id])
  orderItem    OrderItem?    @relation(fields: [orderItemId], references: [id], onDelete: SetNull)
  product      Product?      @relation(fields: [productId], references: [id], onDelete: SetNull)
  routeRunStop RouteRunStop? @relation(fields: [routeRunStopId], references: [id], onDelete: SetNull)

  @@index([tenantId])
  @@index([orderId])
  @@index([status])
  @@index([routeRunStopId])
  @@index([createdAt])
}
```

Back-relations (append one line to each model's relation block): `Order` (~:1160) `changeRequests ChangeRequest[]`; `OrderItem` (~:1247) `changeRequests ChangeRequest[]`; `Product` (~:798, next to its `deliveryMutations DeliveryMutation[]`) `changeRequests ChangeRequest[]`; `RouteRunStop` (~:1106) `changeRequests ChangeRequest[]`; `Tenant` (next to `orderRevisions OrderRevision[]` :373) `changeRequests ChangeRequest[]`.

- **exact code — `migration.sql`** (mirror the OrderRevision migration style):

```sql
-- P5-09: post-dispatch change-request engine. Additive-only — two new enums +
-- one new table; no existing column/row changes, no backfill.
CREATE TYPE "ChangeRequestType" AS ENUM ('ADD_ITEM', 'CHANGE_QTY', 'REMOVE_ITEM', 'NOTE');
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "productId" TEXT,
    "routeRunStopId" TEXT,
    "type" "ChangeRequestType" NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "note" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "requestedByRole" TEXT,
    "resolvedById" TEXT,
    "resolvedByName" TEXT,
    "resolvedByRole" TEXT,
    "resolution" TEXT,
    "resolutionReason" TEXT,
    "nextOrderId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChangeRequest_tenantId_idx" ON "ChangeRequest"("tenantId");
CREATE INDEX "ChangeRequest_orderId_idx" ON "ChangeRequest"("orderId");
CREATE INDEX "ChangeRequest_status_idx" ON "ChangeRequest"("status");
CREATE INDEX "ChangeRequest_routeRunStopId_idx" ON "ChangeRequest"("routeRunStopId");
CREATE INDEX "ChangeRequest_createdAt_idx" ON "ChangeRequest"("createdAt");
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_routeRunStopId_fkey" FOREIGN KEY ("routeRunStopId") REFERENCES "RouteRunStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- **prisma-mock**: add `changeRequest: modelProxy(),` to `allModels()` (after `orderRevision:` at prisma-mock.ts:66) **and** to the (currently unused, keep-consistent) `txModels()` block (:159).

---

### WP2 — The approve-merge money path on `OrdersService`

- **files:** `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.service.spec.ts`
- **brief:** Add two public methods to `OrdersService` — `approveChangeRequestAtStop(crId, resolver, reason?)` (the full at-stop merge, exact code below) and `assertCreditForProjectedOrder(customerId, excludeOrderId, projectedTotal)` (one-line public wrapper over the private credit guard, used by WP3's next-delivery path). Add `changeRequests` to `findOne`'s include so order payloads carry their CRs. Add `ChangeRequestStatus, ChangeRequestType` to the `@prisma/client` import block (:24–33). Append a new `describe` block of tests. Touch nothing else in this file — in particular the P5-08 gate (:1622–1628), `updateOrderItems`, `completeStop`, and the private guards stay byte-identical.
- **exact code — insert after `assertWithinCreditLimit` (ends :2514), before `updateShipment`:**

```ts
  /**
   * P5-09: public credit re-check for the change-request next-delivery path.
   * Reuses the ONE exposure derivation (assertWithinCreditLimit) — never a
   * second balance formula.
   */
  async assertCreditForProjectedOrder(
    customerId: string,
    excludeOrderId: string,
    projectedTotal: number,
  ): Promise<void> {
    await this.assertWithinCreditLimit(
      this.prisma.forTenant(),
      customerId,
      excludeOrderId,
      projectedTotal,
    );
  }

  /**
   * P5-09 (G6): approve a PENDING ChangeRequest at the stop and merge its delta
   * into the dispatched order's live line set. The invoice merge is indirect and
   * reuses the existing money path end-to-end: the delta lands on OrderItem rows
   * (stored, already-rounded computeLineSubtotal results), the pending-mirror
   * draft invoice is re-synced via reconcileOrderDraftInvoice, and the eventual
   * completeStop bills delivered lines by copying/prorating those stored
   * subtotals. No new pricing/invoice formula exists here.
   *
   * Concurrency (G6): the conditional updateMany(status=PENDING) INSIDE the
   * transaction is the lock — first resolution wins; count===0 → 409; any later
   * throw (guards, validation) rolls the claim back with the merge.
   *
   * Guards re-run on approval (G6): regulated license BEFORE the tx (mirrors
   * updateOrderItems :1642-1658), stock + credit INSIDE the tx on the
   * authoritative recomputed line set (mirrors :2175-2187).
   */
  async approveChangeRequestAtStop(
    crId: string,
    resolver: JwtPayload,
    reason?: string | null,
  ): Promise<{ merged: true; subtotal: number; tax: number; total: number }> {
    const cr = await this.prisma.forTenant().changeRequest.findUnique({ where: { id: crId } });
    if (!cr) throw new NotFoundException("Change request not found");
    if (cr.status !== ChangeRequestStatus.PENDING) {
      throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED", status: cr.status });
    }
    const payload = cr.payload as any;

    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: cr.orderId },
      include: {
        lineItems: true,
        routeRun: { select: { id: true, status: true, driverId: true } },
        routeRunStop: { select: { id: true, status: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(order.status)) {
      throw new ConflictException({ code: "CHANGE_WINDOW_CLOSED", reason: "ORDER_STATUS" });
    }
    if (order.routeRun == null || order.routeRun.status !== "IN_PROGRESS") {
      throw new ConflictException({ code: "CHANGE_WINDOW_CLOSED", reason: "RUN_NOT_ACTIVE" });
    }
    if (
      order.routeRunStop != null &&
      ["COMPLETED", "SKIPPED"].includes(order.routeRunStop.status)
    ) {
      // The at-door authority window is over — resolve as next-delivery instead.
      throw new ConflictException({ code: "STOP_ALREADY_COMPLETED" });
    }

    // NOTE-type requests carry no money delta: claim + return, nothing else.
    if (cr.type === ChangeRequestType.NOTE) {
      const claimed = await this.prisma.forTenant().changeRequest.updateMany({
        where: { id: cr.id, status: ChangeRequestStatus.PENDING },
        data: {
          status: ChangeRequestStatus.APPROVED,
          resolution: "MERGED_AT_STOP",
          resolutionReason: reason ?? null,
          resolvedById: resolver.sub ?? null,
          resolvedByName: resolver.username ?? null,
          resolvedByRole: resolver.role ?? null,
          resolvedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED" });
      }
      const subtotal = Number(order.subtotal);
      const tax = Number(order.tax);
      return { merged: true, subtotal, tax, total: Number(order.total) };
    }

    // Regulated license guard re-runs on approval for the incoming product
    // (mirrors updateOrderItems :1642-1658; ORDER-scoped §8 overrides apply).
    if (cr.type === ChangeRequestType.ADD_ITEM) {
      const prod = await this.prisma.forTenant().product.findUnique({
        where: { id: (cr.productId ?? payload.productId) as string },
        select: { id: true, trackedCategoryId: true },
      });
      if (!prod) throw new BadRequestException("Product no longer exists");
      await this.authGuard.assertAuthorizedOrThrow({
        customerId: order.customerId,
        lines: [{ trackedCategoryId: prod.trackedCategoryId ?? null }],
        orderId: order.id,
      });
    }

    // Auto-revert a SENT pending-mirror invoice to DRAFT so the merge re-syncs
    // into it; throws if it carries payments (money never detaches). Mirrors
    // updateOrderItems :1630-1634.
    await this.invoicesService.revertLinkedInvoicesForOrderEdit(order.id);

    // P5-08b posture: reference reads on separate pooled connections are
    // hoisted BEFORE the interactive tx (pool-starvation guard, :1660-1672).
    const taxRate = await this.getTaxRate();
    const buyerPromos =
      cr.type === ChangeRequestType.ADD_ITEM
        ? await this.loadActivePromotions(UserRole.CUSTOMER)
        : [];
    const priceHistory =
      cr.type === ChangeRequestType.ADD_ITEM
        ? await this.getCustomerPriceHistory(order.customerId)
        : {};

    const { subtotal, tax } = await this.prisma.tenantTransaction(
      async (tx: any) => {
        // ── G6 atomic claim: FIRST resolution wins and LOCKS ─────────────────
        const claimed = await tx.changeRequest.updateMany({
          where: { id: cr.id, status: ChangeRequestStatus.PENDING },
          data: {
            status: ChangeRequestStatus.APPROVED,
            resolution: "MERGED_AT_STOP",
            resolutionReason: reason ?? null,
            resolvedById: resolver.sub ?? null,
            resolvedByName: resolver.username ?? null,
            resolvedByRole: resolver.role ?? null,
            resolvedAt: new Date(),
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED" });
        }

        let mutationRow: {
          orderItemId: string | null;
          productId: string | null;
          qty: number;
          note: string;
        } | null = null;

        if (
          cr.type === ChangeRequestType.CHANGE_QTY ||
          cr.type === ChangeRequestType.REMOVE_ITEM
        ) {
          const targetId = (cr.orderItemId ?? payload.orderItemId) as string;
          const li = order.lineItems.find((l) => l.id === targetId);
          if (!li || li.status === "CANCELLED") {
            throw new BadRequestException("Order line not found or already cancelled");
          }
          if (Number(li.deliveredQty) > 0) {
            throw new ConflictException({ code: "LINE_ALREADY_DELIVERED" });
          }
          if (cr.type === ChangeRequestType.REMOVE_ITEM) {
            // CANCEL semantics, never hard-delete post-dispatch — a mirror
            // invoice line may reference it (mirrors updateOrderItems :2003-2007).
            await tx.orderItem.update({
              where: { id: li.id },
              data: { status: "CANCELLED", qty: 0, subtotal: 0, boxes: null, pieces: null },
            });
            mutationRow = {
              orderItemId: li.id,
              productId: li.productId,
              qty: -Number(li.qty),
              note: `Line removed via approved change request ${cr.id}`,
            };
          } else {
            // Qty change — EXACTLY the operator qty-edit math (:2053-2157):
            // preserve denomination, keep the line's stored (agreed) unitPrice,
            // recompute subtotal via computeLineSubtotal. NEVER qty*unitPrice
            // on a boxed line.
            const newQty = Number(payload.newQty);
            if (!(newQty > 0)) {
              throw new BadRequestException("newQty must be > 0 — use REMOVE_ITEM instead");
            }
            let upb = Number((li as any).unitsPerBox ?? 0);
            if (upb === 0 && li.productId && li.boxes != null) {
              const p = await tx.product.findUnique({
                where: { id: li.productId },
                select: { unitsPerBox: true },
              });
              upb = Number(p?.unitsPerBox ?? 0);
            }
            const wasBoxSplit = li.boxes != null;
            const split =
              wasBoxSplit && upb > 1
                ? normalizeBoxesPieces({ qty: newQty, unitsPerBox: upb })
                : { qty: newQty, boxes: null as number | null, pieces: null as number | null };
            const unitPrice = Number(li.unitPrice);
            await tx.orderItem.update({
              where: { id: li.id },
              data: {
                qty: split.qty,
                boxes: split.boxes,
                pieces: split.pieces,
                unitsPerBox: split.boxes != null && upb > 1 ? upb : null,
                subtotal: computeLineSubtotal({
                  unitPrice,
                  qty: split.qty,
                  boxes: split.boxes,
                  pieces: split.pieces,
                  unitsPerBox: upb,
                }),
              },
            });
            mutationRow = {
              orderItemId: li.id,
              productId: li.productId,
              qty: split.qty - Number(li.qty),
              note: `Qty ${Number(li.qty)} -> ${split.qty} via approved change request ${cr.id}`,
            };
          }
        } else if (cr.type === ChangeRequestType.ADD_ITEM) {
          const product = await tx.product.findUnique({
            where: { id: (cr.productId ?? payload.productId) as string },
          });
          if (!product) throw new BadRequestException("Product no longer exists");
          const upb = Number(product.unitsPerBox ?? 0);
          const addQty = Number(payload.qty);
          if (!(addQty > 0)) throw new BadRequestException("qty must be > 0");

          const existing = order.lineItems.find(
            (l) =>
              l.productId === product.id &&
              l.status !== "CANCELLED" &&
              Number(l.deliveredQty) === 0,
          );
          if (existing) {
            // Same product already on the order → increase THAT line at its
            // stored (agreed) unitPrice; the agreed price always wins.
            const lineUpb = Number((existing as any).unitsPerBox ?? upb);
            const wasBoxSplit = existing.boxes != null;
            const newQty = Number(existing.qty) + addQty;
            const split =
              wasBoxSplit && lineUpb > 1
                ? normalizeBoxesPieces({ qty: newQty, unitsPerBox: lineUpb })
                : { qty: newQty, boxes: null as number | null, pieces: null as number | null };
            const unitPrice = Number(existing.unitPrice);
            await tx.orderItem.update({
              where: { id: existing.id },
              data: {
                qty: split.qty,
                boxes: split.boxes,
                pieces: split.pieces,
                unitsPerBox: split.boxes != null && lineUpb > 1 ? lineUpb : null,
                subtotal: computeLineSubtotal({
                  unitPrice,
                  qty: split.qty,
                  boxes: split.boxes,
                  pieces: split.pieces,
                  unitsPerBox: lineUpb,
                }),
              },
            });
            mutationRow = {
              orderItemId: existing.id,
              productId: product.id,
              qty: addQty,
              note: `Added ${addQty} at the door via approved change request ${cr.id}`,
            };
          } else {
            // New line → the CUSTOMER's effective price (tier → sticky upsell →
            // promo), the exact buyer create/merge pricing path (:1775-1787).
            // The buyer pays regardless of who requested, so customer pricing
            // applies uniformly.
            const buyerTier =
              (
                await tx.customer.findUnique({
                  where: { id: order.customerId },
                  select: { pricingTier: true },
                })
              )?.pricingTier ?? 1;
            const cp = await tx.customerPrice.findFirst({
              where: { customerId: order.customerId, productId: product.id },
            });
            const hasSplit = payload.boxes != null || payload.pieces != null;
            const split = hasSplit
              ? normalizeBoxesPieces({
                  boxes: payload.boxes,
                  pieces: payload.pieces,
                  unitsPerBox: upb,
                })
              : { qty: addQty, boxes: null as number | null, pieces: null as number | null };
            const qtyPieces = split.boxes != null ? split.qty : upb > 1 ? addQty * upb : addQty;
            const priced = this.resolveBuyerLinePrice(
              product,
              cp?.pricingTier ?? buyerTier,
              buyerPromos,
              qtyPieces,
              priceHistory[product.id]?.lastPrice ?? null,
            );
            const created = await tx.orderItem.create({
              data: {
                orderId: order.id,
                productId: product.id,
                qty: split.qty,
                boxes: split.boxes,
                pieces: split.pieces,
                unitsPerBox: split.boxes != null && upb > 1 ? upb : null,
                unitPrice: priced.unitPrice,
                originalPrice: priced.originalPrice,
                priceType: priced.priceType,
                subtotal: computeLineSubtotal({
                  unitPrice: priced.unitPrice,
                  qty: split.qty,
                  boxes: split.boxes,
                  pieces: split.pieces,
                  unitsPerBox: upb,
                }),
                status: "PENDING",
                notes: cr.note ?? null,
                trackedCategoryId: product.trackedCategoryId ?? null,
              },
            });
            mutationRow = {
              orderItemId: created.id,
              productId: product.id,
              qty: split.qty,
              note: `Added at the door via approved change request ${cr.id}`,
            };
          }
        }

        // ── Totals recompute — identical to updateOrderItems :2163-2168 ──────
        const activeItems = await tx.orderItem.findMany({
          where: { orderId: order.id, status: { not: "CANCELLED" } },
        });
        const subtotal = roundMoney(activeItems.reduce((s, l) => s + Number(l.subtotal), 0));
        const tax = roundMoney(subtotal * taxRate);

        // ── G6: stock + credit guards RE-RUN inside the tx (:2175-2187).
        // A throw rolls back the claim AND the merge. Resolver role drives the
        // stock guard's block/warn semantics (DRIVER hard-blocks; operators
        // warn-only, matching create()/edit posture). Credit blocks all roles.
        await this.assertStockAvailableForEdit(tx, order, activeItems, resolver);
        await this.assertWithinCreditLimit(
          tx,
          order.customerId,
          order.id,
          roundMoney(subtotal + tax),
        );

        // NO status revert here — post-dispatch orders must NOT flip to PENDING
        // (the shouldRevert logic in updateOrderItems is pre-dispatch-only).
        await tx.order.update({
          where: { id: order.id },
          data: {
            subtotal,
            tax,
            total: roundMoney(subtotal + tax),
            hasRegulated: activeItems.some((l) => l.trackedCategoryId != null),
          },
        });

        // ── Provenance: the DeliveryMutation row recording the at-door merge
        // (the P5-09 primitive; same table completeStop writes :2638-2650).
        if (mutationRow) {
          const driverId =
            resolver.role === UserRole.DRIVER
              ? ((await tx.driver.findFirst({ where: { userId: resolver.sub } }))?.id ?? null)
              : null;
          await tx.deliveryMutation.create({
            data: {
              orderId: order.id,
              orderItemId: mutationRow.orderItemId,
              productId: mutationRow.productId,
              routeRunStopId: order.routeRunStopId ?? cr.routeRunStopId ?? null,
              type:
                cr.type === ChangeRequestType.REMOVE_ITEM
                  ? MutationType.REFUSED
                  : MutationType.ADD_ON,
              qty: mutationRow.qty,
              note: mutationRow.note,
              driverId,
            },
          });
        }
        return { subtotal, tax };
      },
      { timeout: 15_000 },
    );

    // Post-commit, mirrors updateOrderItems :2222-2246: mirror draft invoice in
    // lockstep + immutable revision. Never a new money formula.
    await this.invoicesService.reconcileOrderDraftInvoice(order.id, { basis: "order" });
    await this.appendOrderRevision(
      order.id,
      resolver,
      { subtotal, tax, total: roundMoney(subtotal + tax) },
      "CHANGE_REQUEST",
      cr.note ?? null,
    );

    return { merged: true, subtotal, tax, total: roundMoney(subtotal + tax) };
  }
```

- **`findOne` include addition** (in the `findOne` include block that already carries `revisions` — grep `revisions:` inside `findOne`): add sibling key `changeRequests: { orderBy: { createdAt: "desc" } },`.
- **tests (append to `orders.service.spec.ts`):** new `describe("approveChangeRequestAtStop (P5-09)")`. Use the existing mock harness (createMockPrisma + the provider list at :101–179; `prisma.changeRequest.*` exists after WP1). Baseline fixture: `prisma.changeRequest.findUnique` → PENDING CR; `prisma.order.findUnique` → order `{ id:"ord-1", status:"OUT_FOR_DELIVERY", customerId:"cust-1", routeRunId:"run-1", routeRunStopId:"stop-1", subtotal, tax, total, lineItems:[...], routeRun:{ id:"run-1", status:"IN_PROGRESS", driverId:"drv-1" }, routeRunStop:{ id:"stop-1", status:"PENDING" } }`; `prisma.changeRequest.updateMany` → `{count:1}`; `prisma.orderItem.findMany` → post-merge active set; `prisma.customer.findUnique` → `{ creditLimit: null }` (credit guard no-op) unless the test targets credit. Cases (each asserts through the mock's call args):
  1. **CHANGE_QTY boxed proration**: line `{ qty:24, boxes:2, pieces:0, unitsPerBox:12, unitPrice:24 }` (box price), payload `newQty:18` → `orderItem.update` called with `qty:18, boxes:1, pieces:6, subtotal: computeLineSubtotal({unitPrice:24, qty:18, boxes:1, pieces:6, unitsPerBox:12})` = **36.00**, NOT `18*24`.
  2. **ADD_ITEM onto existing line**: same-product active line at stored `unitPrice: 8.5` (catalog now 10) → line qty summed, `unitPrice` stays 8.5 (agreed price wins).
  3. **ADD_ITEM new line**: no existing line; `product.pricePerUnit:10`, customer tier 2 (`getTierPrice` → e.g. `priceTier2: 9`) → `orderItem.create` with `unitPrice:9, priceType:"SPECIAL", originalPrice:10`; `deliveryMutation.create` with `type:"ADD_ON"`, `routeRunStopId:"stop-1"`, `qty` = added qty.
  4. **REMOVE_ITEM**: `orderItem.update` with `{status:"CANCELLED", qty:0, subtotal:0}`; `deliveryMutation.create` with `type:"REFUSED"`, negative `qty`.
  5. **G6 race — second resolve 409s**: `changeRequest.updateMany` → `{count:0}` ⇒ rejects with `ConflictException` (`code: CHANGE_REQUEST_ALREADY_RESOLVED`); `orderItem.update`/`create` and `deliveryMutation.create` NOT called.
  6. **Stock guard blocks a DRIVER resolver**: pre-merge held qty 0, `product.findMany` → `currentStock: 1`, add of 5 ⇒ rejects 409 `INSUFFICIENT_STOCK`; `reconcileOrderDraftInvoice` and `orderRevision.create` NOT called (rollback semantics).
  7. **Credit guard blocks**: `customer.findUnique` → `{creditLimit: 100}`, open invoice exposure pushes over ⇒ rejects 409 `CREDIT_LIMIT_EXCEEDED`; reconcile/revision NOT called.
  8. **Stop already completed**: `routeRunStop.status:"COMPLETED"` ⇒ 409 `STOP_ALREADY_COMPLETED`, no claim attempted.
  9. **Post-commit chain**: happy path calls `invoicesService.reconcileOrderDraftInvoice("ord-1", {basis:"order"})` and `orderRevision.create` with `source: "CHANGE_REQUEST"`.
  10. **Regulated guard re-runs**: ADD_ITEM of a product with `trackedCategoryId` → `authGuard.assertAuthorizedOrThrow` called with `{customerId, lines:[{trackedCategoryId}], orderId}`; when mocked to throw, nothing is written.

---

### WP3 — `ChangeRequestsService` (lifecycle) + DTOs + spec

- **files:** `apps/api/src/orders/change-requests.service.ts`, `apps/api/src/orders/dto/create-change-request.dto.ts`, `apps/api/src/orders/dto/resolve-change-request.dto.ts`, `apps/api/src/orders/change-requests.service.spec.ts`
- **brief:** New service owning create/list/resolve. Depends on `PrismaService`, `OrdersService` (WP2's two new public methods + `create`, `deleteOrder` — mock them in the spec), `NotificationsService`, `AuthorizationGuardService`. All reads/writes via `forTenant()`.
- **exact code — DTOs:**

```ts
// apps/api/src/orders/dto/create-change-request.dto.ts
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ChangeRequestType } from "@prisma/client";

export class CreateChangeRequestDto {
  @IsEnum(ChangeRequestType)
  type!: ChangeRequestType;

  /** CHANGE_QTY / REMOVE_ITEM: the target order line. */
  @IsOptional()
  @IsString()
  orderItemId?: string;

  /** ADD_ITEM: the catalog product to add. */
  @IsOptional()
  @IsString()
  productId?: string;

  /** ADD_ITEM: qty to add. CHANGE_QTY: the NEW absolute qty (not a delta). */
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(1_000_000)
  qty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  boxes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pieces?: number;

  /** Requester note; NOTE-type requests require it. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
```

```ts
// apps/api/src/orders/dto/resolve-change-request.dto.ts
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

export enum ChangeRequestResolveAction {
  APPROVE_AT_STOP = "APPROVE_AT_STOP",
  APPROVE_NEXT_DELIVERY = "APPROVE_NEXT_DELIVERY",
  DECLINE = "DECLINE",
}

export class ResolveChangeRequestDto {
  @IsEnum(ChangeRequestResolveAction)
  action!: ChangeRequestResolveAction;

  /** Required when action=DECLINE (service-enforced); optional context otherwise. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
```

- **exact code — service** (compliance-critical; transplant as written):

```ts
// apps/api/src/orders/change-requests.service.ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { OrdersService } from "./orders.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { ChangeRequestStatus, ChangeRequestType, UserRole, UserStatus } from "@prisma/client";
import { CreateChangeRequestDto } from "./dto/create-change-request.dto";
import {
  ChangeRequestResolveAction,
  ResolveChangeRequestDto,
} from "./dto/resolve-change-request.dto";

/**
 * P5-09: post-dispatch change-request lifecycle (G6/G7).
 * Creation opens exactly where the P5-08 edit window closes (order's RouteRun
 * dispatched); resolution: driver-at-stop primary, office only while PENDING,
 * FIRST resolution wins + locks (atomic conditional updateMany — count!==1 is
 * the lost race, 409). The at-stop money merge is delegated to
 * OrdersService.approveChangeRequestAtStop (the one money path).
 */
@Injectable()
export class ChangeRequestsService {
  private readonly logger = new Logger(ChangeRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly authGuard: AuthorizationGuardService,
  ) {}

  async create(orderId: string, dto: CreateChangeRequestDto, user: JwtPayload) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: { select: { id: true, productId: true, status: true, qty: true } },
        routeRun: { select: { status: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Ownership: a CUSTOMER may only file against their own order (mirrors
    // updateOrderItems' check). Buyer-portal calls arrive as a CUSTOMER
    // pseudo-user (buyer.controller makePseudoUser), so the same check covers both.
    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }

    // G7 inverse gate: change requests exist ONLY where direct editing ended.
    if (order.routeRun == null || order.routeRun.status === "SCHEDULED") {
      throw new ConflictException({
        code: "EDIT_WINDOW_OPEN",
        message: "This order is still directly editable — use PATCH /orders/:id/items.",
      });
    }
    if (
      order.routeRun.status !== "IN_PROGRESS" ||
      !["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(order.status)
    ) {
      throw new ConflictException({
        code: "CHANGE_WINDOW_CLOSED",
        message: "This order's delivery run is no longer active.",
      });
    }

    // Type-specific validation + typed payload build (name snapshots so the
    // request renders even after a product/line is later deleted).
    let payload: Record<string, unknown>;
    let orderItemId: string | null = null;
    let productId: string | null = null;
    switch (dto.type) {
      case ChangeRequestType.ADD_ITEM: {
        if (!dto.productId || !dto.qty) {
          throw new BadRequestException("ADD_ITEM requires productId and qty");
        }
        const product = await this.prisma
          .forTenant()
          .product.findUnique({ where: { id: dto.productId }, select: { id: true, name: true } });
        if (!product) throw new BadRequestException("Product not found");
        productId = product.id;
        payload = {
          productId: product.id,
          qty: dto.qty,
          boxes: dto.boxes ?? null,
          pieces: dto.pieces ?? null,
          productName: product.name,
        };
        break;
      }
      case ChangeRequestType.CHANGE_QTY:
      case ChangeRequestType.REMOVE_ITEM: {
        if (!dto.orderItemId) throw new BadRequestException("orderItemId is required");
        const li = order.lineItems.find(
          (l) => l.id === dto.orderItemId && l.status !== "CANCELLED",
        );
        if (!li) throw new BadRequestException("Order line not found");
        if (dto.type === ChangeRequestType.CHANGE_QTY && !dto.qty) {
          throw new BadRequestException("CHANGE_QTY requires qty (the new absolute qty)");
        }
        orderItemId = li.id;
        productId = li.productId;
        payload =
          dto.type === ChangeRequestType.CHANGE_QTY
            ? { orderItemId: li.id, newQty: dto.qty }
            : { orderItemId: li.id };
        break;
      }
      case ChangeRequestType.NOTE: {
        if (!dto.note?.trim()) throw new BadRequestException("NOTE requires note text");
        payload = { text: dto.note.trim() };
        break;
      }
      default:
        throw new BadRequestException("Unknown change request type");
    }

    return this.prisma.forTenant().changeRequest.create({
      data: {
        tenantId: this.prisma.getTenantId(),
        orderId: order.id,
        orderItemId,
        productId,
        routeRunStopId: order.routeRunStopId ?? null,
        type: dto.type,
        payload,
        note: dto.note ?? null,
        requestedById: user.sub || null,
        requestedByName: user.username || null,
        requestedByRole: user.role ?? null,
      },
    });
    // P6-5: wire MessagingService.notify(ORDER_CHANGED_AT_DOOR, ...) here once
    // the trigger/rule plumbing exists; P5-11 adds the operator/driver surfacing.
  }

  async listForOrder(orderId: string, user: JwtPayload) {
    const order = await this.prisma
      .forTenant()
      .order.findUnique({ where: { id: orderId }, select: { id: true, customerId: true } });
    if (!order) throw new NotFoundException("Order not found");
    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }
    return this.prisma.forTenant().changeRequest.findMany({
      where: { orderId },
      orderBy: { createdAt: "desc" },
    });
  }

  async resolve(orderId: string, crId: string, dto: ResolveChangeRequestDto, user: JwtPayload) {
    const cr = await this.prisma
      .forTenant()
      .changeRequest.findFirst({ where: { id: crId, orderId } });
    if (!cr) throw new NotFoundException("Change request not found");
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: { routeRun: { select: { driverId: true, status: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");

    // G6 authority: a DRIVER may resolve only if they are the run's assigned
    // driver (driver-at-stop). Operators/TENANT_ADMIN act as "the office" and
    // may resolve only while PENDING — which the atomic claim enforces anyway.
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || order.routeRun?.driverId !== driver.id) {
        throw new ForbiddenException("Only the run's assigned driver can resolve at the stop");
      }
    }
    // Fast-path (the atomic claim in each branch remains authoritative).
    if (cr.status !== ChangeRequestStatus.PENDING) {
      throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED", status: cr.status });
    }

    switch (dto.action) {
      case ChangeRequestResolveAction.DECLINE:
        return this.decline(cr, order, dto.reason, user);
      case ChangeRequestResolveAction.APPROVE_AT_STOP: {
        await this.ordersService.approveChangeRequestAtStop(cr.id, user, dto.reason ?? null);
        await this.notifyRequester(
          cr,
          order,
          "approved",
          "Your change was applied to today's delivery.",
        );
        return this.prisma.forTenant().changeRequest.findUnique({ where: { id: cr.id } });
      }
      case ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY:
        return this.approveNextDelivery(cr, order, dto.reason, user);
      default:
        throw new BadRequestException("Unknown resolve action");
    }
  }

  /** Decline — atomic claim (G6 first-resolution-wins), then notify with reason. */
  private async decline(cr: any, order: any, reason: string | undefined, user: JwtPayload) {
    if (!reason?.trim()) throw new BadRequestException("A decline reason is required");
    const claimed = await this.prisma.forTenant().changeRequest.updateMany({
      where: { id: cr.id, status: ChangeRequestStatus.PENDING },
      data: {
        status: ChangeRequestStatus.DECLINED,
        resolution: "DECLINED",
        resolutionReason: reason.trim(),
        resolvedById: user.sub || null,
        resolvedByName: user.username || null,
        resolvedByRole: user.role ?? null,
        resolvedAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED" });
    }
    await this.notifyRequester(cr, order, "declined", `Reason: ${reason.trim()}`);
    return this.prisma.forTenant().changeRequest.findUnique({ where: { id: cr.id } });
  }

  /**
   * Not-on-truck approval: the requested item rolls to the customer's next
   * delivery as a line on a NEW DRAFT order, created through OrdersService.create
   * (the battle-tested customer pricing path — tier → sticky upsell → promo —
   * never a second pricing formula). Valid only for ADD_ITEM and for CHANGE_QTY
   * increases (the positive delta rolls; the dispatched order is untouched).
   *
   * Guards re-run on approval (G6): regulated license before creating; credit
   * re-checked against the draft's total via the ONE exposure formula. Stock is
   * deliberately NOT checked — nothing ships now (the item is by definition not
   * on the truck); stock enforcement happens when the draft goes live/delivers,
   * matching the codebase's DRAFT posture.
   *
   * Ordering: create draft → guards → atomic claim. A lost claim race or a
   * guard failure deletes the just-created draft (compensation); the worst
   * crash artifact is a harmless empty DRAFT order the operator can delete —
   * never an APPROVED CR without its draft.
   */
  private async approveNextDelivery(
    cr: any,
    order: any,
    reason: string | undefined,
    user: JwtPayload,
  ) {
    const payload = cr.payload as any;
    let productId: string;
    let qty: number;
    if (cr.type === ChangeRequestType.ADD_ITEM) {
      productId = cr.productId ?? payload.productId;
      qty = Number(payload.qty);
    } else if (cr.type === ChangeRequestType.CHANGE_QTY) {
      const li = await this.prisma
        .forTenant()
        .orderItem.findFirst({ where: { id: cr.orderItemId ?? payload.orderItemId } });
      if (!li?.productId) throw new BadRequestException("Order line not found");
      const delta = Number(payload.newQty) - Number(li.qty);
      if (delta <= 0) {
        throw new BadRequestException({
          code: "INVALID_RESOLUTION_FOR_TYPE",
          message: "Only a qty increase can roll to the next delivery",
        });
      }
      productId = li.productId;
      qty = delta;
    } else {
      throw new BadRequestException({
        code: "INVALID_RESOLUTION_FOR_TYPE",
        message: "Only ADD_ITEM / CHANGE_QTY-increase requests can roll to the next delivery",
      });
    }

    const product = await this.prisma.forTenant().product.findUnique({
      where: { id: productId },
      select: { id: true, trackedCategoryId: true },
    });
    if (!product) throw new BadRequestException("Product no longer exists");
    // Regulated license guard re-runs on approval (G6).
    await this.authGuard.assertAuthorizedOrThrow({
      customerId: order.customerId,
      lines: [{ trackedCategoryId: product.trackedCategoryId ?? null }],
      orderId: order.id,
    });

    // Customer pseudo-user so create() prices via the buyer effective path.
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: order.customerId }, select: { userId: true } });
    if (!customer?.userId) throw new BadRequestException("Customer record not found");
    const pseudo: JwtPayload = {
      sub: customer.userId,
      username: "",
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      forcePasswordChange: false,
      tenantId: this.prisma.getTenantId(),
    } as JwtPayload;

    const draft = await this.ordersService.create(
      {
        items: [{ productId, qty }],
        status: "DRAFT",
        notes: `From change request on order #${order.orderNumber ?? order.id} (not on truck)`,
      } as any,
      pseudo,
      { skipAutoMerge: false },
    );

    try {
      // Credit re-check on approval (G6) — the ONE exposure formula, with the
      // draft excluded from the buckets and represented by its own total.
      await this.ordersService.assertCreditForProjectedOrder(
        order.customerId,
        draft.id,
        Number(draft.total),
      );
      // G6 atomic claim — first resolution wins and locks.
      const claimed = await this.prisma.forTenant().changeRequest.updateMany({
        where: { id: cr.id, status: ChangeRequestStatus.PENDING },
        data: {
          status: ChangeRequestStatus.APPROVED,
          resolution: "NEXT_DELIVERY",
          resolutionReason: reason ?? null,
          nextOrderId: draft.id,
          resolvedById: user.sub || null,
          resolvedByName: user.username || null,
          resolvedByRole: user.role ?? null,
          resolvedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED" });
      }
    } catch (e) {
      // Compensation: never leave an orphan draft behind a failed approval.
      await this.ordersService.deleteOrder(draft.id).catch(() => {});
      throw e;
    }

    await this.notifyRequester(
      cr,
      order,
      "approved",
      "The item wasn't on the truck — it was added to your next delivery.",
    );
    return this.prisma.forTenant().changeRequest.findUnique({ where: { id: cr.id } });
  }

  /**
   * Notify the requester of the outcome. Push via NotificationsService — the
   * mechanism completeStop already uses. Never fails the resolution.
   * (MessagingService.notify is NOT used: it requires per-tenant
   * NotificationRule/MessageTemplate rows that nothing seeds yet — P6-5 wires it.)
   */
  private async notifyRequester(cr: any, order: any, outcome: string, detail: string) {
    const title = `Change request ${outcome}`;
    const body = `Order #${order.orderNumber ?? ""}: ${detail}`.trim();
    const data = { orderId: order.id, changeRequestId: cr.id };
    try {
      if (cr.requestedByRole === UserRole.CUSTOMER || !cr.requestedById) {
        await this.notifications.sendToCustomer(order.customerId, title, body, data);
      } else {
        await this.notifications.sendToUser(cr.requestedById, { title, body, data });
      }
    } catch {
      this.logger.warn(`Change-request notification failed for ${cr.id}`);
    }
  }
}
```

_(Verify `PushPayload`'s exact shape in `apps/api/src/notifications/notifications.service.ts` — `sendToUser(userId, payload)` at :79 — and match the object literal to it.)_

- **tests (`change-requests.service.spec.ts`):** `Test.createTestingModule` with `createMockPrisma()` and full mocks for `OrdersService` (`approveChangeRequestAtStop`, `assertCreditForProjectedOrder`, `create`, `deleteOrder` as `jest.fn()`), `NotificationsService` (`sendToCustomer`, `sendToUser`), `AuthorizationGuardService` (`assertAuthorizedOrThrow`). Cases:
  1. create ADD_ITEM on a dispatched order (routeRun `IN_PROGRESS`) → `changeRequest.create` called with PENDING status, payload `{productId, qty, productName}`, requestedBy snapshot, `routeRunStopId` from the order.
  2. create while run `SCHEDULED` → 409 `EDIT_WINDOW_OPEN`; while run `COMPLETED` → 409 `CHANGE_WINDOW_CLOSED`.
  3. create as CUSTOMER not owning the order → `ForbiddenException`.
  4. create CHANGE_QTY with unknown/cancelled `orderItemId` → 400.
  5. resolve DECLINE without reason → 400; with reason → `updateMany` called with `where: { id, status: "PENDING" }` and data `status: "DECLINED"` + reason; requester notified: `sendToCustomer(order.customerId, expect.stringContaining("declined"), expect.stringContaining(reason), …)` for a CUSTOMER requester, `sendToUser` for a DRIVER requester.
  6. **G6 decline race**: `updateMany` → `{count:0}` ⇒ 409 `CHANGE_REQUEST_ALREADY_RESOLVED`, no notification sent.
  7. resolve APPROVE_AT_STOP → delegates to `ordersService.approveChangeRequestAtStop(cr.id, user, reason)`, then notifies "approved".
  8. resolve APPROVE_NEXT_DELIVERY (ADD_ITEM) → `authGuard.assertAuthorizedOrThrow` called; `ordersService.create` called with `status:"DRAFT"`, `items:[{productId, qty}]`, a CUSTOMER pseudo-user; `assertCreditForProjectedOrder(customerId, draft.id, draft.total)` called; claim `updateMany` includes `nextOrderId: draft.id`.
  9. **G6 next-delivery race**: claim `{count:0}` ⇒ `ordersService.deleteOrder(draft.id)` called (compensation) and 409 thrown; credit-guard rejection ⇒ same compensation + rethrow.
  10. APPROVE_NEXT_DELIVERY on REMOVE_ITEM / NOTE → 400 `INVALID_RESOLUTION_FOR_TYPE`.
  11. DRIVER not assigned to the order's run → `ForbiddenException`; assigned driver passes.

---

### WP4 — Controller routes + module wiring + buyer passthrough

- **files:** `apps/api/src/orders/orders.controller.ts`, `apps/api/src/orders/orders.module.ts`, `apps/api/src/buyer/buyer.controller.ts`
- **effort:** low
- **brief:**
  - `orders.module.ts`: add `ChangeRequestsService` to `providers` and `exports` (BuyerModule already imports OrdersModule — buyer.module.ts:9,43).
  - `orders.controller.ts`: inject `ChangeRequestsService` alongside `OrdersService`; add three routes after `updateOrderItems` (:195–204), same decorator style:

```ts
  // ─── P5-09: post-dispatch change requests ───────────────────────────────────

  @Post(":id/change-requests")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  createChangeRequest(
    @Param("id") id: string,
    @Body() dto: CreateChangeRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.changeRequestsService.create(id, dto, user);
  }

  @Get(":id/change-requests")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  listChangeRequests(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.changeRequestsService.listForOrder(id, user);
  }

  // G6: driver-at-stop is the primary authority; the office (OPERATOR /
  // TENANT_ADMIN via RolesGuard) may resolve only while PENDING. First
  // resolution wins and locks — a second resolve 409s. Buyers cannot resolve.
  @Post(":id/change-requests/:crId/resolve")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  resolveChangeRequest(
    @Param("id") id: string,
    @Param("crId") crId: string,
    @Body() dto: ResolveChangeRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.changeRequestsService.resolve(id, crId, dto, user);
  }
```

- `buyer.controller.ts`: inject `ChangeRequestsService`; add two seller-scoped passthroughs next to the existing order routes (after `updateOrderItems` :384–395), using the file's existing decorator stack (`BuyerSellerContextGuard`, `BuyerTenantInterceptor`, `@ApiHeader({ name: "X-Tenant-Slug", required: true })`) and `makePseudoUser(ctx)`:

```ts
  @Post("orders/:id/change-requests")
  // …standard buyer decorator stack…
  createChangeRequest(
    @Param("id") id: string,
    @Body() dto: CreateChangeRequestDto,
    @CurrentBuyerCustomer() ctx: any,
  ) {
    return this.changeRequestsService.create(id, dto, makePseudoUser(ctx));
  }

  @Get("orders/:id/change-requests")
  // …standard buyer decorator stack…
  listChangeRequests(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    return this.changeRequestsService.listForOrder(id, makePseudoUser(ctx));
  }
```

No resolve route on the buyer side (buyers never resolve). No driver-stop-scoped read route — that surfacing is P5-11's api scope.

---

### WP5 — Code map update

- **files:** `.claude/code-map/api.md`, `.claude/code-map/_meta.json`
- **effort:** low
- **brief:** In `api.md` under `### orders/`, append a short "P5-09 change requests" entry: model + endpoints + `ChangeRequestsService`/`approveChangeRequestAtStop` + G6 first-resolution-wins semantics + the "merge reuses stored-subtotal money path, stock never decremented by merge" invariant. Add `ChangeRequest` to the schema model list (~line 64–72 block) and `ChangeRequestType/Status` to the enum reference. Bump `_meta.json` `mappedSha` per its existing format.

## Acceptance criteria

1. `apps/api/prisma/schema.prisma` contains `ChangeRequest` + `ChangeRequestType` + `ChangeRequestStatus` exactly as specified (FK-less actor snapshots; `payload Json`; `nextOrderId` plain pointer; five indexes; back-relations on Order/OrderItem/Product/RouteRunStop/Tenant). Migration folder `20260721000000_add_change_requests` exists, is purely additive (CREATE TYPE/TABLE/INDEX/FK only), and `git status` shows `migration.sql` staged (force-added). No migration was applied to any remote/prod database.
2. `POST /orders/:id/change-requests` (roles OPERATOR/CUSTOMER/DRIVER) creates a PENDING CR **only** when the order's `routeRun.status === "IN_PROGRESS"` and order status ∈ {PENDING, CONFIRMED, OUT_FOR_DELIVERY}; a still-`SCHEDULED` run yields `409 { code: "EDIT_WINDOW_OPEN" }`; a COMPLETED/CANCELLED run yields `409 { code: "CHANGE_WINDOW_CLOSED" }`. A CUSTOMER caller must own the order (403 otherwise). The buyer portal reaches the same service via `POST /buyer/orders/:id/change-requests` with `makePseudoUser(ctx)`.
3. The P5-08 direct-edit gate in `updateOrderItems` (orders.service.ts:1622–1628) is byte-identical — direct edits still 409 `EDIT_WINDOW_CLOSED` post-dispatch.
4. `POST /orders/:id/change-requests/:crId/resolve` with `APPROVE_AT_STOP` merges via `OrdersService.approveChangeRequestAtStop`: existing lines keep their stored `unitPrice`; every written line subtotal comes from `computeLineSubtotal` (boxed lines re-split via `normalizeBoxesPieces` — verified by the boxed-proration test where an 18-piece qty on a 12-per-box line yields `1 box + 6 pieces` prorated by the BOX price, not `18 × boxPrice`); order totals are `roundMoney(Σ stored line subtotals)` + `roundMoney(subtotal × taxRate)`; a `DeliveryMutation` row is written (`ADD_ON` for adds/qty-changes with signed delta qty, `REFUSED` for removals) carrying `routeRunStopId` and the resolving driver's id; post-commit runs `reconcileOrderDraftInvoice(orderId, { basis: "order" })` and `appendOrderRevision(..., "CHANGE_REQUEST", ...)`. No new invoice/pricing formula exists anywhere in the diff.
5. **G6 lock**: every resolution path (approve-at-stop, next-delivery, decline) claims via `changeRequest.updateMany({ where: { id, status: PENDING } })` and treats `count !== 1` as `409 { code: "CHANGE_REQUEST_ALREADY_RESOLVED" }`. For the at-stop merge the claim executes **inside** the same `tenantTransaction` as the line writes and guards, so a guard throw rolls the claim back. A test in each spec file exercises the `count: 0` race and asserts 409 + no side effects.
6. **Guards re-run on approval**: at-stop approve runs `authGuard.assertAuthorizedOrThrow` (regulated, before the tx), `assertStockAvailableForEdit` and `assertWithinCreditLimit` (inside the tx, on the recomputed line set); DRIVER resolvers hard-block on stock, operators warn-only, credit blocks all roles — with tests proving 409 `INSUFFICIENT_STOCK` / `CREDIT_LIMIT_EXCEEDED` / regulated block each roll back the merge (no reconcile, no revision). Next-delivery approve runs the regulated guard + `assertCreditForProjectedOrder` (which delegates to the private `assertWithinCreditLimit` — no second exposure formula); stock is documented as deliberately unchecked for deferred lines.
7. **Not-on-truck approval** creates a DRAFT order via `OrdersService.create` with a CUSTOMER pseudo-user (`status: "DRAFT"`, single `{productId, qty}` line) and stamps its id into `ChangeRequest.nextOrderId`; valid only for ADD_ITEM and positive CHANGE_QTY deltas (400 `INVALID_RESOLUTION_FOR_TYPE` otherwise); a lost claim race or guard failure deletes the just-created draft.
8. **Decline** requires a non-empty reason (400 without) and notifies the requester including the reason via `NotificationsService` (`sendToCustomer` for CUSTOMER/unknown requesters, `sendToUser` otherwise), wrapped so a notification failure never fails the resolution. Approvals also notify. `MessagingService` is not referenced.
9. G6 authority: a DRIVER may resolve only when they are the order's run's assigned driver (403 otherwise); buyers/CUSTOMERs cannot reach the resolve route (RolesGuard); resolving is only possible while PENDING (criterion 5). At-stop merge additionally 409s (`STOP_ALREADY_COMPLETED`) when the order's stop is COMPLETED/SKIPPED.
10. `orders.service findOne` order payloads now include `changeRequests` (newest first); `GET /orders/:id/change-requests` and the buyer twin return the rows tenant-scoped with CUSTOMER ownership enforced.
11. Every DB access in the new code goes through `forTenant()` / `tenantTransaction` (no bare `this.prisma.<model>`); actor fields are FK-less snapshots.
12. `prisma-mock.ts` gained `changeRequest`; **all pre-existing spec files pass unmodified**; new suites cover: create-CR, approve-merges-via-DeliveryMutation (incl. boxed proration + agreed-price preservation), not-on-truck-drafts-line, decline-notifies-with-reason, guards-block-approval (stock/credit/regulated), and both G6 first-resolution-wins races.

## Verification commands

From `C:\ClaudeCode\routeflow`:

1. `cd apps/api && npx prisma generate` (after WP1; regenerates the client so `ChangeRequest*` types exist)
2. `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`
3. `cd apps/api && npx jest orders` (orders.service + controller suites incl. the new merge tests)
4. `cd apps/api && npx jest change-request` (new lifecycle suite)
5. `npm run verify` (root — turbo check-types + lint + test across workspaces)

Do **not** run `prisma migrate deploy` / any prod DB operation — prod apply of `20260721000000_add_change_requests` is a separate user-gated step.

## Risks & rollback

1. **The approve-merge money path** (top risk). Every dollar written by the merge must be a stored-value copy or a `computeLineSubtotal`/`roundMoney` result. Review checklist: (a) no `qty * unitPrice` anywhere in the new code for a line that has `boxes != null` or `unitsPerBox > 1`; (b) existing lines keep their stored `unitPrice` (the agreed price) — the CR merge never re-prices a line the customer already agreed to; (c) new lines price ONLY through `resolveBuyerLinePrice`; (d) invoice numbers are never minted and invoice totals never computed in the new code — the mirror draft syncs via `reconcileOrderDraftInvoice` and final billing stays in `completeStop`; (e) the merge never decrements `Product.currentStock` (delivery's `recordSale` is the single stock/costing path — a decrement here would double-count at delivery).
2. **The G6 double-resolution race.** The only lock is the conditional `updateMany` on `status: PENDING`. Watch for: a claim executed OUTSIDE the merge transaction (a guard failure would then leave a locked-but-unmerged CR — must be inside); any code path that writes `status` without the `where: { status: PENDING }` predicate; the next-delivery path's compensation (draft deleted on lost race) actually running in a `catch` that rethrows.
3. **Guards must re-run on approval.** A CR is created with NO guard checks (deliberately — it's just a request); if review finds an approval path that skips `assertStockAvailableForEdit` / `assertWithinCreditLimit` / `assertAuthorizedOrThrow` (at-stop) or the regulated+credit pair (next-delivery), that's a release blocker. The stock/credit guards must consume the recomputed post-merge line set inside the same tx, mirroring updateOrderItems :2175–2187.
4. **Post-dispatch status revert.** `updateOrderItems`'s `shouldRevert` flips CONFIRMED→PENDING on operator edits; the merge must NOT copy that behavior (a dispatched order flipped to PENDING would corrupt run state).
5. **Pool starvation.** Reference reads (`getTaxRate`, `loadActivePromotions`, `getCustomerPriceHistory`, `revertLinkedInvoicesForOrderEdit`) must stay hoisted before the `tenantTransaction` (P5-08b adversarial-review lesson, orders.service.ts:1660–1672).
6. **Schema/migration drift.** The hand-written SQL must match what `prisma migrate diff` would emit for the schema delta (enum names, `TIMESTAMP(3)`, FK actions). If CI/`prisma migrate deploy` later reports checksum/drift, regenerate the SQL from the schema rather than editing the schema to match the SQL.
7. **Rollback:** revert the branch's commits. The migration is additive, so a deployed rollback only requires reverting code (the new table/enums are inert if unused); if the migration must be unwound on a non-prod DB: `DROP TABLE "ChangeRequest"; DROP TYPE "ChangeRequestStatus"; DROP TYPE "ChangeRequestType";` — never run against prod without the user.

## Status

IMPLEMENTED (2026-07-13, via dev-pipeline on branch feat/p5-09-change-requests). All 5 WPs landed; `npm run verify` 18/18 green (prisma generate + check-types + lint + tests; change-requests 18 + orders.service 95 specs). Adversarial review caught + the fixer resolved two blockers: (1) `change-requests.service.ts` `payload` typed `Record<string,unknown>` → cast to `Prisma.InputJsonValue` at the create site (TS2322 that ts-jest masked but `check-types`/`nest build` failed on); (2) `buyer.controller.spec.ts` missing the new `ChangeRequestsService` provider (DI test failure). Additive migration `20260721000000_add_change_requests` staged (git add -f), NOT applied to prod (user-gated).
