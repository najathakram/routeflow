/**
 * Returns Inside Order Creation — PR-1b: `POST /returns/inline/quote`.
 *
 * Resolves the matching set (§3.1: this customer's invoiced sales within the sold
 * window, REAL_INVOICE_STATUSES ∪ non-VOID DRAFT of a DELIVERED/PARTIALLY_DELIVERED
 * order), the PR-1a prior-returned-pieces reader, and tier/CustomerPrice pricing —
 * then hands everything to the pure `inline-returns-pricing.ts` engine. Read-only:
 * nothing here writes a Return/ReturnItem row (that's PR-1c/1d's capture path).
 */
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  InvoiceStatus,
  OrderStatus,
  RouteRunStatus,
  RouteRunStopStatus,
  UserRole,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { REAL_INVOICE_STATUSES } from "../common/invoiced-sales";
import { getTierPrice } from "@routeflow/pricing";
import { returnedPiecesByProduct } from "./returns-pieces.util";
import {
  allocateReturnedPieces,
  priceMatchedChunk,
  priceUnreferencedChunk,
  returnRequestPieces,
  totalChunks,
  type CandidateInvoiceLine,
  type PricedChunk,
  type QuoteBreakdown,
  type RemainingSupply,
} from "./inline-returns-pricing";
import type { QuoteInlineReturnDto } from "./dto/quote-inline-return.dto";

/** PR-1..3 ship fixed defaults (design.md §8) — config reading comes after
 * feature-grants PR-3a's EntitlementsService wiring. */
const DEFAULT_SOLD_WINDOW_DAYS = 90;

const DELIVERED_ORDER_STATUSES = [OrderStatus.DELIVERED, OrderStatus.PARTIALLY_DELIVERED];

@Injectable()
export class InlineReturnsQuoteService {
  constructor(private readonly prisma: PrismaService) {}

  async quote(
    dto: QuoteInlineReturnDto,
    user: JwtPayload,
  ): Promise<QuoteBreakdown & { productBreakdown: Record<string, QuoteBreakdown> }> {
    // Q5/§7: buyers keep the post-delivery request flow — never captured at order-entry
    // time. `@Roles` on the controller already excludes CUSTOMER, but this is the money-
    // writing-adjacent quote path, so it's refused explicitly here too (defense in depth —
    // matches the house convention of never trusting a decorator alone for a money surface).
    if (user.role === UserRole.CUSTOMER) {
      throw new ForbiddenException("Buyers cannot capture returns at order entry");
    }

    const db = this.prisma.forTenant();

    // M8 scoping (§7): a DRIVER may only quote for the customer of a stop on their
    // OWN currently-IN_PROGRESS run — mirrors orders.service.ts's B309 driver-
    // isolation guard for the exact same "own run, own stop" invariant. Runs BEFORE
    // any other read so a scoping failure never leaks whether the customer/invoices
    // even exist.
    if (user.role === UserRole.DRIVER) {
      if (!dto.routeRunStopId) {
        throw new ForbiddenException("routeRunStopId is required for a driver quote");
      }
      const driver = await db.driver.findFirst({ where: { userId: user.sub } });
      const stop = await db.routeRunStop.findFirst({
        where: { id: dto.routeRunStopId },
        select: { id: true, routeRunId: true, customerId: true, status: true },
      });
      if (!stop) throw new ForbiddenException("Stop not found");
      if (stop.customerId !== dto.customerId) {
        throw new ForbiddenException("Stop does not belong to this customer");
      }
      // B309 parity (orders.service.ts:2035-2036): a completed/skipped stop is no longer an
      // active part of the run — a return can't be captured "at" a stop the driver has
      // already left.
      if (
        stop.status === RouteRunStopStatus.COMPLETED ||
        stop.status === RouteRunStopStatus.SKIPPED
      ) {
        throw new ForbiddenException("Stop is already completed or skipped");
      }
      const run = await db.routeRun.findFirst({
        where: { id: stop.routeRunId },
        select: { id: true, driverId: true, status: true },
      });
      if (!driver || !run || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }
      if (run.status !== RouteRunStatus.IN_PROGRESS) {
        throw new ForbiddenException("Route run is not in progress");
      }
    }

    // findFirst (not findUnique) — the tenant-scoping extension injects `where.tenantId` into
    // findFirst/findMany, but a findUnique keyed purely on `id` bypasses that post-filter
    // entirely, so a foreign-tenant customerId would otherwise resolve. deletedAt: null also
    // refuses a soft-deleted (removed) customer, matching the B131 removed-customer convention
    // used elsewhere (orders.service.ts).
    const customer = await db.customer.findFirst({
      where: { id: dto.customerId, deletedAt: null },
      select: { id: true, pricingTier: true, isTaxExempt: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    const productIds = [...new Set(dto.items.map((i) => i.productId))];

    const [customerPrices, products, matchingSet] = await Promise.all([
      db.customerPrice.findMany({
        where: { customerId: dto.customerId, productId: { in: productIds } },
        select: { productId: true, pricingTier: true },
      }),
      db.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          pricePerUnit: true,
          priceTier2: true,
          priceTier3: true,
          priceTier4: true,
          priceTier5: true,
        },
      }),
      this.fetchMatchingSet(db, dto.customerId, productIds),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p]));
    const tierByProduct = new Map(
      customerPrices
        .filter((cp) => cp.pricingTier != null)
        .map((cp) => [cp.productId, cp.pricingTier as number]),
    );

