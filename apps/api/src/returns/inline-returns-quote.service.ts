/**
 * Returns Inside Order Creation — PR-1b: `POST /returns/inline/quote`.
 *
 * Resolves the matching set (§3.1: this customer's invoiced sales within the sold
 * window, REAL_INVOICE_STATUSES ∪ non-VOID DRAFT of a DELIVERED/PARTIALLY_DELIVERED
 * order), the PR-1a prior-returned-pieces reader, and tier/CustomerPrice pricing —
 * then hands everything to the pure `inline-returns-pricing.ts` engine. Read-only:
 * nothing here writes a Return/ReturnItem row (that's PR-1c/1d's capture path).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  InvoiceStatus,
  OrderStatus,
  RouteRunStatus,
  RouteRunStopStatus,
  UserRole,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { REAL_INVOICE_STATUSES } from "../common/invoiced-sales";
import { currentTaxRate } from "../common/tax-rate";
import { getTierPrice, isWholeCents, packFromOwnSplit } from "@routeflow/pricing";
import { returnedPiecesByProduct } from "./returns-pieces.util";
import {
  allocateReturnedPieces,
  applyCreditOverride,
  priceMatchedChunk,
  priceUnreferencedChunk,
  resolveReturnPackFactor,
  returnRequestPieces,
  totalChunks,
  type CandidateInvoiceLine,
  type CreditOverride,
  type PricedChunk,
  type QuoteBreakdown,
  type RemainingSupply,
} from "./inline-returns-pricing";
import type { QuoteInlineReturnDto, QuoteInlineReturnItemDto } from "./dto/quote-inline-return.dto";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  canRefundRole,
  loadSourceInvoicesState,
  sourcesAreRefundable,
} from "./inline-return-refund";
import { assertWalkInCoveredBySale, resolveSourceSale } from "./inline-returns-source-sale";

/** PR-1..3 ship fixed defaults (design.md §8) — config reading comes after
 * feature-grants PR-3a's EntitlementsService wiring. */
const DEFAULT_SOLD_WINDOW_DAYS = 90;

const DELIVERED_ORDER_STATUSES = [OrderStatus.DELIVERED, OrderStatus.PARTIALLY_DELIVERED];

/** #2695 (SA-557): the 400 codes of a per-line credit price override. */
export const RETURN_CREDIT_OVERRIDE_ERROR_CODES = {
  /** A caller other than OPERATOR/TENANT_ADMIN sent an override field — refused, never dropped. */
  FORBIDDEN: "RETURN_CREDIT_OVERRIDE_FORBIDDEN",
  /** A price without a reason (or a reason without a price), or an unusable value. */
  INVALID: "RETURN_CREDIT_OVERRIDE_INVALID",
  /** Above the engine's default per-selling-unit price for a chunk: overrides only LOWER a credit. */
  OVER_CAP: "RETURN_CREDIT_OVER_CAP",
} as const;

const CREDIT_OVERRIDE_ROLES: ReadonlySet<string> = new Set([
  UserRole.OPERATOR,
  UserRole.TENANT_ADMIN,
]);

/**
 * #2695: each request item's validated override (undefined = none), keyed by the item. Runs
 * before any read, on the quote and the capture alike (both reach `priceInlineReturn`), so the two
 * can never price different chunks. `undefined` is "not sent"; any other value (null included) is
 * a field the caller sent.
 */
