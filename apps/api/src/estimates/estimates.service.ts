import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { getTierPrice } from "../utils/pricing";
import { computeLineSubtotal, roundMoney } from "../common/pricing";

@Injectable()
export class EstimatesService {
  constructor(private readonly prisma: PrismaService) {}

  private async nextEstNumber() {
    const year = new Date().getFullYear();
    const prefix = `EST-${year}-`;
    const last = await this.prisma.forTenant().estimate.findFirst({
      where: { estimateNumber: { startsWith: prefix } },
      orderBy: { estimateNumber: "desc" },
    });
    const seq = last ? parseInt(last.estimateNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
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

    return this.prisma.forTenant().estimate.create({
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

      const est = await tx.estimate.findUnique({ where: { id }, include: { items: true } });
      if (!est) throw new NotFoundException("Estimate not found");

      const year = new Date().getFullYear();
      const prefix = `INV-${year}-`;
      const last = await tx.invoice.findFirst({
        where: { invoiceNumber: { startsWith: prefix } },
        orderBy: { invoiceNumber: "desc" },
      });
      const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
      const invoiceNumber = `${prefix}${String(seq).padStart(4, "0")}`;

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
              taxRate: 0,
              subtotal: i.subtotal,
              tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
            })),
          },
        },
        include: { customer: { select: { id: true, businessName: true } }, items: true },
      });
      return inv;
    });
  }
}