    // Sold PIECES per (sourceOrderId, productId) — from the SAME matching-set lines the
    // allocation itself draws from, never a live re-price. Pools on `piecesQty`, never `qty`
    // (a selling-unit line's `qty` is boxes, not pieces — pooling on it undercounts supply by
    // a factor of unitsPerBox and silently caps a boxed return short).
    const soldByOrderProduct = new Map<string, number>();
    for (const line of matchingSet) {
      const key = `${line.sourceOrderId}::${line.productId}`;
      soldByOrderProduct.set(key, (soldByOrderProduct.get(key) ?? 0) + line.piecesQty);
    }

    // PR-1a's shared prior-returned reader is keyed per source order — call it once
    // per distinct order in the matching set and merge.
    const distinctOrderIds = [...new Set(matchingSet.map((l) => l.sourceOrderId))];
    const priorReturnedByOrder = await Promise.all(
      distinctOrderIds.map(async (orderId) => ({
        orderId,
        byProduct: await returnedPiecesByProduct(db as any, orderId),
      })),
    );
    const priorReturnedMap = new Map(priorReturnedByOrder.map((r) => [r.orderId, r.byProduct]));

    const remainingByKey: RemainingSupply[] = [];
    for (const [key, sold] of soldByOrderProduct) {
      const [sourceOrderId, productId] = key.split("::");
      const priorReturned = priorReturnedMap.get(sourceOrderId)?.[productId] ?? 0;
      remainingByKey.push({
        sourceOrderId,
        productId,
        remainingPieces: Math.max(0, sold - priorReturned),
      });
    }

    const productBreakdown: Record<string, QuoteBreakdown> = {};
    const allChunks: PricedChunk[] = [];

    for (const item of dto.items) {
      const requestedPieces = returnRequestPieces({
        qty: item.qty,
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        // Only meaningful for a bare-qty (no boxes/pieces split) DTO — the caller's
        // own product-level box size, taken from whichever candidate line has it.
        unitsPerBox: matchingSet.find((l) => l.productId === item.productId)?.unitsPerBox ?? null,
      });

      const allocated = allocateReturnedPieces(
        matchingSet,
        remainingByKey,
        item.productId,
        requestedPieces,
      );

      const product = productMap.get(item.productId);
      const tierForProduct = tierByProduct.get(item.productId) ?? customer.pricingTier;
      const unreferencedPrice = product ? Number(getTierPrice(product, tierForProduct)) : 0;
      const unreferencedSource = tierByProduct.has(item.productId)
        ? ("CUSTOMER_PRICE" as const)
        : tierForProduct > 1
          ? ("TIER" as const)
          : ("BASE" as const);
      // The candidate lines are ALL the same product's own tax rate lineage; for the
      // unreferenced chunk (no matched line at all) fall back to whichever candidate
      // line names the widest-known rate, else 0 — there is no invoice to snapshot from.
      const fallbackTaxRate = matchingSet.find((l) => l.productId === item.productId)?.taxRate ?? 0;

      const chunks: PricedChunk[] = allocated.map((chunk) =>
        chunk.line
          ? priceMatchedChunk(chunk.line, chunk.pieces, customer.isTaxExempt)
          : priceUnreferencedChunk(
              item.productId,
              chunk.pieces,
              { unitPrice: unreferencedPrice, source: unreferencedSource },
              fallbackTaxRate,
              customer.isTaxExempt,
            ),
      );

      productBreakdown[item.productId] = totalChunks(chunks);
      allChunks.push(...chunks);
    }

