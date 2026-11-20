import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { assertSellableLines } from "../products/sellable-lines";
import { EstimateStatus, PriceType } from "@prisma/client";
import { assertRefsInTenant } from "../common/assert-refs-in-tenant";
import { PrismaService } from "../prisma/prisma.service";
import {
  computeLineSubtotal,
  decideStaffOverride,
  getTierPrice,
  isSpecialPrice,
  round4,
  roundMoney,
  withinStaffOverrideTolerance,
  type DiscountTaxBase,
} from "@routeflow/pricing";
import { loadMsrpMap } from "../common/msrp";
import { discountModeOf, newDocumentDiscountMode } from "../common/discount-tax-mode";
import { configuredTaxRateFraction } from "../common/tax-rate";
import { assertNsfLinesUntaxed } from "../invoices/nsf-line-tax-guard";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { defaultSaleFulfilmentKind } from "../orders/default-sale-fulfilment";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import * as iGate from "../invoices/invoice-restriction-gate";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import {
  LINE_NAME_PRODUCT_SELECT,
  displayLineDescription,
  withFamilyNames,
} from "../invoices/invoice-line-name";
import { buildManualInvoiceLines } from "../invoices/manual-invoice-lines";
import { loadManualLineContext, zeroExemptCategoryTax } from "../invoices/manual-invoice-context";
import { packAtSaleByProduct, toSaleLedgerLines } from "../invoices/pack-at-sale";
import { resolveLineUnits } from "../products/line-units";
import { estimateConvertLineItems } from "./estimate-convert-lines";
import { NumberingService } from "../import/numbering.service";
import {
  assertMoneyInvariantsOrThrow,
  sumInvoiceTotalsStrict,
  assertNoNegativeLineSubtotal,
} from "../common/money-invariants.util";
import { assertNoUnitAwareLines } from "../orders/unit-aware-guard";
import { customerPricing } from "../orders/units-prices-v2";
import {
  CreateEstimateDto,
  CreateEstimateItemDto,
  UpdateEstimateDto,
} from "./dto/create-estimate.dto";
import { priceEditAllowedFor } from "../auth/permissions/price-edit";
import { stampInvoicePositions } from "../invoices/invoice-line-position";
import { assertCustomPricesAllowed, assertPriceEditAllowed } from "../orders/staff-override";
import { describeUniqueViolation, uniqueViolationOn } from "../common/prisma-unique";

// B70: terminal status set — CONVERTED is terminal and cannot be re-transitioned; voided
// (DECLINED) is also terminal per the requirement that send/decline/accept refuse both.
export const TERMINAL_ESTIMATE_STATUSES = [
  "CONVERTED",
  "DECLINED",
] as const satisfies readonly EstimateStatus[];

/** A line as a create or draft-edit request sends it; `id` names the held line an edit re-sends. */
type EstimateLineInput = CreateEstimateItemDto & { id?: string };

/** A draft's stored line, as the price-rights check reads it (a re-sent, unchanged price is no new authoring). */
interface HeldEstimateLine {
  id: string;
  productId: string | null;
  unitPrice: number;
}

/** The one refusal for editing an estimate that is not a draft. */
const notDraftRefusal = (status: string) =>
  new BadRequestException(
    `${status.charAt(0)}${status.slice(1).toLowerCase()} estimates cannot be edited. Move the estimate back to draft first.`,
  );

/**
 * B79: issueDate is optional and, unlike expiresAt, has no legacy loose-parse behavior to preserve — validate the shape
 * before touching the DB so a malformed value 400s instead of writing Invalid Date or a misparsed date.
 */
function parseIssueDate(value: string | null | undefined): Date | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException("issueDate must be YYYY-MM-DD");
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  // The regex alone accepts an out-of-range day/month (e.g. "2026-02-31"), which Date's day-rollover then silently
  // turns into "2026-03-03" instead of failing — round-trip through ISO and compare to catch that class.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException("issueDate must be YYYY-MM-DD");
  }
  return d;
}

