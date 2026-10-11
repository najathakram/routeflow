import { BadRequestException, Logger } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { draftBillsLessThanOrder } from "./invoice-partition";
import { isNsfLine } from "./nsf-line";
import { applyComposedLineEdits } from "./invoice-composed-edit";
import { sumInvoiceTotalsStrict } from "../common/money-invariants.util";
import { UnitLineSplitError } from "../orders/unit-line-split";

const logger = new Logger("PartialPriceFollow");

/**
 * SA-760 Q-760-1 (OWNER answer 10-10): when an admin / operator order edit changes the PRICE of a line that
 * a partial invoice bills, a DRAFT partial FOLLOWS (unit price, discount, tax / category snapshot, then the
 * invoice total) and an ISSUED (non-DRAFT) partial never changes: it is listed so the UI can say so.
 *
 *   - Price only. The partial never gains or loses a line and its quantities never change (the partition
 *     stands); a PARTIAL is never re-billed to the full order. A qty-only edit changes nothing here.
 *   - One planner, two consumers: `applyPartialPriceFollow` writes the plan (inside the R-1 lock order), and
 *     P-3's overpay judge reads the same plan (`planned drafts' total`) so an edit that would overpay a DRAFT
 *     partial carrying external payments refuses with the same 409.
 *   - Money: every figure goes through the invoice-line builder (`@routeflow/pricing`'s proration, telescoped
 *     over what the order line has already billed) and `roundMoney`.
 *   - Eligibility: an order invoice that the rebuild paths leave alone: the order has more than one live
 *     invoice, or its only invoice bills less than the order. A sole invoice billing the whole order is the
 *     MIRROR (reconcile / re-sync restate it, SA-763 R6); it is not a partial.
 */
export interface FollowDeps {
  /** InvoicesService.buildInvoiceItemData, bound. */
  buildItem(
    li: any,
    qty: number,
    tenantId: string | null,
    opts: { priorBilledQty: number; priorPack?: number | null },
  ): any;
  /** InvoicesService.orderDerivedTaxRate, bound. */
  taxRateOf(order: { tax?: unknown; subtotal?: unknown }, isTaxExempt: boolean): number;
  /** InvoicesService.applyMsrpSnapshots, bound (stamps each rebuilt line's MSRP like every other builder). */
  applyMsrp(db: any, customerId: string, items: any[]): Promise<void>;
  tenantId: string | null;
}

export interface FollowDraftPlan {
  invoiceId: string;
  invoiceNumber: string;
  /** The invoice status as read: applyComposedLineEdits re-checks that only a DRAFT is written. */
  status: string;
  itemUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  /** The invoice's item rows as read (before the follow): the composed-line step compares against them. */
  storedRows: any[];
  subtotal: number;
  taxAmount: number;
  total: number;
}
export interface FollowPlan {
  drafts: FollowDraftPlan[];
  issuedPartialsUnchanged: Array<{ invoiceId: string; invoiceNumber: string | null }>;
}

const PRICE_EPS = 0.00005;
/** More than rounding noise (two cents) between the rebuilt and the stored line money. */
const MONEY_EPS = 0.02;
const samePrice = (a: unknown, b: unknown) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) < PRICE_EPS;

