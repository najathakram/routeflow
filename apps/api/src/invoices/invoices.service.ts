import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { InvoiceStatus, UserRole } from "@prisma/client";
import {
  CreateInvoiceDto,
  RecordInvoicePaymentDto,
  UpdatePaymentDto,
  WriteOffDto,
} from "./dto/create-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async nextInvoiceNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;
    const last = await this.prisma.invoice.findFirst({
      where: { invoiceNumber: { startsWith: prefix } },
      orderBy: { invoiceNumber: "desc" },
    });
    const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  private recomputeStatus(totalPaid: number, total: number, dueDate: Date | null): InvoiceStatus {
    if (totalPaid >= total - 0.001) return InvoiceStatus.PAID;
    if (totalPaid > 0) return InvoiceStatus.PARTIAL;
    if (dueDate && new Date(dueDate) < new Date()) return InvoiceStatus.OVERDUE;
    return InvoiceStatus.SENT;
  }

  private async findOneOrThrow(id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException("Invoice not found");
    return inv;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: CreateInvoiceDto) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException("Customer not found");

    let subtotal = 0;
    const itemsData = dto.items.map((item) => {
      const lineSub = item.qty * item.unitPrice - (item.discount ?? 0);
      subtotal += lineSub;
      return {
        description: item.description,
        productId: item.productId,
        qty: item.qty,
        unitPrice: item.unitPrice,
        discount: item.discount ?? 0,
        taxRate: item.taxRate ?? 0,
        subtotal: lineSub,
      };
    });

    const invDiscount = dto.discount ?? 0;
    const shipping = dto.shippingFee ?? 0;
    const taxTotal = dto.items.reduce((sum, item) => {
      const lineSub = item.qty * item.unitPrice - (item.discount ?? 0);
      return sum + lineSub * (item.taxRate ?? 0);
    }, 0);
    const total = subtotal - invDiscount + shipping + taxTotal;

    const invoice = await this.prisma.invoice.create({
      data: {
        invoiceNumber: await this.nextInvoiceNumber(),
        customerId: dto.customerId,
        status: InvoiceStatus.DRAFT,
        subtotal,
        taxAmount: taxTotal,
        discount: invDiscount,
        shippingFee: shipping,
        total,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        issueDate: dto.issueDate ? new Date(dto.issueDate) : new Date(),
        notes: dto.notes,
        terms: dto.terms,
        items: { create: itemsData },
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: true,
      },
    });

    // If the caller wants to immediately send the invoice, transition DRAFT → SENT
    if (dto.send) {
      return this.send(invoice.id);
    }

    return invoice;
  }

  async findAll(query: ListInvoicesDto, user?: JwtPayload) {
    const { status, customerId, search, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;
    if (user?.role === UserRole.CUSTOMER) {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer) return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      where.customerId = customer.id;
    } else if (customerId) {
      where.customerId = customerId;
    }
    if (search) where.customer = { businessName: { contains: search, mode: "insensitive" } };

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          payments: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, user?: JwtPayload) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true, phone: true } },
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (user?.role === UserRole.CUSTOMER) {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer || inv.customerId !== customer.id) throw new ForbiddenException();
    }
    return inv;
  }

  async update(id: string, dto: Partial<CreateInvoiceDto>) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException("Only DRAFT invoices can be edited");

    if (dto.items) {
      await this.prisma.invoiceItem.deleteMany({ where: { invoiceId: id } });
      let subtotal = 0;
      const itemsData = dto.items.map((item) => {
        const lineSub = item.qty * item.unitPrice - (item.discount ?? 0);
        subtotal += lineSub;
        return {
          description: item.description,
          productId: item.productId,
          qty: item.qty,
          unitPrice: item.unitPrice,
          discount: item.discount ?? 0,
          taxRate: item.taxRate ?? 0,
          subtotal: lineSub,
        };
      });
      const taxTotal = dto.items.reduce(
        (s, i) => s + (i.qty * i.unitPrice - (i.discount ?? 0)) * (i.taxRate ?? 0),
        0,
      );
      const invDiscount = dto.discount ?? Number(inv.discount);
      const shipping = dto.shippingFee ?? Number(inv.shippingFee);
      const total = subtotal - invDiscount + shipping + taxTotal;
      return this.prisma.invoice.update({
        where: { id },
        data: {
          subtotal,
          taxAmount: taxTotal,
          discount: invDiscount,
          shippingFee: shipping,
          total,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
          notes: dto.notes,
          terms: dto.terms,
          items: { create: itemsData },
        },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: true,
        },
      });
    }

    return this.prisma.invoice.update({
      where: { id },
      data: {
        ...(dto.dueDate && { dueDate: new Date(dto.dueDate) }),
        ...(dto.issueDate && { issueDate: new Date(dto.issueDate) }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.terms !== undefined && { terms: dto.terms }),
        ...(dto.discount !== undefined && { discount: dto.discount }),
        ...(dto.shippingFee !== undefined && { shippingFee: dto.shippingFee }),
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: true,
      },
    });
  }

  async send(id: string) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status === InvoiceStatus.VOID)
      throw new BadRequestException("Cannot send a voided invoice");
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { status: InvoiceStatus.SENT, sentAt: new Date() },
    });
    this.gateway.emitInvoiceUpdated({
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      customerId: updated.customerId,
      status: InvoiceStatus.SENT,
      total: Number(updated.total),
    });
    return updated;
  }

  async voidInvoice(id: string) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status === InvoiceStatus.PAID)
      throw new BadRequestException("Cannot void a fully paid invoice");
    return this.prisma.invoice.update({ where: { id }, data: { status: InvoiceStatus.VOID } });
  }

  async reopenInvoice(id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status !== InvoiceStatus.PAID)
      throw new BadRequestException("Only PAID invoices can be reopened");

    return this.prisma.invoice.update({
      where: { id },
      data: { status: InvoiceStatus.DRAFT, paidAt: null },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
  }

  async duplicate(id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id }, include: { items: true } });
    if (!inv) throw new NotFoundException("Invoice not found");
    return this.prisma.invoice.create({
      data: {
        invoiceNumber: await this.nextInvoiceNumber(),
        customerId: inv.customerId,
        status: InvoiceStatus.DRAFT,
        subtotal: inv.subtotal,
        taxAmount: inv.taxAmount,
        discount: inv.discount,
        shippingFee: inv.shippingFee,
        total: inv.total,
        notes: inv.notes,
        terms: inv.terms,
        items: {
          create: inv.items.map((i) => ({
            description: i.description,
            productId: i.productId,
            qty: i.qty,
            unitPrice: i.unitPrice,
            discount: i.discount,
            taxRate: i.taxRate,
            subtotal: i.subtotal,
          })),
        },
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: true,
      },
    });
  }

  // ─── List all payments (across all invoices) ─────────────────────────────

  async listAllPayments(query: { page?: number; limit?: number }) {
    const { page = 1, limit = 25 } = query;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.invoicePayment.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              customerId: true,
              customer: { select: { id: true, businessName: true } },
            },
          },
        },
      }),
      this.prisma.invoicePayment.count(),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── Payment recording ────────────────────────────────────────────────────

  async recordPayment(id: string, dto: RecordInvoicePaymentDto) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id }, include: { payments: true } });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot record payment on voided invoice");

      const alreadyPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      const remaining = total - alreadyPaid;
      if (remaining <= 0) throw new BadRequestException("Invoice is already fully paid");
      if (dto.amount > remaining + 0.001)
        throw new BadRequestException(
          `Payment exceeds remaining balance of ${remaining.toFixed(2)}`,
        );

      await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
        },
      });

      const newPaid = alreadyPaid + dto.amount;
      const newStatus = this.recomputeStatus(newPaid, total, inv.dueDate);
      const paid = await tx.invoice.update({
        where: { id },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      this.gateway.emitInvoiceUpdated({
        invoiceId: paid.id,
        invoiceNumber: paid.invoiceNumber,
        customerId: paid.customerId,
        status: newStatus,
        total: Number(paid.total),
      });
      return paid;
    });
  }

  async updatePayment(invoiceId: string, paymentId: string, dto: UpdatePaymentDto) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot edit payment on voided invoice");

      const payment = inv.payments.find((p) => p.id === paymentId);
      if (!payment) throw new NotFoundException("Payment not found");

      // Sum all other payments plus new amount
      const othersTotal = inv.payments
        .filter((p) => p.id !== paymentId)
        .reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      if (dto.amount > total - othersTotal + 0.001) {
        throw new BadRequestException(`Payment amount exceeds remaining balance`);
      }

      await tx.invoicePayment.update({
        where: { id: paymentId },
        data: {
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
        },
      });

      const newPaid = othersTotal + dto.amount;
      const newStatus = this.recomputeStatus(newPaid, total, inv.dueDate);
      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      this.gateway.emitInvoiceUpdated({
        invoiceId: updated.id,
        invoiceNumber: updated.invoiceNumber,
        customerId: updated.customerId,
        status: newStatus,
        total: Number(updated.total),
      });
      return updated;
    });
  }

  async deletePayment(invoiceId: string, paymentId: string) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot delete payment on voided invoice");

      const payment = inv.payments.find((p) => p.id === paymentId);
      if (!payment) throw new NotFoundException("Payment not found");

      await tx.invoicePayment.delete({ where: { id: paymentId } });

      const remaining = inv.payments
        .filter((p) => p.id !== paymentId)
        .reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      const newStatus = this.recomputeStatus(remaining, total, inv.dueDate);
      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      this.gateway.emitInvoiceUpdated({
        invoiceId: updated.id,
        invoiceNumber: updated.invoiceNumber,
        customerId: updated.customerId,
        status: newStatus,
        total: Number(updated.total),
      });
      return updated;
    });
  }

  // ─── Write-off ────────────────────────────────────────────────────────────

  async writeOff(id: string, dto: WriteOffDto) {
    const inv = await this.findOneOrThrow(id);
    const allowedStatuses: InvoiceStatus[] = [
      InvoiceStatus.SENT,
      InvoiceStatus.VIEWED,
      InvoiceStatus.PARTIAL,
      InvoiceStatus.OVERDUE,
    ];
    if (!allowedStatuses.includes(inv.status)) {
      throw new BadRequestException(`Cannot write off an invoice with status ${inv.status}`);
    }
    return this.prisma.invoice.update({
      where: { id },
      data: {
        status: InvoiceStatus.WRITTEN_OFF,
        writeOffReason: dto.reason,
        writtenOffAt: new Date(),
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
  }

  // ─── Cron ─────────────────────────────────────────────────────────────────

  async markOverdue() {
    const now = new Date();
    await this.prisma.invoice.updateMany({
      where: {
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIAL] },
        dueDate: { lt: now },
      },
      data: { status: InvoiceStatus.OVERDUE },
    });
  }
}
