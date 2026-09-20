import { ConflictException } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * Stock bookkeeping for order writes — lifted verbatim out of `OrdersService` (B585 prefactor:
 * `orders.service.ts` is over its size ratchet, so the paths that must grow — credit and selling
 * restrictions — need room; behaviour identical). The class keeps two thin delegators with the same
 * names so no call site changes.
 */
export interface OrderStockDeps {
  logger: { warn(message: string): void };
  /** The ambient tenant id (`PrismaService.getTenantId()`), read where the class read it. */
  tenantId: string | null | undefined;
}

/**
 * B283: the ONE stock-decrement code path for turning a set of order lines
 * into a real (non-draft) sale — locks the touched product rows FOR UPDATE,
 * blocks (customer/driver) or warns (staff) on insufficient stock, then
 * applies ONE aggregated UPDATE. Extracted out of create()'s non-draft
 * branch so changeStatus()'s DRAFT→PENDING promotion (the same "becomes a
 * real sale" moment) calls the IDENTICAL logic instead of a second
 * implementation — see REG-B283. Must be called from inside the caller's
 * transaction (the FOR UPDATE lock is only meaningful there).
 */
export async function decrementStockForSale(
  deps: OrderStockDeps,
  tx: any,
  stockLines: Array<{ productId: string; qty: number }>,
  isStaffRole: boolean,
): Promise<void> {
  if (stockLines.length === 0) return;
  const productIds = stockLines.map((li) => li.productId);
  // SELECT … FOR UPDATE acquires row-level locks in the current transaction.
  await tx.$executeRaw`
    SELECT id FROM "Product"
    WHERE id IN (${Prisma.join(productIds)})
    FOR UPDATE
  `;

  const lockedProducts = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, currentStock: true },
  });

  const oosItems: string[] = [];
  for (const li of stockLines) {
    const p = lockedProducts.find((lp: any) => lp.id === li.productId);
    if (p && Number(p.currentStock) < li.qty) {
      oosItems.push(
        `${p.name ?? li.productId} (available: ${Number(p.currentStock)}, requested: ${li.qty})`,
      );
    }
  }
  if (oosItems.length > 0) {
    if (isStaffRole) {
      deps.logger.warn(`Operator-initiated order will go below stock: ${oosItems.join("; ")}`);
    } else {
      throw new ConflictException(`Insufficient stock: ${oosItems.join("; ")}`);
    }
  }

  // Decrement stock atomically while the lock is held. For operator-initiated
  // overselling, this lets currentStock go negative — the inventory page can
  // surface that and the operator can reconcile after restock.
  //
  // B116 (REG-B116): ONE aggregated, set-based UPDATE instead of a per-line
  // ORM call — a per-line write ordering is why multiple lines for the same
  // product used to touch it twice instead of once. Aggregate first:
  // `UPDATE … FROM (VALUES …)` applies at most one row per join key, so
  // summing qty per product BEFORE the statement is load-bearing.
  //
  // Raw SQL bypasses the tenant proxy that scoped the ORM call it replaces,
  // so the tenant predicate is re-stated explicitly here — a cross-tenant
  // productId must not be able to move another tenant's stock. Null
  // tenantId (SUPER_ADMIN context) keeps the unscoped behaviour the ORM
  // call had in that same context.
  const stockTenantId = deps.tenantId;
  const qtyByProduct = new Map<string, number>();
  for (const li of stockLines) {
    qtyByProduct.set(li.productId, (qtyByProduct.get(li.productId) ?? 0) + li.qty);
  }
  const stockValues = Prisma.join(
    [...qtyByProduct.entries()].map(
      ([productId, qty]) => Prisma.sql`(${productId}::text, ${qty}::numeric)`,
    ),
  );
  await tx.$executeRaw`
    UPDATE "Product" AS p
    SET "currentStock" = p."currentStock" - v.qty
    FROM (VALUES ${stockValues}) AS v(id, qty)
    WHERE p.id = v.id
      ${stockTenantId ? Prisma.sql`AND p."tenantId" = ${stockTenantId}` : Prisma.empty}
  `;
}

