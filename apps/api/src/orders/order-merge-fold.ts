/**
 * SA-1162: `mergeAllPendingForCustomer` and `forceConsolidateCustomer` (the customer merge pair), lifted VERBATIM out of
 * orders.service.ts (the size ratchet, OP-8) — same statements in the same order; the only edits are `this.` -> `self.`
 * and one level less indentation. The class keeps two thin same-signature delegators. The advisory lock
 * (`withAdvisoryLock`, family "order-merge") and the transaction move with the bodies, unchanged: no second lock.
 */
import { withAfterCommit } from "../common/after-commit";
import { compositionStampOf } from "./order-composition";
import { customerIsTaxExempt, orderTotalsOf } from "./order-totals";
import { discountModeOf } from "../common/discount-tax-mode";
import { appendMergeRevisionInTx } from "./order-revisions";
import * as authorship from "./line-author-channel";
import { roundMoney } from "@routeflow/pricing";
import { withAdvisoryLock, type LockMode } from "../common/db-locks";
import { assertMergeLockAcquired, mapLockError } from "./merge-contention";
import {
  deleteLoserGuarded,
  lockAndRecheckMergeInputs,
  readMergeGroup,
} from "./merge-lock-recheck";
import { UserRole, ItemStatus } from "@prisma/client";
import * as unitAware from "./unit-aware-guard";
import { linePositionAllocator, loserLineRanks } from "./line-position";
import { isBuyerPricedLine } from "./buyer-merge-pricing";
import {
  buildMergeLineWrites,
  orderMergeAppends,
  withAppendRanks,
  type MergeLine,
  type MergeWarning,
} from "./merge-line-writes";
import { reportPackWarnings } from "./merge-pack-warnings";
import type { MergePush, MergeWarnOpts } from "./merge-restriction-warning";
import { collectUnlistedLoserItems, createUnlistedLoserLine } from "./merge-unlisted-lines";
import { clearLoserDraftForDelete } from "./merge-loser-draft";
import { deleteOrderInvoice } from "./order-invoice-delete";
import type { OrdersService } from "./orders.service";

/**
 * Consolidate every unassigned PENDING order for a customer into a single
 * "winner" order. The most-recent order is the winner so its unitPrices are
 * the latest. Older orders' line items are folded in (qtys summed when the
 * productId already exists on the winner; new productIds copied over with
 * the most-recent older order's price/metadata). Older orders are then
 * deleted.
 *
 * Skips orders already attached to a route run, with invoices, transactions,
 * or returns — those are already part of an in-flight delivery flow and
 * must not be silently consolidated.
 *
 * Idempotent: when there is 0 or 1 mergeable order, returns it (or null)
 * without writing.
 */
/**
 * `buyerInitiated`: the customer themselves triggered this consolidation from the
 * buyer portal / their own app. Only then may a merged BUY_N_GET_M line earn free
 * units none of the contributing lines had — the buyer splitting one cart in two
 * must not lose the promo the combined quantity qualifies for. Left false for the
 * hourly sweep and every staff path so operator/driver pricing stays untouched.
 *
 * `opts.lockMode`: `"wait"` (the default) blocks up to 20 s for the customer's merge lock —
 * right for the sweep/force paths, which have no client attached. Every POST-COMMIT caller on
 * a request path passes `"try"` instead: their row has already committed, so their only use
 * for the lock is opportunistic consolidation, and waiting would spend a request's remaining
 * budget (and pin one of the 8 lock-pool slots) on work that is already deferrable. In `try`
 * mode a held lock returns `{ acquired: false }` → the coded 503 below → `isMergeContention`
 * → the caller's "deferred" warning, with the hourly sweep folding the leftover.
 */