export function creditOverridesOf(
  items: readonly QuoteInlineReturnItemDto[],
  user: JwtPayload,
): Map<QuoteInlineReturnItemDto, CreditOverride> {
  const out = new Map<QuoteInlineReturnItemDto, CreditOverride>();
  for (const item of items) {
    const price = item.creditUnitPrice;
    const rawReason = item.overrideReason;
    // B961: the "already returned" confirmation reason is staff-only too (a driver's capture is HELD, never confirmed).
    if (item.alreadyReturnedReason !== undefined && !CREDIT_OVERRIDE_ROLES.has(user.role)) {
      throw new BadRequestException({
        code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.FORBIDDEN,
        message: "Only office staff can confirm a return of goods already returned or credited.",
      });
    }
    if (price === undefined && rawReason === undefined) continue;
    if (!CREDIT_OVERRIDE_ROLES.has(user.role)) {
      throw new BadRequestException({
        code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.FORBIDDEN,
        message: "Only office staff can override a return's credit price.",
      });
    }
    const reason = typeof rawReason === "string" ? rawReason.trim() : "";
    if (
      typeof price !== "number" ||
      price < 0 ||
      // SA-557c: the one shared cents predicate (finite + roundMoney-exact), never a hand-rolled cents multiply.
      !isWholeCents(price)
    ) {
      throw new BadRequestException({
        code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.INVALID,
        message: "A credit price override needs a price of $0.00 or more, in cents.",
      });
    }
    if (reason.length === 0 || reason.length > 200) {
      throw new BadRequestException({
        code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.INVALID,
        message: "A credit price override needs a reason (up to 200 characters).",
      });
    }
    out.set(item, { unitPrice: price, reason, overriddenBy: user.sub });
  }
  return out;
}