/**
 * P5-08b + WP1 stock settle — validates the delta between the order's
 * pre-edit line set and the edited (post-edit) active line set, THEN
 * applies it to `Product.currentStock`.
 *
 * Lifecycle (why delta, not absolute): create() already decremented
 * Product.currentStock for every non-draft line under a row lock (RF-017,
 * create() ~line 1850-1902), so the order's existing lines are already "out
 * of" currentStock. NOTHING ELSE decrements for delivery — completeStop
 * writes no stock and InventoryService.recordSale has no caller — so
 * `currentStock` is settled at order time and re-settled here on edit, and
 * nowhere else. An edit therefore only needs to settle the
 * CHANGE against what the order already holds:
 *   - a product whose requested qty EXCEEDS its held qty needs the increase
 *     validated against currentStock (same guard as before), then that
 *     increase decremented;
 *   - a product whose requested qty is LESS than held (line reduced,
 *     removed, or zeroed) returns the difference to currentStock, CLAMPED
 *     to the undelivered remainder (`held − deliveredQty`) — delivered
 *     goods are gone and never come back via an edit. This is new; the
 *     pre-refactor version only validated increases, it never wrote
 *     anything.
 * Held/requested are compared over the UNION of product ids on both sides
 * (not just `requested`'s keys) so a product that disappears from the
 * edited set entirely (line removed) still gets its stock credited back.
 * A product with a ZERO delta (unchanged line) never enters the delta map
 * at all — no lock, no read, no write for it (see the DELTA_MAP short
 * circuit below), which is also why a same-qty edit never re-queries stock.
 *
 * Role semantics mirror create(): CUSTOMER/DRIVER hard-block (409
 * INSUFFICIENT_STOCK) with NO write on a violation; everyone else
 * (operator/admin/undefined = internal caller) may knowingly oversell —
 * warn-only log, and then (unlike the old validate-only guard) the write
 * still proceeds, matching create()'s oversell-writes-anyway posture.
 * Quantities compare in each line's own stored denomination (pieces for
 * box-split lines, selling units otherwise) — the same mixed-denomination
 * convention create() uses against currentStock.
 *
 * `SELECT ... FOR UPDATE` locks the touched product rows FIRST, before
 * reading currentStock — mirroring create()'s lock (:1863-1867). The old
 * validate-only assert read unlocked because it reserved nothing; now that
 * this method WRITES currentStock, the lock is load-bearing (closes the
 * same concurrent-oversell race create() closes). No StockMovement rows are
 * written — matches create(), which tracks currentStock only.
 *
 * Applies to DELIVERED/OUT_FOR_DELIVERY orders too: a qty increase on an
 * already-dispatched order means more goods physically went out the door,
 * symmetric with create() decrementing at order time.
 *
 * Skips ENTIRELY — no validation, no write, no query — when
 * `order.status === "DRAFT"`: creation never decremented stock for a draft,
 * so an edit of one must not either.
 *
 * Unknown/missing product rows and non-numeric quantities fail OPEN (skip)
 * for VALIDATION only — same posture as create()'s `if (p && ...)`; the
 * write still applies for every non-zero delta regardless (mirrors
 * create()'s unconditional decrement loop).
 *
 * `heldItems` is the pre-edit line set and MUST be read INSIDE the caller's
 * transaction, after that transaction has locked the order row
 * (`SELECT id FROM "Order" … FOR UPDATE`) and BEFORE it writes any
 * orderItem. Reading it from a pre-transaction `order.lineItems` snapshot
 * made the delta stale under a concurrent edit of the same order (web PATCH
 * racing an at-door approve), which settles a wrong-MAGNITUDE stock write —
 * far worse than a lost update, because the error persists in inventory.
 */