export async function mergeAllPendingForCustomerImpl(
  self: OrdersService,
  customerId: string,
  options: { buyerInitiated?: boolean; focusOrderId?: string } = {},
  opts?: {
    lockMode?: LockMode;
    onPackMismatch?: (warnings: MergeWarning[]) => void;
    onLivePackFallback?: (warnings: MergeWarning[]) => void;
  } & MergeWarnOpts,
) {
  let after: MergePush; // F-05: the push runs after the lock is released
  try {
    const result = await withAdvisoryLock(
      {
        family: "order-merge",
        key: customerId,
        mode: opts?.lockMode ?? "wait",
        // Inert under `try` (pg_try_advisory_lock never blocks); it is the 20 s budget the
        // sweep/force paths wait on.
        waitMs: 20_000,
      },
      async () => {
        // B1053: the ONE shared predicate (merge-lock-recheck.ts); the tx re-reads it under lock.
        const { group: pendingOrders } = await readMergeGroup(
          self.prisma.forTenant(),
          customerId,
          "auto",
          options.focusOrderId,
        );

        if (pendingOrders.length <= 1) {
          return pendingOrders[0] ?? null;
        }
        // units_v1: fold nothing and return NO order (a survivor would be someone else's order).
        if (pendingOrders.some((o) => o.lineItems.some(unitAware.isUnitAwareLine))) return null;

        const [winner, ...losers] = pendingOrders;
        // Unlisted (catalog-free) loser lines can't be keyed by product — each is
        // appended to the winner as its own new line (never boxed, unaffected by B776).
        const loserRanks = loserLineRanks(losers); // W-1187: the append sequence, one rank per loser line
        const unlistedNewItems = collectUnlistedLoserItems(losers, loserRanks);

        // unitsPerBox for every product involved so boxed lines prorate by the box.
        const contributingLines = [...winner.lineItems, ...losers.flatMap((l) => l.lineItems)];
        const involvedProductIds = [
          ...new Set(
            contributingLines.map((li) => li.productId).filter((id): id is string => !!id),
          ),
        ];
        const upbByProduct = new Map<string, number>();
        // Category feeds scope=CATEGORY matching when a merged line's BUY_N_GET_M
        // free units are re-derived below.
        const catByProduct = new Map<string, string | null>();
        if (involvedProductIds.length > 0) {
          const prods = await self.prisma.forTenant().product.findMany({
            where: { id: { in: involvedProductIds } },
            select: { id: true, unitsPerBox: true, category: true },
          });
          for (const p of prods) {
            upbByProduct.set(p.id, Number(p.unitsPerBox ?? 0));
            catByProduct.set(p.id, p.category ?? null);
          }
        }

        const taxRate = await self.getTaxRate();
        // BUY_N_GET_M: a merged line earns its own free units for the COMBINED
        // quantity, so the live rule is re-run below. Loaded on a separate pooled
        // connection before the tx (pool-starvation guard) and ONLY when a
        // contributing line carries a free-unit snapshot, or the BUYER drove this
        // merge and a buyer-priced line could newly earn one (split carts) — every
        // other merge issues no extra query and is byte-for-byte unchanged.
        const bogoPromos =
          contributingLines.some((li: any) => Number(li.promoFreeUnits ?? 0) > 0) ||
          (options.buyerInitiated === true && contributingLines.some((li) => isBuyerPricedLine(li)))
            ? await self.loadActivePromotions(UserRole.CUSTOMER)
            : [];

        // B776 (SA-101(1)): group every contributing line by the PACK it was actually priced
        // at (never the live product row) before folding — a disagreeing pack never merges
        // into another, it gets its own line, at its own snapshot and price, with a warn.
        const { writes: mergeWrites, warnings: packWarnings } = buildMergeLineWrites(
          winner.lineItems.filter((li) => li.productId) as unknown as MergeLine[],
          withAppendRanks(authorship.loserLinesOf(losers), loserRanks) as unknown as MergeLine[],
          {
            promos: bogoPromos,
            canEarnNew: options.buyerInitiated === true,
            categoryFor: (productId) => catByProduct.get(productId) ?? null,
            liveUnitsPerBoxFor: (productId) => upbByProduct.get(productId) ?? 0,
          },
        );
        // SA-124: split by kind — a genuine disagreement (packMismatch) and a box-unaware
        // contribution with no snapshot resolved via the live product pack (livePackFallback,
        // SA-101(a) branch 4) are independent conditions with their own message and counter.
        reportPackWarnings(self.logger, "merge", winner.id, packWarnings, opts);

        await self.prisma.tenantTransaction(async (tx) => {
          await lockAndRecheckMergeInputs(tx, {
            customerId,
            kind: "auto",
            focusOrderId: options.focusOrderId,
            pre: pendingOrders,
          });
          // 1/2. Apply every pack-group write: an UPDATE onto the winner's own existing line
          // for its own pack group, a CREATE for every other group (SA-101(1)(b)/(c)).
          for (const write of mergeWrites) {
            if (write.kind === "update") {
              await tx.orderItem.update({ where: { id: write.lineId }, data: write.data });
            }
          }
          // W-1187 (D4): catalog creates and unlisted lines append TOGETHER in the losers' cart order, each in the next slot.
          const slots = linePositionAllocator(tx, winner.id);
          for (const append of orderMergeAppends(mergeWrites, unlistedNewItems)) {
            if (append.kind === "catalog") {
              // SA-100: explicit inline keys (never a `...append.data` spread) — the mandatory
              // trioVia AST check finds a regulated writer by scanning for a literal
              // `trackedCategoryId:` property in the object passed to `create()`; a spread
              // hides it behind a variable reference and makes this row invisible.
              await tx.orderItem.create({
                data: {
                  orderId: winner.id,
                  status: ItemStatus.PENDING,
                  productId: append.data.productId,
                  qty: append.data.qty,
                  boxes: append.data.boxes,
                  pieces: append.data.pieces,
                  unitsPerBox: append.data.unitsPerBox,
                  unitPrice: append.data.unitPrice,
                  subtotal: append.data.subtotal,
                  promoFreeUnits: append.data.promoFreeUnits,
                  priceType: append.data.priceType,
                  originalPrice: append.data.originalPrice,
                  overrideReason: append.data.overrideReason,
                  overriddenBy: append.data.overriddenBy,
                  notes: append.data.notes,
                  trackedCategoryId: append.data.trackedCategoryId,
                  categoryTaxType: append.data.categoryTaxType,
                  categoryTaxRate: append.data.categoryTaxRate,
                  categoryPriceIncludesTax: append.data.categoryPriceIncludesTax,
                  backorderedPieces: append.data.backorderedPieces ?? 0, // SA-716: carried
                  restrictionOverrideReason: append.data.restrictionOverrideReason, // row 510: carried
                  restrictionOverrideBy: append.data.restrictionOverrideBy,
                  restrictionOverrideAt: append.data.restrictionOverrideAt,
                  restrictionOverrideRuleIds: append.data.restrictionOverrideRuleIds,
                  ...compositionStampOf(append.data),
                  authorChannel: append.data.authorChannel, // SA ruling #3418: the folded line's own author
                  position: await slots.next(), // W-1187: after the winner's lines, in the losers' order
                },
              });
            } else {
              await createUnlistedLoserLine(tx, winner.id, append.data, await slots.next()); // 2b
            }
          }

          // 3. Drop loser orders and their items — carrying a loser's Idempotency-
          //    Key onto the winner FIRST when the winner's slot is free (R6): the
          //    loser's cart just landed in the winner, so a still-queued retry of
          //    that request must replay onto the winner, not re-create a deleted
          //    order. Single-column storage means only one carried key can survive
          //    a multi-loser sweep — the ELDEST loser's (they merge updatedAt DESC,
          //    so iterate from the tail); the residual (two keyed losers, one slot)
          //    is a recorded Low limitation, bounded further by R4's content check.
          const winnerRow = await tx.order.findUnique({
            where: { id: winner.id },
            select: { idempotencyKey: true },
          });
          let slotFree = winnerRow?.idempotencyKey == null;
          for (const loser of [...losers].reverse()) {
            const loserKey = (loser as { idempotencyKey?: string | null }).idempotencyKey;
            if (slotFree && loserKey) {
              // Free the unique before re-pointing it at the winner.
              await tx.order.update({ where: { id: loser.id }, data: { idempotencyKey: null } });
              await tx.order.update({
                where: { id: winner.id },
                data: { idempotencyKey: loserKey },
              });
              slotFree = false;
            }
          }
          for (const loser of losers) {
            // B215: a loser's merge keys follow its cart onto the winner. The FK cascade would
            // otherwise delete them with the loser, and a retry of that merge would fold the
            // same cart into the winner a second time.
            await tx.orderIdempotencyKey.updateMany({
              where: { orderId: loser.id },
              data: { orderId: winner.id },
            });
            await deleteLoserGuarded(tx, loser.id, "auto"); // items + the guarded order delete
          }

          // 4. Recompute winner totals.
          await self.syncCompositions(tx, winner.id);
          const activeItems = await tx.orderItem.findMany({
            where: { orderId: winner.id, status: { not: ItemStatus.CANCELLED } },
          });
          const subtotal = roundMoney(
            activeItems.reduce((s: number, li: any) => s + Number(li.subtotal), 0),
          );
          // RF-4: re-derive + persist each line's category tax from the merged set,
          // and fold Σ into the total (a merged-in regulated line keeps its levy).
          const isTaxExempt = await customerIsTaxExempt(tx, customerId);
          await self.recomputeLineCategoryTaxes(tx, activeItems, isTaxExempt);
          const totals = orderTotalsOf(activeItems, {
            taxRate,
            isTaxExempt,
            shipping: Number(winner.shippingFee ?? 0),
            discount: 0, // SA-918: no participant carries one (readMergeGroup refuses or skips)
            discountBase: discountModeOf(winner),
          });
          await tx.order.update({
            where: { id: winner.id },
            data: {
              subtotal,
              tax: totals.regularTax,
              // Winner keeps ITS OWN stored fee; loser fees drop with the losers (the merged
              // order is one delivery → one fee). Same asymmetry as discountAmount.
              total: totals.total,
              // A merged-in regulated line flips the denormalized flag on.
              hasRegulated: activeItems.some((li: any) => li.trackedCategoryId != null),
            },
          });
          await appendMergeRevisionInTx(tx, self.prisma.getTenantId(), winner.id); // row 372 MF2
        });

        self.logger.log(
          `Merged ${losers.length} PENDING order(s) into ${winner.id} for customer ${customerId}`,
        );
        after = await self.warnMergedBanned(winner, losers, customerId, {
          ...opts,
          actor: opts?.actor ?? (options.buyerInitiated ? { type: "BUYER" } : null),
        });

        return self.prisma.forTenant().order.findUnique({
          where: { id: winner.id },
          include: {
            customer: { select: { id: true, businessName: true } },
            lineItems: {
              include: { product: { select: { id: true, name: true, unit: true } } },
            },
          },
        });
      },
    );
    // Under `try` this is the NORMAL "someone else holds this customer's lock" outcome; under
    // `wait` it is defensive only (that mode either acquires or throws). Either way it carries
    // the same coded body as mapLockError's 503, so `isMergeContention` (the sweep, every
    // post-commit caller) recognises it identically and defers.
    assertMergeLockAcquired(result);
    // The push runs here, after the lock is released. If the winner's post-warn re-read (inside the lock)
    // throws, `after` is never assigned and the push is lost: the AuditLog row is then the durable trace.
    await after?.();
    return result.value;
  } catch (e) {
    mapLockError(e);
  }
}