@Injectable()
export class InlineReturnsQuoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async quote(
    dto: QuoteInlineReturnDto,
    user: JwtPayload,
  ): Promise<
    QuoteBreakdown & {
      productBreakdown: Record<string, QuoteBreakdown>;
      canRefund: boolean;
      paidInFull: boolean;
      paidMethods: string[];
      paidWithStoreCredit: boolean;
      customerIsWalkIn: boolean;
    }
  > {
    const db = this.prisma.forTenant();
    const priced = await this.priceInlineReturn(dto, user, db);
    // SA-727 (additive): what the counter dialog needs to offer a cash/card/check refund. Read-only and unlocked: a hint
    // only; POST /returns/inline/:id/refund re-checks everything under its locks.
    const [customer, source] = await Promise.all([
      db.customer.findFirst({
        where: { id: dto.customerId, deletedAt: null },
        select: { isWalkIn: true },
      }),
      loadSourceInvoicesState(
        db,
        priced.chunks.map((c) => c.sourceInvoiceItemId),
      ),
    ]);
    return {
      ...priced,
      // F4/F5: paid in full AND none of it paid with store credit (store credit is never turned into cash) AND worth money
      canRefund: canRefundRole(user.role) && sourcesAreRefundable(source) && priced.total > 0.001,
      paidInFull: source.paidInFull,
      paidMethods: source.paidMethods,
      paidWithStoreCredit: source.paidWithStoreCredit,
      customerIsWalkIn: customer?.isWalkIn === true,
    };
  }

  /**
   * The pricing engine itself — shared by the read-only `quote()` above (tenant-scoped,
   * no lock) and `InlineReturnsService.capture()` (PR-1c), which calls this with its OWN
   * capture transaction's `tx` client so pricing reads the exact same locked snapshot the
   * write then commits against (design.md §5's lock order: this must run AFTER the
   * carrying/source `Order FOR UPDATE`s, never before — a pre-lock price could be stale by
   * the time capture writes it). `db` is deliberately typed loosely (`any`) so a plain `tx`
   * client (no `forTenant()` extension) is a valid caller too.
   */
  async priceInlineReturn(
    dto: QuoteInlineReturnDto,
    user: JwtPayload,
    db: any,
    // #2178: invoices to leave out of the matching set — the order-edit preflight passes the ones
    // the edit's revert is about to turn into DRAFTs of an undelivered order (which §3.1 excludes).
    // SA-740: `defaultSourceOrderId` is the capture's carrying order, the source a WALK-IN return defaults to.
    opts: { excludeInvoiceIds?: readonly string[]; defaultSourceOrderId?: string | null } = {},
  ): Promise<QuoteBreakdown & { productBreakdown: Record<string, QuoteBreakdown> }> {
    // Q5/§7: buyers keep the post-delivery request flow — never captured at order-entry
    // time. `@Roles` on the controller already excludes CUSTOMER, but this is the money-
    // writing-adjacent quote path, so it's refused explicitly here too (defense in depth —
    // matches the house convention of never trusting a decorator alone for a money surface).
    if (user.role === UserRole.CUSTOMER) {
      throw new ForbiddenException("Buyers cannot capture returns at order entry");
    }
    // #2695: a driver's override is a 400 before any read; staff overrides are validated here too.
    const overrides = creditOverridesOf(dto.items, user);

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
      select: { id: true, pricingTier: true, isTaxExempt: true, isWalkIn: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    // SA-740 (row 190): the walk-in is decided HERE from the row, never from the client. A walk-in names its source sale
    // (the quote requires it; the capture defaults to the carrying order); a named customer is pinned only if they send one.
    const walkIn = customer.isWalkIn === true;
    const sourceOrderId = await resolveSourceSale(db, {
      customerId: dto.customerId,
      isWalkIn: walkIn,
      requested: dto.sourceOrderId,
      defaultSourceOrderId: opts.defaultSourceOrderId,
    });

    const productIds = [...new Set(dto.items.map((i) => i.productId))];

    // products must resolve BEFORE the matching set: fetchMatchingSet needs each
    // product's own unitsPerBox to fall back on when an invoice line's own unitsPerBox
    // snapshot is null (DRAFT invoices store boxed lines with unitsPerBox: null —
    // invoices.service.ts's `update()`), matching the orders fallback convention at
    // invoices.service.ts:427-428.
    const [customerPrices, products] = (await Promise.all([
      db.customerPrice.findMany({
        where: { customerId: dto.customerId, productId: { in: productIds } },
        select: { productId: true, pricingTier: true },
      }),
      db.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          name: true,
          pricePerUnit: true,
          priceTier2: true,
          priceTier3: true,
          priceTier4: true,
          priceTier5: true,
          unitsPerBox: true,
        },
      }),
      // `db` is typed loosely (`any` — see priceInlineReturn's doc comment) so a plain `tx`
      // client is a valid caller too; that makes both findMany calls resolve to `any` at
      // this call's type-check, but a Promise.all over TWO `any`s can still infer `unknown`
      // element types depending on the caller's own inference context — cast explicitly so
      // `products`/`customerPrices` are never anything narrower than `any[]` below.
    ])) as [any[], any[]];

    const productMap = new Map(products.map((p) => [p.id, p]));
    const productUpbMap = new Map(products.map((p) => [p.id, p.unitsPerBox]));
    const matchingSet = await this.fetchMatchingSet(
      db,
      dto.customerId,
      productIds,
      productUpbMap,
      undefined,
      opts.excludeInvoiceIds,
      sourceOrderId,
    );

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
      const prior = priorReturnedMap.get(sourceOrderId)?.[productId];
      // An unclassifiable prior refuses THIS product's line below; the supply entry is inert.
      const priorReturned = prior && "pieces" in prior ? prior.pieces : 0;
      remainingByKey.push({
        sourceOrderId,
        productId,
        remainingPieces: Math.max(0, sold - priorReturned),
      });
    }

    const productBreakdown: Record<string, QuoteBreakdown> = {};
    const allChunks: PricedChunk[] = [];

    // PR-1b deferred item / m-7 sibling: §3.2 cases 2/3 price an unreferenced chunk's tax at
    // the tenant's CURRENT rate — the same reader orders.service.ts's getTaxRate() uses, via
    // common/tax-rate.ts's shared currentTaxRate() (never a hand-rolled 0, and never the
    // matched-chunk SNAPSHOT rate, which stays m-7's `line.taxRate` verbatim). Read once per
    // quote — it does not vary per item — never inside the per-item loop below.
    const tenantTaxRate = await currentTaxRate(this.systemConfig);

    // B961 (SA-071h): the in-window candidate lines of this product carry prior returns (priorReturnedMap) or non-refund credits.
    const windowHasPriorReturns = async (productId: string): Promise<boolean> => {
      const lines = matchingSet.filter((l) => l.productId === productId);
      if (lines.length === 0) return false;
      for (const orderId of new Set(lines.map((l) => l.sourceOrderId))) {
        const prior = priorReturnedMap.get(orderId)?.[productId];
        if (prior && "pieces" in prior && prior.pieces > 0) return true;
      }
      return (await this.creditNotedPiecesOutsideReturns(db, lines)) > 0;
    };

    // B961 (SA-071f): Σ returned + Σ credit-noted pieces >= Σ sold pieces across ALL this customer's live invoices of the product.
    // Cached per product; an unclassifiable prior return counts as exhausted (fail toward staff review).
    const lifetimeCache = new Map<string, boolean>();
    const lifetimeExhausted = async (productId: string): Promise<boolean> => {
      const cached = lifetimeCache.get(productId);
      if (cached !== undefined) return cached;
      // ONE product-filtered read of the sold lines (null window = whole history; only invoices that HAVE the product)
      const lifeSet = await this.fetchMatchingSet(
        db,
        dto.customerId,
        [productId],
        productUpbMap,
        null,
        opts.excludeInvoiceIds,
      );
      const lines = lifeSet.filter((l) => l.productId === productId);
      const sold = lines.reduce((n, l) => n + l.piecesQty, 0);
      let exhausted = false;
      if (sold > 0) {
        const { returned, unknown } = await this.lifetimeReturned(
          db,
          lines,
          productId,
          priorReturnedMap,
        );
        const credited = unknown ? 0 : await this.creditNotedPiecesOutsideReturns(db, lines);
        exhausted = unknown || returned + credited >= sold - 0.001;
      }
      lifetimeCache.set(productId, exhausted);
      return exhausted;
    };

    for (const item of dto.items) {
      const product = productMap.get(item.productId);

      // SA-101(2)/B3/B765 interim guard, precision round SA-107/SA-108: resolve the pack
      // size from EVERY candidate line for this product, not just the newest
      // (`matchingSet.find(...)` picked the first — i.e. newest-invoice — match, silently
      // applying ITS pack size even when an older line, the one the operator was actually
      // shown, used a different one). A product whose candidate lines DISAGREE on a pack
      // size > 1 refuses outright rather than guess. This refusal set is a SUPERSET of the
      // pricing set below (it includes lines already exhausted or at 0 remaining pieces),
      // so the interim can over-refuse a line that pricing itself would never have touched
      // — the safe direction, accepted for this interim guard.
      const candidatePacksForProduct = matchingSet
        .filter((l) => l.productId === item.productId)
        .map((l) => l.unitsPerBox);
      const { factor: resolvedUnitsPerBox, conflictingPacks } = resolveReturnPackFactor(
        candidatePacksForProduct,
        product?.unitsPerBox ?? null,
      );
      const productName = product?.name ?? "This product";
      // SA-159: a prior STANDARD return of THIS product whose basis cannot be classified refuses only
      // this product's line; other products on the same source order still quote.
      for (const orderId of new Set(
        matchingSet.filter((l) => l.productId === item.productId).map((l) => l.sourceOrderId),
      )) {
        const prior = priorReturnedMap.get(orderId)?.[item.productId];
        if (prior && "unknown" in prior) {
          throw new ConflictException({
            code: API_ERROR_CODES.INLINE_RETURN_PRIOR_BASIS_UNKNOWN,
            message: `${productName}: an earlier return on this customer's order cannot be counted (${prior.reason}) — credit it with a credit note or ask support; the standard return cannot classify it either.`,
          });
        }
      }
      if (conflictingPacks) {
        throw new ConflictException({
          code: API_ERROR_CODES.INLINE_RETURN_PACK_CONFLICT,
          message:
            `${productName} is packed at more than one size in this customer's recent ` +
            `history (${conflictingPacks.join(", ")}) — return these lines from the order ` +
            `page's standard return instead.`,
        });
      }
      // A return typed as an explicit BOX count needs a real factor to convert to pieces —
      // an unknown factor must never silently multiply boxes by 0 and credit $0 for real
      // returned goods (the returnRequestPieces boxes*upb branch does exactly that when
      // unitsPerBox is null). `buildQuoteRequest`/`buildCaptureRequest` always send `boxes`
      // explicitly (0 for a non-boxed product), so gating on "boxes was PROVIDED" rather
      // than "boxes is a real, positive count" refused every loose-product return outright
      // — a pieces-only entry (boxes: 0) never needs a pack at all.
      if (
        Number(item.boxes ?? 0) > 0 &&
        (resolvedUnitsPerBox == null || resolvedUnitsPerBox <= 0)
      ) {
        throw new ConflictException({
          code: API_ERROR_CODES.INLINE_RETURN_PACK_UNKNOWN,
          message:
            `${productName}'s pack size is unknown — return these lines from the order ` +
            `page's standard return instead.`,
        });
      }

      const requestedPieces = returnRequestPieces({
        qty: item.qty ?? 0,
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        unitsPerBox: resolvedUnitsPerBox,
      });

      const allocated = allocateReturnedPieces(
        matchingSet,
        remainingByKey,
        item.productId,
        requestedPieces,
      );
      // SA-740: a walk-in never gets an unreferenced chunk (cash out with no sale behind it): over the sale is a 409.
      if (walkIn) assertWalkInCoveredBySale(item.productId, productName, allocated);

      const tierForProduct = tierByProduct.get(item.productId) ?? customer.pricingTier;
      const unreferencedPrice = product ? Number(getTierPrice(product, tierForProduct)) : 0;
      const unreferencedSource = tierByProduct.has(item.productId)
        ? ("CUSTOMER_PRICE" as const)
        : tierForProduct > 1
          ? ("TIER" as const)
          : ("BASE" as const);
      // The candidate lines are ALL the same product's own tax rate lineage; for the
      // unreferenced chunk (no matched line at all) fall back to whichever candidate
      // line names the widest-known rate, else the tenant's CURRENT rate (deferred PR-1b
      // item / §3.2 cases 2/3 — never a hand-rolled 0, which silently zero-taxed every
      // unreferenced chunk on a product with no candidate invoice line at all).
      // B463: when that candidate's invoice charged NO tax (m-7), the over-return is untaxed too: never credit a tax the sale
      // did not charge. A product on no candidate invoice at all takes the tenant's current rate.
      const candidateLine = matchingSet.find((l) => l.productId === item.productId);
      const fallbackTaxRate = candidateLine
        ? candidateLine.invoiceTaxAmount === 0
          ? 0
          : candidateLine.taxRate
        : tenantTaxRate;

      const override = overrides.get(item);
      // B961 (SA-071h): flag = unreferenced AND (the in-window lines carry prior returns/credits OR lifetime exhaustion). The 90-day
      // window still scopes PRICING; an old never-returned sale alone is not exhaustion, but it is no reason for silence when the
      // recent purchases were returned (repeat buyer).
      const hasPriorReturns = allocated.some((c) => !c.line)
        ? (await windowHasPriorReturns(item.productId)) || (await lifetimeExhausted(item.productId))
        : false;
      // The pack an unreferenced chunk is priced (and so overridden) against.
      const unreferencedUpb = product?.unitsPerBox ?? null;
      const chunks: PricedChunk[] = allocated.map((chunk) => {
        const priced = chunk.line
          ? priceMatchedChunk(chunk.line, chunk.pieces, customer.isTaxExempt)
          : priceUnreferencedChunk(
              item.productId,
              chunk.pieces,
              {
                unitPrice: unreferencedPrice,
                source: unreferencedSource,
                unitsPerBox: unreferencedUpb,
              },
              fallbackTaxRate,
              customer.isTaxExempt,
            );
        // B961: the unreferenced chunk of a product the customer DID buy AND already has prior returns of is "already returned
        // or credited", not "not on any invoice"; flagged AFTER pricing so an override keeps it.
        const flag = (c: PricedChunk): PricedChunk =>
          !chunk.line && hasPriorReturns ? { ...c, alreadyReturned: true } : c;
        if (!override) return flag(priced);
        // #2695 (SA-557): lower-only, against THIS chunk's default, at the basis that priced it —
        // a matched chunk's pack and InvoiceItem.taxRate snapshot (m-7: exempt when the invoice
        // charged no tax), an unreferenced chunk's product pack and quote rate.
        const result = applyCreditOverride(
          priced,
          override,
          chunk.line
            ? {
                unitsPerBox: chunk.line.unitsPerBox,
                taxRate: chunk.line.taxRate,
                taxExempt: chunk.line.invoiceTaxAmount === 0 || customer.isTaxExempt,
              }
            : {
                unitsPerBox: unreferencedUpb,
                taxRate: fallbackTaxRate,
                taxExempt: customer.isTaxExempt,
              },
        );
        if (result.overCap) {
          throw new BadRequestException({
            code: RETURN_CREDIT_OVERRIDE_ERROR_CODES.OVER_CAP,
            productId: item.productId,
            creditUnitPrice: override.unitPrice,
            defaultUnitPrice: result.defaultUnitPrice,
            message:
              `${productName}: a credit price can only be lowered — the most this return can ` +
              `credit is $${result.defaultUnitPrice.toFixed(2)} per unit.`,
          });
        }
        return flag(result.chunk);
      });

      productBreakdown[item.productId] = totalChunks(chunks);
      allChunks.push(...chunks);
    }

    return { ...totalChunks(allChunks), productBreakdown };
  }

  /**
   * B961 (SA-071f/h, lead N-a): Σ returned pieces of one product across many source orders in a BOUNDED number of reads (2), never a
   * per-order or per-invoice loop (the capture runs this inside a 5 s transaction). Orders already read for pricing are reused. For the
   * rest: one read of the STANDARD return items (their qty is in the order line's own unit, converted to pieces with that order's
   * sold-line factor, Σ piecesQty / Σ qty of the product's lines on that order) and one of the INLINE items (already pieces). The flag
   * is a soft reason for staff, so this conversion is deliberately the simple one (an unclassifiable pack no longer short-circuits).
   */
  private async lifetimeReturned(
    db: any,
    lines: ReadonlyArray<{ sourceOrderId: string; piecesQty: number; qty: number }>,
    productId: string,
    priorReturnedMap: Map<string, Awaited<ReturnType<typeof returnedPiecesByProduct>>>,
  ): Promise<{ returned: number; unknown: boolean }> {
    const orderIds = [...new Set(lines.map((l) => l.sourceOrderId))];
    let returned = 0;
    let unknown = false;
    const need: string[] = [];
    for (const orderId of orderIds) {
      const known = priorReturnedMap.get(orderId);
      if (!known) need.push(orderId);
      else {
        const prior = known[productId];
        if (prior && "unknown" in prior) unknown = true;
        else returned += prior?.pieces ?? 0;
      }
    }
    if (need.length === 0) return { returned, unknown };
    const notDead = { notIn: ["REJECTED", "CANCELLED"] };
    const [standardItems, inlineItems] = await Promise.all([
      db.returnItem.findMany({
        where: {
          productId,
          return: { orderId: { in: need }, kind: "STANDARD", status: notDead },
        },
        select: { qty: true, return: { select: { orderId: true } } },
      }),
      db.returnItem.findMany({
        where: {
          sourceOrderId: { in: need },
          productId,
          return: { kind: "INLINE", status: notDead },
        },
        select: { sourceOrderId: true, qty: true },
      }),
    ]);
    const factorByOrder = new Map<string, number>();
    for (const orderId of need) {
      const mine = lines.filter((l) => l.sourceOrderId === orderId);
      const qty = mine.reduce((n, l) => n + l.qty, 0);
      factorByOrder.set(orderId, qty > 0 ? mine.reduce((n, l) => n + l.piecesQty, 0) / qty : 1);
    }
    for (const it of (standardItems ?? []) as Array<{
      qty: unknown;
      return: { orderId: string };
    }>) {
      returned += Number(it.qty) * (factorByOrder.get(it.return.orderId) ?? 1);
    }
    for (const it of (inlineItems ?? []) as Array<{ qty: unknown }>) returned += Number(it.qty);
    return { returned, unknown };
  }

  /**
   * B961 (SA-071f): pieces of these invoice lines credited by CREDIT NOTES that are NOT a return's own refund (a return's refund
   * note is already counted as a returned piece by the prior-returned reader, so counting its items too would double it).
   * Non-VOID notes only; qty is on the line's own axis, converted to pieces by the line's piecesQty / qty.
   */
  private async creditNotedPiecesOutsideReturns(
    db: any,
    lines: ReadonlyArray<{ sourceInvoiceItemId: string; piecesQty: number; qty: number }>,
  ): Promise<number> {
    const ids = lines.map((l) => l.sourceInvoiceItemId);
    const items: Array<{ invoiceItemId: string | null; qty: unknown; creditNoteId: string }> =
      (await db.creditNoteItem.findMany({
        where: { invoiceItemId: { in: ids }, creditNote: { status: { not: "VOID" } } },
        select: { invoiceItemId: true, qty: true, creditNoteId: true },
      })) ?? [];
    if (items.length === 0) return 0;
    const noteIds = [...new Set(items.map((i) => i.creditNoteId))];
    const linked: Array<{ creditNoteId: string | null }> =
      (await db.return.findMany({
        where: { creditNoteId: { in: noteIds } },
        select: { creditNoteId: true },
      })) ?? [];
    const returnNotes = new Set(linked.map((r) => r.creditNoteId));
    const byId = new Map(lines.map((l) => [l.sourceInvoiceItemId, l]));
    let pieces = 0;
    for (const it of items) {
      if (returnNotes.has(it.creditNoteId)) continue;
      const line = it.invoiceItemId ? byId.get(it.invoiceItemId) : undefined;
      if (!line || !(line.qty > 0)) continue;
      pieces += Number(it.qty ?? 0) * (line.piecesQty / line.qty);
    }
    return pieces;
  }

  /** §3.1's matching set: REAL_INVOICE_STATUSES ∪ non-VOID DRAFT of a DELIVERED/
   * PARTIALLY_DELIVERED order, within the sold window, newest invoice first. */
  private async fetchMatchingSet(
    db: ReturnType<PrismaService["forTenant"]>,
    customerId: string,
    productIds: string[],
    productUpbMap: Map<string, number | null>,
    // null = the customer's WHOLE history (B961's lifetime flag): no date filter, and only invoices that HAVE the product
    soldWindowDays: number | null = DEFAULT_SOLD_WINDOW_DAYS,
    excludeInvoiceIds: readonly string[] = [],
    // SA-740: pin the matching set to ONE source sale (the walk-in rule, or a named customer who named one)
    sourceOrderId: string | null = null,
  ): Promise<CandidateInvoiceLine[]> {
    const since = new Date();
    since.setDate(since.getDate() - (soldWindowDays ?? 0));

    const invoices = await db.invoice.findMany({
      where: {
        customerId,
        orderId: sourceOrderId ?? { not: null },
        ...(excludeInvoiceIds.length > 0 ? { id: { notIn: [...excludeInvoiceIds] } } : {}),
        ...(soldWindowDays === null
          ? { items: { some: { productId: { in: productIds } } } }
          : { issueDate: { gte: since } }),
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
        // the line's own axis for proration inside priceMatchedChunk. A DRAFT invoice's
        // `update()` (invoices.service.ts:3500) can store a boxed line with unitsPerBox:
        // null, so first try recovering the pack from THIS line's own boxes/pieces/qty split
        // (SA-101(a)/SA-107 — a null-snapshot line still names its own pack via the split it
        // was actually stored with) before falling back to the product's CURRENT unitsPerBox
        // — same convention as the orders' category-tax fallback at
        // invoices.service.ts:427-428. Resolved ONCE here and stored on the line itself so
        // priceMatchedChunk and resolveReturnPackFactor's refusal set both see the same value.
        const upb =
          item.unitsPerBox ??
          packFromOwnSplit({ qty, boxes: item.boxes, pieces: item.pieces }) ??
          productUpbMap.get(item.productId) ??
          null;
        const upbNum = Number(upb) || 0;
        // B661-sweep: a box-unaware multiply — follow-up PR converts this to
        // @routeflow/pricing's regulatedUnitBasis; see no-second-legacy-line-pieces.spec.ts's allowlist.
        const piecesQty = item.boxes != null ? qty : upbNum > 1 ? qty * upbNum : qty;
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
          unitsPerBox: upb,
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