    return { ...totalChunks(allChunks), productBreakdown };
  }

  /** §3.1's matching set: REAL_INVOICE_STATUSES ∪ non-VOID DRAFT of a DELIVERED/
   * PARTIALLY_DELIVERED order, within the sold window, newest invoice first. */
  private async fetchMatchingSet(
    db: ReturnType<PrismaService["forTenant"]>,
    customerId: string,
    productIds: string[],
    soldWindowDays = DEFAULT_SOLD_WINDOW_DAYS,
  ): Promise<CandidateInvoiceLine[]> {
    const since = new Date();
    since.setDate(since.getDate() - soldWindowDays);

    const invoices = await db.invoice.findMany({
      where: {
        customerId,
        orderId: { not: null },
        issueDate: { gte: since },
        OR: [
          { status: REAL_INVOICE_STATUSES },
          {
            status: InvoiceStatus.DRAFT,
            order: { status: { in: DELIVERED_ORDER_STATUSES } },
          },
        ],
      },
      orderBy: { issueDate: "desc" },
      select: {
        orderId: true,
        subtotal: true,
        discount: true,
        taxAmount: true,
        items: {
          where: { productId: { in: productIds } },
          select: {
            id: true,
            orderItemId: true,
            productId: true,
            qty: true,
            unitPrice: true,
            subtotal: true,
            boxes: true,
            pieces: true,
            unitsPerBox: true,
            promoFreeUnits: true,
            taxRate: true,
            categoryTaxAmount: true,
          },
        },
      },
    });

    const lines: CandidateInvoiceLine[] = [];
    for (const inv of invoices) {
      if (!inv.orderId) continue;
      for (const item of inv.items) {
        if (!item.productId) continue;
        const qty = Number(item.qty);
        // §3.1/Opus fix-round: piecesQty is the TRUE piece count, computed once here — a
        // box-split line's qty is already pieces; a selling-unit line's qty is boxes, so it
        // must be multiplied by unitsPerBox. Pooling/capping uses ONLY piecesQty; qty stays
        // the line's own axis for proration inside priceMatchedChunk.
        const piecesQty = item.boxes != null ? qty : qty * (Number(item.unitsPerBox) || 1);
        lines.push({
          sourceOrderId: inv.orderId,
          sourceInvoiceItemId: item.id,
          sourceOrderItemId: item.orderItemId ?? null,
          productId: item.productId,
          qty,
          piecesQty,
          unitPrice: Number(item.unitPrice),
          subtotal: Number(item.subtotal),
          boxes: item.boxes,
          pieces: item.pieces,
          unitsPerBox: item.unitsPerBox,
          promoFreeUnits: item.promoFreeUnits,
          taxRate: Number(item.taxRate),
          // §4/§5: the QUOTE's category-tax figure is a pro-rated preview of this
          // snapshot; the actual capped-at-the-ledger-booking credit is computed at
          // capture time (PR-1c), which is the only place a mismatch can be caught.
          categoryTax: Number(item.categoryTaxAmount) || null,
          invoiceSubtotal: Number(inv.subtotal),
          invoiceDiscount: Number(inv.discount),
          invoiceTaxAmount: Number(inv.taxAmount),
        });
      }
    }
    return lines;
  }
}