export async function settleStockForEdit(
  deps: OrderStockDeps,
  db: any,
  order: { id: string; status: string },
  heldItems: Array<{ productId: string | null; qty: any; deliveredQty?: any; status?: string }>,
  finalActiveItems: Array<{ productId: string | null; qty: any }>,
  user?: JwtPayload,
): Promise<void> {
  if (order.status === "DRAFT") return;

  // Qty the order already holds per product (pre-edit, non-cancelled lines),
  // plus — over the SAME line set — how much of it has already gone out the
  // door. Delivered goods are physically gone: an edit that shrinks or drops
  // a delivered line must NOT put them back on the shelf. This mirrors the
  // at-door precedent, where a CHANGE_QTY/REMOVE_ITEM request against a line
  // with deliveredQty > 0 is refused outright (LINE_ALREADY_DELIVERED,
  // ~:4205) — the operator edit path allows the edit but credits back only
  // the UNDELIVERED remainder.
  const held = new Map<string, number>();
  const deliveredHeld = new Map<string, number>();
  for (const li of heldItems ?? []) {
    if (li.productId && li.status !== "CANCELLED") {
      held.set(li.productId, (held.get(li.productId) ?? 0) + Number(li.qty));
      deliveredHeld.set(
        li.productId,
        (deliveredHeld.get(li.productId) ?? 0) + Number(li.deliveredQty ?? 0),
      );
    }
  }
  // Qty the edit requests per product (post-edit active line set).
  const requested = new Map<string, number>();
  for (const li of finalActiveItems) {
    if (li.productId) {
      requested.set(li.productId, (requested.get(li.productId) ?? 0) + Number(li.qty));
    }
  }

  // Delta per product over the UNION of both sides — a product present only
  // in `held` (its line was removed/zeroed in the edit) still gets an entry
  // here (delta = 0 − held < 0) so its stock is returned. Zero-delta
  // products (untouched lines) are dropped, so they never trigger a lock, a
  // stock read, or a write (DELTA_MAP short circuit).
  // Qty is Decimal(10,3): subtracting two float-converted Decimals leaves
  // binary residue (36 − 12.1 = 23.900000000000002), which `!== 0` reads as
  // a real delta and would write a phantom 1e-15 stock adjustment. Round to
  // the column's 3 decimals BEFORE the zero check, and write the ROUNDED
  // value.
  const deltas = new Map<string, number>();
  for (const productId of new Set([...held.keys(), ...requested.keys()])) {
    const raw = (requested.get(productId) ?? 0) - (held.get(productId) ?? 0);
    const delta = Math.round(raw * 1000) / 1000;
    if (delta !== 0) deltas.set(productId, delta);
  }
  if (deltas.size === 0) return;

  const productIds = [...deltas.keys()];
  // RF-017 parity: lock the touched product rows BEFORE reading
  // currentStock, mirroring create()'s lock (:1863-1867).
  await db.$executeRaw`
    SELECT id FROM "Product"
    WHERE id IN (${Prisma.join(productIds)})
    FOR UPDATE
  `;
  const products = await db.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, currentStock: true },
  });

  const increases = [...deltas.entries()]
    .filter(([, delta]) => delta > 0)
    .map(([productId, delta]) => ({
      productId,
      requested: requested.get(productId) ?? 0,
      delta,
    }));

  if (increases.length > 0) {
    const violations: Array<{
      productId: string;
      name: string;
      available: number;
      requested: number;
      delta: number;
    }> = [];
    for (const inc of increases) {
      const p = products.find((lp: any) => lp.id === inc.productId);
      if (p && Number(p.currentStock) < inc.delta) {
        violations.push({
          productId: inc.productId,
          name: p.name,
          available: Number(p.currentStock),
          requested: inc.requested,
          delta: inc.delta,
        });
      }
    }
    if (violations.length > 0) {
      if (user?.role !== UserRole.CUSTOMER && user?.role !== UserRole.DRIVER) {
        // Operators/admins may oversell — matches create()'s warn-only path.
        // Unlike the old validate-only guard, this does NOT return: the
        // write below still applies so the oversell lands in currentStock,
        // exactly like create()'s oversell write.
        deps.logger.warn(
          `Operator edit of order ${order.id} will go below stock: ` +
            violations
              .map((v) => `${v.name} (available: ${v.available}, requested increase: ${v.delta})`)
              .join("; "),
        );
      } else {
        const first = violations[0];
        throw new ConflictException({
          code: "INSUFFICIENT_STOCK",
          message:
            `Not enough stock for ${first.name} ` +
            `(available: ${first.available}, requested: ${first.requested}).`,
          productId: first.productId,
          available: first.available,
          requested: first.requested,
        });
      }
    }
  }

  // Apply: an increase decrements currentStock by the delta; a
  // decrease/removal increments back only the UNDELIVERED portion of what
  // the order held. Delivered goods never come back through an edit — the
  // at-door path makes the same call by refusing the change outright
  // (LINE_ALREADY_DELIVERED, ~:4205); crediting a delivered line's full qty
  // would invent inventory that physically left the warehouse. Cap =
  // max(0, held − deliveredHeld); a fully-delivered line's cap is 0, so it
  // is skipped entirely (no write at all). No StockMovement rows — matches
  // create(), which tracks currentStock only.
  for (const [productId, delta] of deltas) {
    if (delta > 0) {
      await db.product.update({
        where: { id: productId },
        data: { currentStock: { decrement: delta } },
      });
      continue;
    }
    const undelivered = Math.max(
      0,
      (held.get(productId) ?? 0) - (deliveredHeld.get(productId) ?? 0),
    );
    const credit = Math.min(-delta, undelivered);
    if (credit <= 0) continue;
    await db.product.update({
      where: { id: productId },
      data: { currentStock: { increment: credit } },
    });
  }
}
