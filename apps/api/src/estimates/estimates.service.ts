import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

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

    let subtotal = 0;
    const itemsData = dto.items.map((i: any) => {
      const sub = i.qty * i.unitPrice;
      subtotal += sub;
      return {
        description: i.description,
        productId: i.productId,
        qty: i.qty,
        unitPrice: i.unitPrice,
        subtotal: sub,
      };
    });
    const discount = dto.discount ?? 0;
    const tax = dto.taxAmount ?? 0;
    const total = subtotal - discount + tax;

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
  async accept(id: string) {
    return this.prisma.forTenant().estimate.update({ where: { id }, data: { status: "ACCEPTED" } });
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
    const est = await this.prisma
      .forTenant()
      .estimate.findUnique({ where: { id }, include: { items: true } });
    if (!est) throw new NotFoundException("Estimate not found");
    if (est.status !== "ACCEPTED")
      throw new BadRequestException("Only ACCEPTED estimates can be converted");

    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;
    const last = await this.prisma.forTenant().invoice.findFirst({
      where: { invoiceNumber: { startsWith: prefix } },
      orderBy: { invoiceNumber: "desc" },
    });
    const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
    const invoiceNumber = `${prefix}${String(seq).padStart(4, "0")}`;

    const inv = await this.prisma.forTenant().invoice.create({
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
          })),
        },
      },
      include: { customer: { select: { id: true, businessName: true } }, items: true },
    });
    await this.prisma.forTenant().estimate.update({ where: { id }, data: { status: "CONVERTED" } });
    return inv;
  }
}