export async function planPartialPriceFollow(
  deps: FollowDeps,
  db: any,
  orderId: string,
): Promise<FollowPlan> {
  const none: FollowPlan = { drafts: [], issuedPartialsUnchanged: [] };
  const invoices: any[] = await db.invoice.findMany({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
    orderBy: [{ createdAt: "asc" }, { invoiceNumber: "asc" }],
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      discount: true,
      shippingFee: true,
      items: {
        select: {
          id: true,
          orderItemId: true,
          compositionMode: true, // applyComposedLineEdits reads it
          qty: true,
          unitPrice: true,
          originalPrice: true,
          priceType: true,
          subtotal: true,
          unitsPerBox: true,
          promoFreeUnits: true, // the staleness rule compares it (BUY_N_GET_M lines)
          categoryTaxAmount: true,
          systemKind: true,
          description: true,
        },
      },
    },
  });
  if (invoices.length === 0) return none;
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      lineItems: {
        where: { status: { not: "CANCELLED" } },
        include: {
          components: { orderBy: { position: "asc" } },
          product: {
            select: {
              name: true,
              unitsPerBox: true,
              trackedCategoryId: true,
              trackedSubcategoryId: true,
            },
          },
        },
      },
    },
  });
  if (!order) return none;
  const lineById = new Map<string, any>(order.lineItems.map((li: any) => [li.id, li]));
  if (invoices.length === 1 && !draftBillsLessThanOrder(invoices[0].items, order.lineItems))
    return none; // the sole mirror: the reconcile / re-sync paths own it
  const customer = await db.customer.findFirst({
    where: { id: order.customerId },
    select: { isTaxExempt: true },
  });
  const isTaxExempt = !!customer?.isTaxExempt;

  const billedBefore = new Map<string, number>(); // orderItemId -> qty billed by EARLIER live invoices
  const plan: FollowPlan = { drafts: [], issuedPartialsUnchanged: [] };
  for (const inv of invoices) {
    const priorOf = (orderItemId: string) => billedBefore.get(orderItemId) ?? 0;
    // Rebuild every order-linked line of this invoice at its OWN qty through the invoice-line builder; a line
    // is stale when its price fields moved, its BOGO free units moved, or the money the order line now
    // implies differs from what the invoice stored by more than rounding (a line-discount-only change moves
    // the order line's subtotal with the unit price untouched). A qty-only edit scales the line's subtotal
    // with its qty, so it rebuilds to the same figure and is not stale. A line the builder cannot rebuild
    // (a legacy shape it refuses) is left alone rather than blocking the edit.
    const fresh = new Map<string, any>();
    for (const it of inv.items) {
      const li = it.orderItemId ? lineById.get(it.orderItemId) : undefined;
      if (!li || isNsfLine(it)) continue;
      let f: any;
      try {
        f = deps.buildItem(li, Number(it.qty), deps.tenantId, {
          priorBilledQty: priorOf(it.orderItemId),
          priorPack: it.unitsPerBox,
        });
      } catch (err) {
        // Only the builder's own REFUSALS (a fractional-piece bill, a unit line missing its split) skip the
        // line; anything else is a real fault and must surface. The skip is logged, never silent.
        if (!(err instanceof BadRequestException) && !(err instanceof UnitLineSplitError))
          throw err;
        logger.warn(
          `price follow skipped a line the builder refuses: invoice ${inv.id} item ${it.id}: ${(err as Error).message}`,
        );
        continue;
      }
      const stale =
        !samePrice(it.unitPrice, li.unitPrice) ||
        !samePrice(it.originalPrice, li.originalPrice) ||
        (it.priceType ?? "STANDARD") !== (li.priceType ?? "STANDARD") ||
        Number(f.promoFreeUnits ?? 0) !== Number(it.promoFreeUnits ?? 0) ||
        Math.abs(Number(f.subtotal) - Number(it.subtotal)) > MONEY_EPS;
      if (stale) fresh.set(it.id, f);
    }
    if (fresh.size > 0) {
      if (inv.status !== InvoiceStatus.DRAFT) {
        plan.issuedPartialsUnchanged.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber });
      } else {
        await deps.applyMsrp(db, order.customerId, [...fresh.values()]);
        const rate = deps.taxRateOf(order, isTaxExempt);
        const itemUpdates = [...fresh].map(([id, f]) => ({
          id,
          data: {
            unitPrice: f.unitPrice,
            msrp: f.msrp,
            promoFreeUnits: f.promoFreeUnits,
            originalPrice: f.originalPrice,
            priceType: f.priceType,
            discount: f.discount,
            subtotal: f.subtotal,
            taxRate: rate,
            categoryTaxAmount: isTaxExempt ? 0 : f.categoryTaxAmount,
            categoryTaxType: f.categoryTaxType,
            categoryTaxRate: f.categoryTaxRate,
            categoryPriceIncludesTax: f.categoryPriceIncludesTax,
          },
        }));
        // The draft's money after the follow, by the ONE totals formula (sumInvoiceTotals, B1043): stale lines at
        // their fresh figures, the rest as stored; the NSF fee line is untaxed (rate 0).
        const priced = inv.items.map((it: any) => {
          const f = fresh.get(it.id);
          return {
            subtotal: f ? f.subtotal : it.subtotal,
            taxRate: !f && isNsfLine(it) ? 0 : rate,
            categoryTaxAmount: f ? f.categoryTaxAmount : it.categoryTaxAmount,
          };
        });
        const sums = sumInvoiceTotalsStrict(priced, {
          discount: Number(inv.discount ?? 0),
          shipping: Number(inv.shippingFee ?? 0),
          isTaxExempt,
        });
        plan.drafts.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          status: inv.status,
          itemUpdates,
          storedRows: inv.items,
          subtotal: sums.subtotal,
          taxAmount: sums.tax,
          total: sums.total,
        });
      }
    }
    for (const it of inv.items)
      if (it.orderItemId)
        billedBefore.set(it.orderItemId, priorOf(it.orderItemId) + Number(it.qty ?? 0));
  }
  return plan;
}

/** Write the DRAFT partials' plan (price fields and totals only) and report the issued ones left alone. */
export async function applyPartialPriceFollow(
  deps: FollowDeps,
  db: any,
  orderId: string,
): Promise<{ issuedPartialsUnchanged: FollowPlan["issuedPartialsUnchanged"]; followed: string[] }> {
  const plan = await planPartialPriceFollow(deps, db, orderId);
  for (const d of plan.drafts) {
    for (const u of d.itemUpdates)
      await db.invoiceItem.update({ where: { id: u.id }, data: u.data });
    // A FIXED composed line keeps its component rows' display price on the line's new net: the SAME step a
    // DRAFT invoice edit runs (price change, qty untouched -> displayUnitPrice4 re-stamped, ids stay put).
    await applyComposedLineEdits(
      db,
      { id: d.invoiceId, status: d.status, tenantId: deps.tenantId },
      d.itemUpdates.map((u) => ({
        rowId: u.id,
        untouched: false,
        data: { qty: d.storedRows.find((r) => r.id === u.id)?.qty, subtotal: u.data.subtotal },
      })),
      d.storedRows,
    );
    await db.invoice.update({
      where: { id: d.invoiceId },
      data: { subtotal: d.subtotal, taxAmount: d.taxAmount, total: d.total, pdfUrl: null },
    });
  }
  return {
    issuedPartialsUnchanged: plan.issuedPartialsUnchanged,
    followed: plan.drafts.map((d) => d.invoiceId),
  };
}