@Injectable()
export class EstimatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly numbering: NumberingService,
    private readonly ledger: RegulatedLedgerService,
    private readonly sellingRestrictions: SellingRestrictionsService,
    // #2198/SA-397: flag.msrp asks the same evaluation point as the route guard.
    private readonly authority: EntitlementAuthority,
  ) {}

  private readonly logger = new Logger(EstimatesService.name);

  /** #2198/SA-397: flag.msrp asks EntitlementAuthority, the same evaluation point as the route guard. */
  private async msrpEnabled(tenantId: string | null | undefined): Promise<boolean> {
    return !!tenantId && (await this.authority.can(tenantId, "flag.msrp"));
  }

  /**
   * B70: atomic claim for estimate status transitions. Ensures only one call succeeds
   * when multiple transitions are attempted concurrently; throws NotFoundException if
   * estimate is missing, or BadRequestException if the estimate is in one of `exclude`
   * and the transition is not allowed. `exclude` defaults to the full terminal set
   * (CONVERTED + DECLINED/voided); accept() passes a narrower set — see its call site
   * for why DECLINED is not terminal there.
   */
  private async claimTransition(
    id: string,
    to: EstimateStatus,
    refusal: (humanizedActualStatus: string) => string,
    exclude: readonly EstimateStatus[] = TERMINAL_ESTIMATE_STATUSES,
  ): Promise<void> {
    const r = await this.prisma.forTenant().estimate.updateMany({
      where: {
        id,
        status: { notIn: [...exclude] },
      },
      data: { status: to },
    });
    if (r.count === 1) return;
    const row = await this.prisma.forTenant().estimate.findFirst({
      where: { id },
    });
    if (!row) throw new NotFoundException("Estimate not found");
    // Name the row's REAL current status, not whichever exclusion member the
    // caller wrote the message around — refusing a repeat void/decline of an
    // already-DECLINED row must say Declined, not always claim "Converted".
    // Humanized (Title case) to match the pre-existing message style, since
    // the enum itself is upper-case ("CONVERTED", "DECLINED").
    const humanStatus = row.status.charAt(0) + row.status.slice(1).toLowerCase();
    throw new BadRequestException(refusal(humanStatus));
  }

  /**
   * The next `EST-<year>-####` number, from the SAME per-tenant-year primitive the
   * invoice series uses (fix-round-2.md D2). The inline scan this replaces was the
   * condemned B100 generator verbatim: `orderBy { estimateNumber: "desc" }` on TEXT
   * (so `EST-2026-10000` sorted below `EST-2026-9999` and the series stuck at the
   * 4-digit wall) over a `startsWith` filter that only the `forTenant()` extension
   * scoped. Format is preserved byte-for-byte — prefix "EST-", the year segment, and
   * `padStart(4)` widening rather than truncating past 9999 — because
   * `DEFAULTS.ESTIMATE` is `{ prefix: "EST-", padding: 4 }` and `format()` emits
   * `${prefix}${year}-${padded}` whenever `year > 0`. Reserved in reserveNext's own
   * short transaction: a rollback after this call leaves a gap in the series.
   */
  private async nextEstNumber() {
    const year = new Date().getFullYear();
    return this.numbering.reserveNext("ESTIMATE", {
      year,
      tenantId: this.prisma.getTenantId() ?? undefined,
    });
  }

  async create(dto: CreateEstimateDto, actor: JwtPayload) {
    const issueDate = parseIssueDate(dto.issueDate);
    const priced = await this.priceEstimate(dto.customerId, dto.items ?? [], actor, [], {
      discount: Number((dto as any).discount ?? 0),
      discountBase: newDocumentDiscountMode(), // SA-1141 R3: a new quote is stamped now
    });

    try {
      return await this.prisma.forTenant().estimate.create({
        data: {
          estimateNumber: await this.nextEstNumber(),
          customerId: dto.customerId,
          status: "DRAFT",
          subtotal: priced.subtotal,
          taxAmount: priced.tax,
          discount: priced.discount,
          total: priced.total,
          issueDate,
          expiresAt: dto.expiresAt
            ? new Date(dto.expiresAt)
            : dto.expiryDate
              ? new Date(dto.expiryDate)
              : null,
          notes: dto.notes,
          terms: dto.terms,
          items: { create: priced.itemsData },
        },
        include: { customer: { select: { id: true, businessName: true } }, items: true },
      });
    } catch (err: any) {
      // B277 pin (cause-ruling.md §2 D5): reserveNext is already collision-guarded,
      // so this is a zero-risk consistency catch — same shape as convertToInvoice's
      // P2002 catch below, applied to the estimate number instead of the invoice one.
      // The try also spans `items: { create: itemsData }`, so only a P2002 whose
      // constraint actually names estimateNumber is a number conflict; anything
      // else propagates untouched, and every P2002 leaves a log line.
      if (err?.code === "P2002") {
        this.logger.warn(
          `Estimate create failed customer=${dto.customerId} code=P2002 target=${describeUniqueViolation(err)}`,
        );
        if (uniqueViolationOn(err, "Estimate_tenantId_estimateNumber_key", { exact: true }))
          throw new ConflictException("Estimate number conflict — please retry.");
      }
      throw err;
    }
  }

  /**
   * Edit a DRAFT estimate: customer, dates, notes, terms and (replace-all) lines. The lines are priced by the SAME
   * `priceEstimate` create runs, so a draft edit and a fresh quote store the same price for the same input. Omitted
   * `items` re-prices the held lines as they stand (a customer change moves their tier prices). Only a DRAFT is
   * editable: a sent or accepted quote goes back to draft first (`revertToDraft`), a converted or void one never.
   */
  async update(id: string, dto: UpdateEstimateDto, actor: JwtPayload) {
    const held = await this.prisma.forTenant().estimate.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!held) throw new NotFoundException("Estimate not found");
    if (held.status !== "DRAFT") throw notDraftRefusal(held.status);

    const issueDate = dto.issueDate !== undefined ? parseIssueDate(dto.issueDate) : undefined;
    const customerId = dto.customerId ?? held.customerId;
    const heldLines: HeldEstimateLine[] = held.items.map((it: any) => ({
      id: it.id,
      productId: it.productId ?? null,
      unitPrice: Number(it.unitPrice),
    }));
    // No `items`: the held lines as they stand. A held typed price (DISCOUNTED / MANUAL, or a custom line) is re-sent
    // as typed; a tier-priced line is re-priced at the (possibly new) customer's tier, exactly as create would.
    const items: EstimateLineInput[] =
      dto.items ??
      held.items.map((it: any) => ({
        id: it.id,
        productId: it.productId ?? undefined,
        description: it.description,
        qty: Number(it.qty),
        boxes: it.boxes ?? undefined,
        pieces: it.pieces ?? undefined,
        ...(!it.productId || it.priceType === "DISCOUNTED" || it.priceType === "MANUAL"
          ? { unitPrice: Number(it.unitPrice) }
          : {}),
      }));
    const priced = await this.priceEstimate(customerId, items, actor, heldLines, {
      discount: Number(held.discount ?? 0),
      discountBase: discountModeOf(held), // a draft edit keeps the quote's own discount mode
    });

    const header = {
      customerId,
      subtotal: priced.subtotal,
      taxAmount: priced.tax,
      discount: priced.discount,
      total: priced.total,
      ...(issueDate !== undefined ? { issueDate } : {}),
      ...(dto.expiresAt !== undefined
        ? { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }
        : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes.trim() || null } : {}),
      ...(dto.terms !== undefined ? { terms: dto.terms.trim() || null } : {}),
    };
    await this.prisma.tenantTransaction(async (tx) => {
      // The claim is the authority: a draft sent (or edited) between the read above and here is refused, never
      // silently overwritten with lines priced for a document the customer has already seen.
      const claimed = await tx.estimate.updateMany({
        where: { id, status: "DRAFT" },
        data: header,
      });
      if (claimed.count !== 1) {
        const now = await tx.estimate.findFirst({ where: { id }, select: { status: true } });
        if (!now) throw new NotFoundException("Estimate not found");
        throw notDraftRefusal(now.status);
      }
      await tx.estimateItem.deleteMany({ where: { estimateId: id } });
      await tx.estimateItem.createMany({
        data: priced.itemsData.map((it) => ({ ...it, estimateId: id })),
      });
    });
    return this.findOne(id);
  }

  /**
   * Bring a SENT or ACCEPTED estimate back to DRAFT so it can be revised and sent again. A CONVERTED estimate has an
   * invoice and stays converted; a DECLINED one is also how a void is stored today, so it stays closed (duplicate it
   * to quote again).
   */
  async revertToDraft(id: string) {
    await this.claimTransition(
      id,
      "DRAFT",
      (status) => `${status} estimates cannot be moved back to draft`,
      ["DRAFT", ...TERMINAL_ESTIMATE_STATUSES],
    );
    return this.findOne(id);
  }

  /**
   * The ONE line-pricing path for an estimate (create and draft edit). `held` are the draft's stored lines on an edit:
   * a line re-sent with its held id, product and price is no new authoring (SA-1034: "a resubmitted, unchanged line is
   * no authoring"), so neither price-rights check runs for it.
   */
  private async priceEstimate(
    customerId: string,
    items: EstimateLineInput[],
    actor: JwtPayload,
    held: HeldEstimateLine[],
    /** The quote's discount and its discount mode: a new quote is stamped now, a draft edit keeps its own. */
    totalsOpts: { discount: number; discountBase: DiscountTaxBase },
  ) {
    // 681 (R5-5): the estimate stores its customer and each item's productId; prove both in this tenant (one 404 for
    // foreign or missing) before any policy read and before the write.
    await assertRefsInTenant(this.prisma, {
      customerIds: [customerId],
      productIds: items.map((i) => i.productId),
    });
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException("Customer not found");

    const tenantId = this.prisma.getTenantId();
    const heldById = new Map(held.map((h) => [h.id, h]));
    const unchanged = (i: EstimateLineInput) => {
      const h = i.id ? heldById.get(i.id) : undefined;
      return (
        !!h &&
        h.productId === (i.productId ?? null) &&
        i.unitPrice != null &&
        withinStaffOverrideTolerance(Number(i.unitPrice), h.unitPrice)
      );
    };
    const authoring = items.filter((i) => !unchanged(i));
    // A custom line has no product to price it: its typed price is required (it would otherwise write NaN).
    if (items.some((i) => !i.productId && i.unitPrice == null)) {
      throw new BadRequestException("A custom line needs a price");
    }
    // SA-1034 rules 4-5: a custom estimate line, and a typed catalog price off the customer's price, are staff-typed
    // prices. The capability is read once here, before the write, and only when a NEW or changed line types a price.
    // The actor is required: the controller is the only caller.
    const needsPriceRights = authoring.some((i) => !i.productId || i.unitPrice != null);
    const priceEditAllowed =
      !needsPriceRights ||
      (await priceEditAllowedFor(this.prisma, actor, "EstimatesService.priceEstimate"));
    assertCustomPricesAllowed(authoring, priceEditAllowed);
    // H5: a quote is taxed the way an invoice is - the tenant rate and the customer's exempt flag, today.
    const taxRate = await configuredTaxRateFraction(this.prisma);
    const isTaxExempt = !!customer.isTaxExempt;

    // Load products for items that reference a product
    const productIds = items.map((i) => i.productId).filter((p): p is string => !!p);
    const products =
      productIds.length > 0
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: productIds } },
            include: { parent: { select: { name: true } } }, // the family's name: a variant line reads "<Family> - <Variant>"
          })
        : [];
    const productMap = new Map(products.map((p) => [p.id, p]));
    assertSellableLines(products); // WS8: a FAMILY is never a line

    // Load per-product tier overrides for this customer
    const customerPrices =
      productIds.length > 0
        ? await this.prisma.forTenant().customerPrice.findMany({
            where: { customerId, productId: { in: productIds } },
          })
        : [];
    // S19: tier maps + (flag.units_prices_v2 only) the customer's typed pack prices; flag off = master's values.
    const svc = { prisma: this.prisma, entitlements: this.entitlements };
    const pc = await customerPricing(svc, customerId, productIds, customer, customerPrices);
    const { defaultTier, cpMap } = pc;

    let subtotal = 0;
    const itemsData = items.map((i) => {
      const product = i.productId ? productMap.get(i.productId) : null;
      // B645 / line-units-callsites ratchet: read this ONCE and reuse it below
      // (qty resolution, computeLineSubtotal, and the B645 snapshot on the
      // returned item) rather than re-reading `product.unitsPerBox` at each
      // site — keeps this file's direct-read count at the ratchet's baseline
      // instead of adding a third counted read for the same value.
      const productUnitsPerBox = product?.unitsPerBox ?? null;

      // Resolve qty from boxes/pieces when provided
      let qty = Number(i.qty);
      if (product && (i.boxes != null || i.pieces != null)) {
        const unitsPerBox = Number(productUnitsPerBox ?? 0);
        qty = (i.boxes ?? 0) * unitsPerBox + (i.pieces ?? 0);
      }

      let unitPrice: number;
      let priceType: PriceType = PriceType.STANDARD;
      let originalPrice: number | null = null;

      if (product) {
        // Resolve tier: per-product override > customer default tier
        const tierForProduct = cpMap.get(product.id) ?? defaultTier;
        const layer = pc.layer(product);
        const tierPrice = layer?.price ?? getTierPrice(product, tierForProduct);
        const listPrice = layer?.listPrice ?? Number(product.pricePerUnit);
        // H5: a typed override is money - cents, like every other written price
        const overridePrice = i.unitPrice != null ? roundMoney(Number(i.unitPrice)) : null;

        const isSpecialTier = isSpecialPrice(tierForProduct, listPrice, layer?.price);

        if (overridePrice != null) {
          // The staff-override rule every sale path uses (@routeflow/pricing), judged against the CUSTOMER's price:
          // within half a cent of it is that price (no override); below list is DISCOUNTED, at or above list MANUAL. A
          // quote carries no override reason, so the special-tier reason rule (an invoice's) is not asked here.
          const d = decideStaffOverride({
            overridePrice,
            baselinePrice: tierPrice,
            listPrice,
            isSpecialTier,
            hasReason: true,
          });
          if ("refused" in d) throw new BadRequestException("A reason is required for this price");
          const overridden = d.priceType === "DISCOUNTED" || d.priceType === "MANUAL";
          // SA-1034 rule 5: a typed price off the customer's price is a staff price override (a held one re-sent is not).
          if (overridden && !unchanged(i)) assertPriceEditAllowed(priceEditAllowed);
          unitPrice = d.unitPrice;
          // S19 R2: the customer's own price above the unit's list, echoed back, stays the sticky upsell's twin.
          priceType =
            layer?.aboveList && d.priceType === "SPECIAL"
              ? PriceType.MANUAL
              : PriceType[d.priceType];
          originalPrice = d.originalPrice;
        } else if (isSpecialTier) {
          unitPrice = tierPrice;
          // S19 R2: the customer's own price above the unit's list is the sticky upsell's twin
          priceType = layer?.aboveList ? PriceType.MANUAL : PriceType.SPECIAL;
          originalPrice = listPrice;
        } else {
          unitPrice = tierPrice;
          priceType = PriceType.STANDARD;
        }
      } else {
        // Freeform item — the typed price, in cents (H5)
        unitPrice = roundMoney(Number(i.unitPrice));
      }

      const sub = computeLineSubtotal({
        unitPrice,
        qty,
        boxes: i.boxes ?? null,
        pieces: i.pieces ?? null,
        unitsPerBox: productUnitsPerBox,
      });
      subtotal += sub;
      return {
        description: displayLineDescription(i.description ?? product?.name ?? "", product),
        productId: i.productId ?? null,
        qty,
        unitPrice,
        subtotal: sub,
        priceType,
        originalPrice,
        boxes: i.boxes ?? null,
        pieces: i.pieces ?? null,
        // B645: snapshot the SAME factor just used above for qty/subtotal — the
        // live product's unitsPerBox at creation time — rather than letting it be
        // computed, spent, and discarded. Without this, a future repack of the
        // product silently changes what this estimate line means on any later
        // recompute (edit, convert, re-price). Null exactly when the line isn't
        // boxed, matching InvoiceItem's twin column.
        unitsPerBox: productUnitsPerBox,
        tenantId,
      };
    });

    subtotal = roundMoney(subtotal);
    // B451 gap 4: `discount` is not a declared input today (no caller sends one); a draft edit keeps the held value.
    // `taxAmount` is never an input (H5): it is computed, below.
    const discount = roundMoney(Number(totalsOpts.discount ?? 0));
    // H5: the invoice rule - each line's subtotal x the rate, summed unrounded, rounded once; $0 when exempt.
    const taxed = sumInvoiceTotalsStrict(
      itemsData.map((it) => ({ subtotal: it.subtotal, taxRate })),
      { discount, isTaxExempt, discountBase: totalsOpts.discountBase }, // SA-1141 R3: a new quote is stamped now
    );
    const tax = taxed.regularTax;
    const total = roundMoney(subtotal - discount + tax);

    assertMoneyInvariantsOrThrow({ subtotal, discount, tax, total });
    return { itemsData, subtotal, discount, tax, total };
  }

  async findAll(
    customerId?: string,
    status?: string,
    search?: string,
    dateFrom?: string,
    dateTo?: string,
    page = 1,
    limit = 20,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (customerId) where.customerId = customerId;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo + "T23:59:59.999Z");
    }
    if (search) {
      where.OR = [
        { estimateNumber: { contains: search, mode: "insensitive" } },
        { customer: { businessName: { contains: search, mode: "insensitive" } } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.forTenant().estimate.findMany({
        where,
        include: { customer: { select: { id: true, businessName: true } }, items: true },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.forTenant().estimate.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const est = await this.prisma.forTenant().estimate.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true } },
        items: {
          include: { product: { select: { id: true, unit: true, ...LINE_NAME_PRODUCT_SELECT } } },
        },
      },
    });
    if (!est) throw new NotFoundException("Estimate not found");
    return { ...est, discountTaxBase: discountModeOf(est), items: withFamilyNames(est.items) }; // a quote line still holding the bare variant name reads "<Family> - <Variant>"
  }

  async send(id: string) {
    await this.claimTransition(id, "SENT", (status) => `${status} estimates cannot be re-sent`);
    return this.prisma.forTenant().estimate.findUniqueOrThrow({ where: { id } });
  }
  // Atomic claim: a CONVERTED estimate must never be re-accepted, or the convert path
  // below could see it as ACCEPTED again. Deliberately excludes ONLY CONVERTED (not
  // the full TERMINAL_ESTIMATE_STATUSES set): accept() has always allowed
  // DECLINED -> ACCEPTED (a pre-existing, pre-B70 invariant — staff can override a
  // decline), and that stays true here. This does not reopen the laundering chain
  // B70 closed: CONVERTED is an absorbing state across every writer of `status` —
  // voidEstimate()/send()/decline() below each atomically refuse to act on an
  // already-CONVERTED row (excluding the full terminal set), so nothing can ever
  // move a CONVERTED estimate back to ACCEPTED. THAT is what actually gates a second
  // invoice — convertToInvoice()'s own ACCEPTED->CONVERTED claim only prevents two
  // *concurrent* converts of one already-ACCEPTED estimate; it does not by itself stop
  // a laundered one, so never relax voidEstimate/send/decline's exclusion set while
  // trusting this claim alone.
  async accept(id: string) {
    await this.claimTransition(
      id,
      "ACCEPTED",
      (status) => `${status} estimates cannot be re-accepted`,
      ["CONVERTED"],
    );
    return this.prisma.forTenant().estimate.findUniqueOrThrow({ where: { id } });
  }
  async decline(id: string) {
    await this.claimTransition(
      id,
      "DECLINED",
      (status) => `${status} estimates cannot be declined`,
    );
    return this.prisma.forTenant().estimate.findUniqueOrThrow({ where: { id } });
  }
  async voidEstimate(id: string) {
    await this.claimTransition(id, "DECLINED", (status) => `${status} estimates cannot be voided`);
    return this.prisma.forTenant().estimate.findUniqueOrThrow({ where: { id } });
  }

  async convertToInvoice(id: string, actor?: JwtPayload, ack?: iGate.Ack) {
    // D9 (fix-round-2b.md): validate BEFORE reserving. Every reservation commits on
    // its own (see below), so a convert rejected AFTER one burns a number for good —
    // and "estimate missing" / "not ACCEPTED" is the ordinary rejection here, not a
    // rare one (any repeat click on an already-converted estimate hits it). This read
    // is advisory only: the authoritative check stays the atomic claim inside the
    // transaction, so a race LOSER still burns a number (accepted, rare) while the
    // common rejection now costs nothing.
    const existing = await this.prisma.forTenant().estimate.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        customerId: true,
        subtotal: true,
        discount: true,
        taxAmount: true,
        total: true,
        items: {
          orderBy: { id: "asc" }, // B659 finding 4: pins "line N" to the SAME line the tx builds
          select: {
            id: true,
            description: true,
            productId: true,
            qty: true,
            unitPrice: true,
            subtotal: true,
            boxes: true,
            pieces: true,
            unitLabel: true,
            unitsPerBox: true,
          },
        },
      },
    });
    if (!existing) throw new NotFoundException("Estimate not found");
    if (existing.status !== "ACCEPTED") {
      throw new BadRequestException("Only ACCEPTED estimates can be converted");
    }
    // units_v1: no DTO can write a unit-aware estimate line today, but refuse it here — BEFORE a
    // number is reserved — with the same fence every other line rewrite/copy path uses. There is no
    // estimate-update path, so a hit here has no remedy short of voiding the estimate.
    assertNoUnitAwareLines(existing.items ?? [], "converted to an invoice");
    // B659 finding 5: the SAME guards InvoicesService.create() runs on a manual invoice — a
    // negative line subtotal, an invoice-level discount over subtotal, a negative total — run here
    // from the ESTIMATE'S OWN stored totals, before a number is reserved. The tx below recomputes
    // its own totals from the resolved lines, but a corrupt estimate must never burn a number first.
    assertNoNegativeLineSubtotal(existing.items ?? []);
    assertMoneyInvariantsOrThrow({
      subtotal: Number(existing.subtotal),
      discount: Number(existing.discount ?? 0),
      tax: Number(existing.taxAmount ?? 0),
      total: Number(existing.total),
    });
    // B659: a box-split line whose quoted pack cannot be established refuses here, BEFORE a number is
    // reserved (a deterministic rejection must not burn one per click).
    estimateConvertLineItems(existing.items ?? [], 0);
    // F-05 (#2093): an estimate becoming an invoice SELLS its goods — a banned product refuses (409) BEFORE a
    // number is reserved. Judged now, at the sale, by the tenant's rules (owner rulings 2026-09-25).
    const tenant = iGate.tenantId(this.prisma);
    const restriction = await this.sellingRestrictions.assertLinesSellable({
      ...iGate.copy(tenant, existing.customerId, existing.items, actor, ack, {
        // no order: how the next order would go
        fulfilmentKind: await defaultSaleFulfilmentKind(this.prisma, tenant, existing.customerId),
      }),
      channel: "STAFF",
    });

    // B100/F16b: reserved BEFORE the transaction below opens (fix-round-2.md D1).
    // reserveNext commits its own short transaction, so this one never holds the
    // NumberingSequence row lock, and it is not called from inside the transaction
    // either — that would need a second pooled connection while this one is held and
    // starves the pool under concurrent mints (REG-B100-C).
    const year = new Date().getFullYear();
    const invoiceNumber = await this.numbering.reserveNext("INVOICE", { year });
    return this.prisma.tenantTransaction(async (tx) => {
      // Claim before creating anything: two concurrent converts both passed the
      // old read-then-check and both minted an invoice. Claiming inside the tx
      // means a later failure rolls the claim back too.
      const claimed = await tx.estimate.updateMany({
        where: { id, status: "ACCEPTED" },
        data: { status: "CONVERTED" },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Only ACCEPTED estimates can be converted");
      }

      const est = await tx.estimate.findUnique({
        where: { id },
        include: {
          items: { orderBy: { id: "asc" } }, // B659 finding 4: same order as the pre-flight read
          customer: { select: { isTaxExempt: true } },
        },
      });
      if (!est) throw new NotFoundException("Estimate not found");

      // MSRP snapshot at conversion time — same contract as
      // InvoicesService.applyMsrpSnapshots: no-op (every line stays null) when the
      // tenant lacks flag.msrp.
      const tenantId = this.prisma.getTenantId();
      const msrpMap = (await this.msrpEnabled(tenantId))
        ? await loadMsrpMap(tx, est.customerId, [
            ...new Set(est.items.map((i) => i.productId).filter(Boolean)),
          ] as string[])
        : new Map<string, number | null>();

      // H5 (owner ruling 2026-10-13): converting RE-TAKES the current basis - today's tenant rate and the
      // customer's exempt flag today - rather than recovering the quote's rate. The estimate carries only one flat
      // `taxAmount` over its subtotal (the quote's REGULAR tax), kept to report the difference. The rate is stamped on
      // every converted line (B294): a line built with `taxRate: 0` would silently zero the tax on the next
      // applyPriceAdjustment recompute even though the invoice was issued with the correct total.
      const currentRate = await configuredTaxRateFraction({ forTenant: () => tx });
      const lineTaxRate = est.customer?.isTaxExempt ? 0 : currentRate;

      // B659: the invoice is built through the SAME line path as an interactive invoice: the quoted PRICE
      // is honoured, but the regulated category (and its levy) is read from the product NOW and computed
      // through computeCategoryTax, and the SALE ledger rows are booked below, so a conversion can never
      // file a quote-date rate or skip the ledger. Pack = the estimate line's own (estimate-convert-lines.ts).
      const lines = estimateConvertLineItems(est.items, lineTaxRate);
      // #2656: an NSF-fee line is never taxed - the same 400 an invoice refuses it with (it would otherwise
      // convert at today's rate and tax the bounce fee).
      assertNsfLinesUntaxed(lines);
      const { productMap, categoryMap, unitsByProduct } = await loadManualLineContext(lines, {
        prisma: { getTenantId: () => tenantId, forTenant: () => tx }, // read on THIS transaction's connection
        entitlements: this.entitlements,
      });
      const resolved = lines.map((it) =>
        resolveLineUnits(
          productMap.get(it.productId ?? "") ?? {},
          unitsByProduct.get(it.productId ?? "") ?? [],
          it,
        ),
      );
      const { itemsData, subtotal: linesSubtotal } = buildManualInvoiceLines(lines, {
        productMap,
        categoryMap,
        tenantId,
        clampFreeUnits: () => 0,
        resolved,
      });
      itemsData.forEach((it, idx) => {
        const pid = lines[idx].productId;
        it.msrp = pid ? (msrpMap.get(pid) ?? null) : null;
      });
      const subtotal = roundMoney(linesSubtotal);
      const isTaxExempt = !!est.customer?.isTaxExempt;
      // B294 (L-159): regular tax and levy both come from THIS call, at today's rate (H5). est.taxAmount holds the
      // quote's REGULAR tax only and is read below solely to report the difference; it is never an input here.
      stampInvoicePositions(itemsData); // W-1187: the converted invoice lists the estimate's lines in their order
      zeroExemptCategoryTax(itemsData, isTaxExempt); // exempt: $0 of BOTH taxes, snapshots zeroed
      const discount = Number(est.discount ?? 0);
      const {
        tax: taxTotal,
        total,
        regularTax: currentTax,
        categoryTax: currentLevy,
      } = sumInvoiceTotalsStrict(itemsData, {
        discount,
        isTaxExempt,
        discountBase: discountModeOf(est), // SA-1141 R4: the invoice takes the ESTIMATE's mode (the quoted tax must not move)
      });
      // H5: the quote's regular tax against today's, so the operator is told when the rate (or the exempt flag) moved.
      const quotedTax = roundMoney(Number(est.taxAmount ?? 0));
      const quotedSubtotal = Number(est.subtotal ?? 0);
      const taxDelta = roundMoney(currentTax - quotedTax);
      const taxBasis = {
        quotedTax,
        currentTax,
        // The regulated levy is computed at conversion from each product's category at the sale (B659); a quote
        // never carries one, so any levy on the invoice is news to the operator.
        currentLevy,
        invoiceTax: taxTotal,
        delta: taxDelta,
        changed: taxDelta !== 0 || currentLevy > 0,
        quotedRate: quotedSubtotal > 0 ? round4(quotedTax / quotedSubtotal) : 0,
        currentRate: lineTaxRate,
      };

      try {
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber,
            customerId: est.customerId,
            status: "DRAFT",
            subtotal,
            taxAmount: taxTotal,
            discount,
            shippingFee: 0,
            total,
            notes: est.notes,
            terms: est.terms,
            // B659 (rebased onto #1177/B645): the shared invoice line-builder path below
            // (estimateConvertLineItems -> buildManualInvoiceLines) supersedes #1177's direct
            // boxes/pieces/unitsPerBox carry-through — itemsData already carries the same
            // triplet (via packSnapshot / estimateLinePack, never the live product) PLUS the
            // regulated levy, unit resolution and MSRP snapshot #1177's mapper never had.
            items: { create: itemsData },
          },
          include: { customer: { select: { id: true, businessName: true } }, items: true },
        });
        await restriction?.stamp(tx, inv.id); // row 510: the staff override of a restricted line
        // Same pattern invoices.service.ts's own create() uses (pack-at-sale.ts): the FULL
        // boxes/pieces/unitsPerBox/packAtSale shape, never a thinner ledger-line mapping that
        // would re-derive the pack from the live product for a converted estimate line.
        const invItems: any[] = Array.isArray(inv.items) ? inv.items : [];
        if (invItems.some((it: any) => it.trackedCategoryId != null)) {
          const packMap = await packAtSaleByProduct(tx, invItems);
          await this.ledger.writeSaleEntries({
            tenantId,
            orderId: null,
            invoiceId: inv.id,
            soldAt: inv.issueDate ?? new Date(),
            lines: toSaleLedgerLines(invItems, packMap),
            db: tx,
            lockedPeriod: "REFUSE", // W-965: the invoice is dated now, so the mode is moot; the guard stays
          });
        }

        // B17: link the estimate to the invoice it minted, inside the same transaction
        // as the claim above — a mismatch here (another write raced this same estimate
        // between the claim and this link) rolls the whole conversion back rather than
        // leaving a CONVERTED estimate with no invoiceId.
        const linked = await tx.estimate.updateMany({
          where: { id, status: "CONVERTED" },
          data: { invoiceId: inv.id },
        });
        if (linked.count !== 1) {
          throw new ConflictException("Estimate link failed");
        }

        return { ...inv, taxBasis };
      } catch (err: any) {
        // B100/F16b (REG-B100-F): had no P2002 catch — a concurrent convert's
        // unique-constraint hit propagated as a raw 500 (same message as the
        // sibling catches in invoices.service.ts).
        // B1186: only the two constraints this transaction can race on (the invoice number, or the
        // estimate's own one-invoice link) are that conflict; any other unique violation propagates.
        if (
          uniqueViolationOn(err, "Invoice_tenantId_invoiceNumber_key", { exact: true }) ||
          uniqueViolationOn(err, "Estimate_invoiceId_key", { exact: true })
        )
          throw new ConflictException("Invoice number conflict — please retry.");
        throw err;
      }
    });
  }
}
