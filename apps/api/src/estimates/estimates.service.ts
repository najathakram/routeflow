import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PriceType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { computeLineSubtotal, getTierPrice, roundMoney } from "@routeflow/pricing";
import { loadMsrpMap } from "../common/msrp";
import { effectiveTaxRateFromTotals } from "../common/tax-rate";
import { EntitlementsService } from "../billing/entitlements.service";
import { NumberingService } from "../import/numbering.service";

@Injectable()
export class EstimatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly numbering: NumberingService,
  ) {}

  private readonly logger = new Logger(EstimatesService.name);

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

  async create(dto: any) {
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException("Customer not found");

    const tenantId = this.prisma.getTenantId();
    const defaultTier = customer.pricingTier ?? 1;
    const items: any[] = dto.items ?? [];

    // Load products for items that reference a product
    const productIds = items.filter((i: any) => i.productId).map((i: any) => i.productId);
    const products =
      productIds.length > 0
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: productIds } },
          })
        : [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Load per-product tier overrides for this customer
    const customerPrices =
      productIds.length > 0
        ? await this.prisma.forTenant().customerPrice.findMany({
            where: { customerId: dto.customerId, productId: { in: productIds } },
          })
        : [];
    const cpMap = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));

    let subtotal = 0;
    const itemsData = items.map((i: any) => {
      const product = i.productId ? productMap.get(i.productId) : null;

      // Resolve qty from boxes/pieces when provided
      let qty = Number(i.qty);
      if (product && (i.boxes != null || i.pieces != null)) {
        const unitsPerBox = Number(product.unitsPerBox ?? 0);
        qty = (i.boxes ?? 0) * unitsPerBox + (i.pieces ?? 0);
      }

      let unitPrice: number;
      let priceType: PriceType = PriceType.STANDARD;
      let originalPrice: number | null = null;

      if (product) {
        // Resolve tier: per-product override > customer default tier
        const tierForProduct = cpMap.get(i.productId) ?? defaultTier;
        const tierPrice = getTierPrice(product, tierForProduct);
        const listPrice = Number(product.pricePerUnit);
        const overridePrice = i.unitPrice != null ? Number(i.unitPrice) : null;

        if (overridePrice != null && overridePrice < listPrice) {
          unitPrice = overridePrice;
          priceType = PriceType.DISCOUNTED;
          originalPrice = listPrice;
        } else if (tierForProduct !== 1) {
          unitPrice = tierPrice;
          priceType = PriceType.SPECIAL;
          originalPrice = listPrice;
        } else {
          unitPrice = tierPrice;
          priceType = PriceType.STANDARD;
        }
      } else {
        // Freeform item — use passed unitPrice directly
        unitPrice = Number(i.unitPrice);
      }

      const sub = computeLineSubtotal({
        unitPrice,
        qty,
        boxes: i.boxes ?? null,
        pieces: i.pieces ?? null,
        unitsPerBox: product?.unitsPerBox ?? null,
      });
      subtotal += sub;
      return {
        description: i.description ?? product?.name ?? "",
        productId: i.productId ?? null,
        qty,
        unitPrice,
        subtotal: sub,
        priceType,
        originalPrice,
        boxes: i.boxes ?? null,
        pieces: i.pieces ?? null,
        tenantId,
      };
    });

    subtotal = roundMoney(subtotal);
    const discount = dto.discount ?? 0;
    const tax = dto.taxAmount ?? 0;
    const total = roundMoney(subtotal - discount + tax);

    try {
      return await this.prisma.forTenant().estimate.create({
        data: {
          estimateNumber: await this.nextEstNumber(),
          customerId: dto.customerId,
          status: "DRAFT",
          subtotal,
          taxAmount: tax,
          discount,
          total,
          expiresAt: dto.expiresAt
            ? new Date(dto.expiresAt)
            : dto.expiryDate
              ? new Date(dto.expiryDate)
              : null,
          notes: dto.notes,
          terms: dto.terms,
          items: { create: itemsData },
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
        const target = Array.isArray(err?.meta?.target)
          ? err.meta.target.join(",")
          : String(err?.meta?.target ?? "");
        this.logger.warn(
          `Estimate create failed customer=${dto.customerId} code=P2002 target=${target}`,
        );
        if (target === "" || target.includes("estimateNumber"))
          throw new ConflictException("Estimate number conflict — please retry.");
      }
      throw err;
    }
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
        items: { include: { product: { select: { id: true, name: true } } } },
      },
    });
    if (!est) throw new NotFoundException("Estimate not found");
    return est;
  }

  async send(id: string) {
    return this.prisma.forTenant().estimate.update({ where: { id }, data: { status: "SENT" } });
  }
  // Atomic claim: a CONVERTED estimate must never be re-accepted, or the
  // convert path below will mint a second invoice for the same estimate.
  async accept(id: string) {
    const { count } = await this.prisma.forTenant().estimate.updateMany({
      where: { id, status: { not: "CONVERTED" } },
      data: { status: "ACCEPTED" },
    });
    if (count === 0) {
      throw new BadRequestException("Converted estimates cannot be re-accepted");
    }
    return this.prisma.forTenant().estimate.findUniqueOrThrow({ where: { id } });
  }
  async decline(id: string) {
    return this.prisma.forTenant().estimate.update({ where: { id }, data: { status: "DECLINED" } });
  }
  async voidEstimate(id: string) {
    const est = await this.prisma.forTenant().estimate.findUnique({ where: { id } });
    if (!est) throw new NotFoundException("Estimate not found");
    if (est.status === "CONVERTED")
      throw new BadRequestException("Converted estimates cannot be voided");
    return this.prisma.forTenant().estimate.update({ where: { id }, data: { status: "DECLINED" } });
  }

  async convertToInvoice(id: string) {
    // D9 (fix-round-2b.md): validate BEFORE reserving. Every reservation commits on
    // its own (see below), so a convert rejected AFTER one burns a number for good —
    // and "estimate missing" / "not ACCEPTED" is the ordinary rejection here, not a
    // rare one (any repeat click on an already-converted estimate hits it). This read
    // is advisory only: the authoritative check stays the atomic claim inside the
    // transaction, so a race LOSER still burns a number (accepted, rare) while the
    // common rejection now costs nothing.
    const existing = await this.prisma
      .forTenant()
      .estimate.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!existing) throw new NotFoundException("Estimate not found");
    if (existing.status !== "ACCEPTED") {
      throw new BadRequestException("Only ACCEPTED estimates can be converted");
    }

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
        include: { items: true, customer: { select: { isTaxExempt: true } } },
      });
      if (!est) throw new NotFoundException("Estimate not found");

      // MSRP snapshot at conversion time — same contract as
      // InvoicesService.applyMsrpSnapshots: no-op (every line stays null) when the
      // tenant lacks flag.msrp.
      const tenantId = this.prisma.getTenantId();
      const msrpMap =
        tenantId && (await this.entitlements.hasFlag(tenantId, "flag.msrp"))
          ? await loadMsrpMap(tx, est.customerId, [
              ...new Set(est.items.map((i) => i.productId).filter(Boolean)),
            ] as string[])
          : new Map<string, number | null>();

      // B294: the estimate never carries a per-line tax rate, only one flat
      // `taxAmount` over its whole `subtotal` — same shape as an order's
      // `order.tax`/`order.subtotal`. Recovering `taxAmount / subtotal` here
      // (0 for a degenerate zero-subtotal estimate) and stamping it on every
      // converted line is the same fix invoices.service.ts applies to
      // order-derived lines: a line built with `taxRate: 0` silently zeroes
      // the tax on the very next applyPriceAdjustment recompute even though
      // the invoice was issued with the correct total.
      const lineTaxRate = effectiveTaxRateFromTotals(
        est.taxAmount,
        est.subtotal,
        !!est.customer?.isTaxExempt,
      );

      try {
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber,
            customerId: est.customerId,
            status: "DRAFT",
            subtotal: est.subtotal,
            taxAmount: est.taxAmount,
            discount: est.discount,
            shippingFee: 0,
            total: est.total,
            notes: est.notes,
            terms: est.terms,
            items: {
              create: est.items.map((i) => ({
                description: i.description,
                productId: i.productId,
                qty: i.qty,
                unitPrice: i.unitPrice,
                discount: 0,
                taxRate: lineTaxRate,
                subtotal: i.subtotal,
                msrp: i.productId ? (msrpMap.get(i.productId) ?? null) : null,
                tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
              })),
            },
          },
          include: { customer: { select: { id: true, businessName: true } }, items: true },
        });
        return inv;
      } catch (err: any) {
        // B100/F16b (REG-B100-F): had no P2002 catch — a concurrent convert's
        // unique-constraint hit propagated as a raw 500 (same message as the
        // sibling catches in invoices.service.ts).
        if (err?.code === "P2002")
          throw new ConflictException("Invoice number conflict — please retry.");
        throw err;
      }
    });
  }
}