export async function forceConsolidateCustomerImpl(
  self: OrdersService,
  customerId: string,
  opts?: MergeWarnOpts,
) {
  let after: MergePush;
  try {
    const result = await withAdvisoryLock(
      { family: "order-merge", key: customerId, mode: "wait", waitMs: 20_000 },
      async () => {
        const { group: orders } = await readMergeGroup(
          self.prisma.forTenant(),
          customerId,
          "force",
        );
        if (orders.length <= 1) return orders[0] ?? null;
        unitAware.assertNoUnitAwareLines(
          orders.flatMap((o) => o.lineItems),
          "consolidated",
        );

        const [winner, ...losers] = orders;

        // If winner has no route assignment but losers do, promote the first loser's assignment.
        const routeAssignment =
          winner.routeRunId == null ? (losers.find((o) => o.routeRunId != null) ?? null) : null;

        // Unlisted (catalog-free) loser lines are appended as their own winner lines
        // (never boxed, unaffected by B776).
        const loserRanks = loserLineRanks(losers); // W-1187: the append sequence, one rank per loser line
        const unlistedNewItems = collectUnlistedLoserItems(losers, loserRanks);

        // unitsPerBox for every product involved so boxed lines prorate by the box.
        const involvedProductIds = [
          ...new Set(
            [...winner.lineItems, ...losers.flatMap((l) => l.lineItems)]
              .map((li) => li.productId)
              .filter((id): id is string => !!id),
          ),
        ];
        const upbByProduct = new Map<string, number>();
        // Category feeds scope=CATEGORY matching when a merged line's BUY_N_GET_M
        // free units are re-derived below.
        const catByProduct = new Map<string, string | null>();
        if (involvedProductIds.length > 0) {
          const prods = await self.prisma.forTenant().product.findMany({
            where: { id: { in: involvedProductIds } },
            select: { id: true, unitsPerBox: true, category: true },
          });
          for (const p of prods) {
            upbByProduct.set(p.id, Number(p.unitsPerBox ?? 0));
            catByProduct.set(p.id, p.category ?? null);
          }
        }

        const taxRate = await self.getTaxRate();
        // BUY_N_GET_M: a merged line earns its own free units for the COMBINED
        // quantity, so the live rule is re-run below. Loaded on a separate pooled
        // connection before the tx (pool-starvation guard) and ONLY when a
        // contributing line actually carries a free-unit snapshot — every non-BOGO
        // merge issues no extra query and is byte-for-byte unchanged.
        const bogoPromos = [...winner.lineItems, ...losers.flatMap((l) => l.lineItems)].some(
          (li: any) => Number(li.promoFreeUnits ?? 0) > 0,
        )
          ? await self.loadActivePromotions(UserRole.CUSTOMER)
          : [];

        // B776 (SA-101(1)): group every contributing line by the PACK it was actually priced
        // at (never the live product row) before folding — see mergeAllPendingForCustomer.
        const { writes: mergeWrites, warnings: packWarnings } = buildMergeLineWrites(
          winner.lineItems.filter((li) => li.productId) as unknown as MergeLine[],
          withAppendRanks(authorship.loserLinesOf(losers), loserRanks) as unknown as MergeLine[],
          {
            promos: bogoPromos,
            canEarnNew: false,
            categoryFor: (productId) => catByProduct.get(productId) ?? null,
            liveUnitsPerBoxFor: (productId) => upbByProduct.get(productId) ?? 0,
          },
        );
        // SA-124: see mergeAllPendingForCustomer — split by kind, independent conditions.
        const counts = reportPackWarnings(self.logger, "consolidate", winner.id, packWarnings);

        await withAfterCommit(self.prisma, async (tx, after) => {
          await lockAndRecheckMergeInputs(tx, { customerId, kind: "force", pre: orders });
          for (const write of mergeWrites) {
            if (write.kind === "update") {
              await tx.orderItem.update({ where: { id: write.lineId }, data: write.data });
            }
          }
          // W-1187 (D4): catalog creates and unlisted lines append TOGETHER in the losers' cart order, each in the next slot.
          const slots = linePositionAllocator(tx, winner.id);
          for (const append of orderMergeAppends(mergeWrites, unlistedNewItems)) {
            if (append.kind === "catalog") {
              // SA-100: explicit inline keys (never a `...append.data` spread) — the mandatory
              // trioVia AST check finds a regulated writer by scanning for a literal
              // `trackedCategoryId:` property in the object passed to `create()`; a spread
              // hides it behind a variable reference and makes this row invisible.
              await tx.orderItem.create({
                data: {
                  orderId: winner.id,
                  status: ItemStatus.PENDING,
                  productId: append.data.productId,
                  qty: append.data.qty,
                  boxes: append.data.boxes,
                  pieces: append.data.pieces,
                  unitsPerBox: append.data.unitsPerBox,
                  unitPrice: append.data.unitPrice,
                  subtotal: append.data.subtotal,
                  promoFreeUnits: append.data.promoFreeUnits,
                  priceType: append.data.priceType,
                  originalPrice: append.data.originalPrice,
                  overrideReason: append.data.overrideReason,
                  overriddenBy: append.data.overriddenBy,
                  notes: append.data.notes,
                  trackedCategoryId: append.data.trackedCategoryId,
                  categoryTaxType: append.data.categoryTaxType,
                  categoryTaxRate: append.data.categoryTaxRate,
                  categoryPriceIncludesTax: append.data.categoryPriceIncludesTax,
                  backorderedPieces: append.data.backorderedPieces ?? 0, // SA-716: carried
                  restrictionOverrideReason: append.data.restrictionOverrideReason, // row 510: carried
                  restrictionOverrideBy: append.data.restrictionOverrideBy,
                  restrictionOverrideAt: append.data.restrictionOverrideAt,
                  restrictionOverrideRuleIds: append.data.restrictionOverrideRuleIds,
                  ...compositionStampOf(append.data),
                  authorChannel: append.data.authorChannel, // SA ruling #3418: the folded line's own author
                  position: await slots.next(), // W-1187: after the winner's lines, in the losers' order
                },
              });
            } else {
              await createUnlistedLoserLine(tx, winner.id, append.data, await slots.next()); // 2b
            }
          }
          for (const loser of losers) {
            // Remove a loser's pending mirror draft (and its items) before deleting the order. The
            // Invoice→Order FK is ON DELETE SET NULL, so it would NOT block: a loser with a billed
            // Invoice or a Transaction never reaches here (mergeEligibleWhere("force") skips it, and
            // deleteLoserGuarded re-checks the same predicate on the delete itself).
            const loserDraft = await self.invoicesService.findOpenOrderDraft(loser.id, tx);
            if (loserDraft) {
              await clearLoserDraftForDelete(tx, self.ledger, loserDraft);
              await tx.invoiceItem.deleteMany({ where: { invoiceId: loserDraft.id } });
              await deleteOrderInvoice(tx, loserDraft.id, self.prisma.getTenantId());
            }
            // B215: a loser's merge keys follow its cart onto the winner. The FK cascade would
            // otherwise delete them with the loser, and a retry of that merge would fold the
            // same cart into the winner a second time.
            await tx.orderIdempotencyKey.updateMany({
              where: { orderId: loser.id },
              data: { orderId: winner.id },
            });
            await deleteLoserGuarded(tx, loser.id, "force"); // items + the guarded order delete
          }
          await self.syncCompositions(tx, winner.id);
          const activeItems = await tx.orderItem.findMany({
            where: { orderId: winner.id, status: { not: ItemStatus.CANCELLED } },
          });
          const subtotal = roundMoney(
            activeItems.reduce((s: number, li: any) => s + Number(li.subtotal), 0),
          );
          // RF-4: re-derive + persist each line's category tax from the merged set,
          // and fold Σ into the total (a merged-in regulated line keeps its levy).
          const isTaxExempt = await customerIsTaxExempt(tx, customerId);
          await self.recomputeLineCategoryTaxes(tx, activeItems, isTaxExempt);
          const totals = orderTotalsOf(activeItems, {
            taxRate,
            isTaxExempt,
            shipping: Number(winner.shippingFee ?? 0),
            discount: 0, // SA-918: no participant carries one (readMergeGroup refuses or skips)
            discountBase: discountModeOf(winner),
          });
          const routeUpdate = routeAssignment
            ? {
                routeRunId: routeAssignment.routeRunId,
                routeRunStopId: routeAssignment.routeRunStopId,
              }
            : {};
          await tx.order.update({
            where: { id: winner.id },
            data: {
              subtotal,
              tax: totals.regularTax,
              // Winner keeps ITS OWN stored fee; loser fees drop with the losers (the merged
              // order is one delivery → one fee). Same asymmetry as discountAmount.
              total: totals.total,
              // A merged-in regulated line flips the denormalized flag on.
              hasRegulated: activeItems.some((li: any) => li.trackedCategoryId != null),
              ...routeUpdate,
            },
          });
          await appendMergeRevisionInTx(tx, self.prisma.getTenantId(), winner.id); // row 372 MF2
          // If the winner carries a pending mirror draft, re-sync it to the merged lines.
          await self.invoicesService.reconcileOrderDraftInvoice(winner.id, {
            basis: "order",
            tx,
            after,
          });
        });

        self.logger.log(
          `forceConsolidateCustomer: merged ${losers.length} order(s) into ${winner.id} for customer ${customerId}, ${counts.mismatch} pack mismatch(es), ${counts.livePack} live-pack fallback(s)`,
        );
        after = await self.warnMergedBanned(winner, losers, customerId, opts);
        return self.prisma.forTenant().order.findUnique({
          where: { id: winner.id },
          include: {
            customer: { select: { id: true, businessName: true } },
            lineItems: {
              include: { product: { select: { id: true, name: true, unit: true } } },
            },
          },
        });
      },
    );
    // Defensive: see mergeAllPendingForCustomer — same coded 503 body.
    assertMergeLockAcquired(result);
    await after?.();
    return result.value;
  } catch (e) {
    mapLockError(e);
  }
}
