import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { InvoiceStatus, UserRole } from "@prisma/client";
import {
  CreateInvoiceDto,
  RecordInvoicePaymentDto,
  StandalonePaymentDto,
  UpdatePaymentDto,
  WriteOffDto,
} from "./dto/create-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { InvoicePdfService } from "./invoice-pdf.service";

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly emailService: EmailService,
    private readonly pdfService: InvoicePdfService,
  ) {}

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async nextInvoiceNumber(): Promise<string> {
    return this.generateInvoiceNumber();
  }

  private recomputeStatus(totalPaid: number, total: number, dueDate: Date | null): InvoiceStatus {
    if (totalPaid >= total - 0.001) return InvoiceStatus.PAID;
    if (totalPaid > 0) return InvoiceStatus.PARTIAL;
    if (dueDate && new Date(dueDate) < new Date()) return InvoiceStatus.OVERDUE;
    return InvoiceStatus.SENT;
  }

  private async findOneOrThrow(id: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException("Invoice not found");
    return inv;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: CreateInvoiceDto) {
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException("Customer not found");

    // Pre-fetch products for items that specify boxes/pieces so we can resolve qty
    const productIds = [
      ...new Set(
        dto.items
          .filter((i) => i.productId && (i.boxes != null || i.pieces != null))
          .map((i) => i.productId!),
      ),
    ];
    const products =
      productIds.length > 0
        ? await this.prisma.forTenant().product.findMany({ where: { id: { in: productIds } } })
        : [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    let subtotal = 0;
    const itemsData = dto.items.map((item) => {
      let qty = item.qty;
      let boxes: number | undefined;
      let pieces: number | undefined;
      if (item.productId && (item.boxes != null || item.pieces != null)) {
        const product = productMap.get(item.productId);
        if (product?.unitsPerBox) {
          boxes = item.boxes ?? 0;
          pieces = item.pieces ?? 0;
          qty = boxes * product.unitsPerBox + pieces;
        }
      }
      const lineSub = qty * item.unitPrice - (item.discount ?? 0);
      subtotal += lineSub;
      return {
        description: item.description,
        productId: item.productId,
        qty,
        unitPrice: item.unitPrice,
        discount: item.discount ?? 0,
        taxRate: item.taxRate ?? 0,
        subtotal: lineSub,
        boxes: boxes ?? null,
        pieces: pieces ?? null,
        tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
      };
    });

    const invDiscount = dto.discount ?? 0;
    const shipping = dto.shippingFee ?? 0;
    const taxTotal = dto.items.reduce((sum, item) => {
      const lineSub = item.qty * item.unitPrice - (item.discount ?? 0);
      return sum + lineSub * (item.taxRate ?? 0);
    }, 0);
    const total = subtotal - invDiscount + shipping + taxTotal;

    const invoice = await this.prisma.forTenant().invoice.create({
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

  /**
   * Auto-generate an Invoice from a delivered Order.
   * Accepts an optional Prisma transaction client so it can run
   * inside completeStop()'s $transaction.
   */
  async createInvoiceFromOrder(orderId: string, txClient?: any) {
    const db = txClient ?? this.prisma;

    // Idempotency: skip if invoice already exists for this order
    const existing = await db.invoice.findFirst({ where: { orderId } });
    if (existing) return existing;

    // Fetch order with non-cancelled line items
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: { product: { select: { name: true } } },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Build invoice items from order items, carrying price type info
    const tenantId = this.prisma.getTenantId();
    const itemsData = order.lineItems.map((li: any) => ({
      description: li.product?.name ?? `Product`,
      productId: li.productId,
      qty: Number(li.qty),
      unitPrice: Number(li.unitPrice),
      discount: li.originalPrice != null ? Number(li.originalPrice) - Number(li.unitPrice) : 0,
      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
      priceType: li.priceType ?? "STANDARD",
      taxRate: 0,
      subtotal: Number(li.subtotal),
      tenantId, // nested creates bypass forTenant() extension
    }));

    const subtotal = Number(order.subtotal);
    const taxAmount = Number(order.tax);
    const total = Number(order.total);

    // Due date: 30 days from now
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);

    // Generate invoice number
    const invoiceNumber = await this.generateInvoiceNumber(db);

    const invoice = await db.invoice.create({
      data: {
        invoiceNumber,
        customerId: order.customerId,
        orderId: order.id,
        status: InvoiceStatus.DRAFT,
        subtotal,
        taxAmount,
        discount: 0,
        shippingFee: 0,
        total,
        dueDate,
        issueDate: new Date(),
        notes: order.orderNumber ? `Order #${order.orderNumber}` : null,
        items: { create: itemsData },
      },
      include: {
        customer: {
          select: { id: true, businessName: true, email: true, phone: true, mobile: true },
        },
        items: true,
        payments: true,
      },
    });

    return invoice;
  }

  /**
   * Fire-and-forget safe variant of createInvoiceFromOrder.
   * Accepts an explicit tenantId so it doesn't depend on AsyncLocalStorage
   * (which is lost when the call is not awaited in the request lifecycle).
   */
  async createInvoiceFromOrderWithTenant(orderId: string, tenantId: string | null) {
    // Use raw prisma queries with explicit tenantId filtering
    const existing = await this.prisma.invoice.findFirst({
      where: { orderId, ...(tenantId ? { tenantId } : {}) },
    });
    if (existing) return existing;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, ...(tenantId ? { tenantId } : {}) },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: { product: { select: { name: true } } },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    const itemsData = order.lineItems.map((li: any) => ({
      description: li.product?.name ?? `Product`,
      productId: li.productId,
      qty: Number(li.qty),
      unitPrice: Number(li.unitPrice),
      discount: li.originalPrice != null ? Number(li.originalPrice) - Number(li.unitPrice) : 0,
      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
      priceType: li.priceType ?? "STANDARD",
      taxRate: 0,
      subtotal: Number(li.subtotal),
      tenantId,
    }));

    const subtotal = Number(order.subtotal);
    const taxAmount = Number(order.tax);
    const total = Number(order.total);

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);

    const invoiceNumber = await this.generateInvoiceNumber();

    return this.prisma.invoice.create({
      data: {
        invoiceNumber,
        customerId: order.customerId,
        orderId: order.id,
        status: InvoiceStatus.DRAFT,
        subtotal,
        taxAmount,
        discount: 0,
        shippingFee: 0,
        total,
        dueDate,
        issueDate: new Date(),
        notes: order.orderNumber ? `Order #${order.orderNumber}` : null,
        items: { create: itemsData },
        ...(tenantId ? { tenantId } : {}),
      },
      include: {
        customer: {
          select: { id: true, businessName: true, email: true, phone: true, mobile: true },
        },
        items: true,
        payments: true,
      },
    });
  }

  /**
   * Generate next invoice number. Accepts optional tx client for
   * transactional safety inside $transaction blocks.
   */
  private async generateInvoiceNumber(db?: any): Promise<string> {
    const client = db ?? this.prisma;
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;
    const last = await client.invoice.findFirst({
      where: { invoiceNumber: { startsWith: prefix } },
      orderBy: { invoiceNumber: "desc" },
    });
    const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  async findAll(query: ListInvoicesDto, user?: JwtPayload) {
    const {
      status,
      customerId,
      search,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder,
      page = 1,
      limit = 20,
    } = query;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;
    if (user?.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      where.customerId = customer.id;
    } else if (customerId) {
      where.customerId = customerId;
    }
    if (search) {
      where.OR = [
        { customer: { businessName: { contains: search, mode: "insensitive" } } },
        { invoiceNumber: { contains: search, mode: "insensitive" } },
      ];
    }
    if (dateFrom || dateTo) {
      where.issueDate = {};
      if (dateFrom) where.issueDate.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        where.issueDate.lte = end;
      }
    }

    // Build orderBy from sortBy/sortOrder params
    const validSortFields: Record<string, string> = {
      date: "issueDate",
      issueDate: "issueDate",
      dueDate: "dueDate",
      total: "total",
      amount: "total",
      createdAt: "createdAt",
      status: "status",
      invoiceNumber: "invoiceNumber",
    };
    const orderField = validSortFields[sortBy ?? ""] ?? "issueDate";
    const orderDir = sortOrder === "asc" ? "asc" : "desc";
    const orderBy: any = { [orderField]: orderDir };

    const [data, total] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          payments: { orderBy: { createdAt: "desc" } },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.forTenant().invoice.count({ where }),
    ]);

    // Compute balanceDue server-side so the client always gets the right value
    // regardless of whether InvoicePayment records exist (e.g. Zoho-imported invoices)
    const computedData = data.map((inv) => {
      const paidAmount = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const isSettled =
        inv.status === InvoiceStatus.PAID ||
        inv.status === InvoiceStatus.VOID ||
        inv.status === InvoiceStatus.WRITTEN_OFF;
      const balanceDue = isSettled ? 0 : Math.max(0, Number(inv.total) - paidAmount);
      return { ...inv, balanceDue, paidAmount };
    });

    return {
      data: computedData,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, user?: JwtPayload) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            businessName: true,
            contactName: true,
            phone: true,
            mobile: true,
            email: true,
          },
        },
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (user?.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || inv.customerId !== customer.id) throw new ForbiddenException();
    }
    return inv;
  }

  async update(id: string, dto: Partial<CreateInvoiceDto>) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException("Only DRAFT invoices can be edited");

    if (dto.items) {
      await this.prisma.forTenant().invoiceItem.deleteMany({ where: { invoiceId: id } });

      // Pre-fetch products for boxes/pieces resolution
      const productIds = [
        ...new Set(
          dto.items
            .filter((i) => i.productId && (i.boxes != null || i.pieces != null))
            .map((i) => i.productId!),
        ),
      ];
      const products =
        productIds.length > 0
          ? await this.prisma.forTenant().product.findMany({ where: { id: { in: productIds } } })
          : [];
      const productMap = new Map(products.map((p) => [p.id, p]));

      let subtotal = 0;
      const itemsData = dto.items.map((item) => {
        let qty = item.qty;
        let boxes: number | undefined;
        let pieces: number | undefined;
        if (item.productId && (item.boxes != null || item.pieces != null)) {
          const product = productMap.get(item.productId);
          if (product?.unitsPerBox) {
            boxes = item.boxes ?? 0;
            pieces = item.pieces ?? 0;
            qty = boxes * product.unitsPerBox + pieces;
          }
        }
        const lineSub = qty * item.unitPrice - (item.discount ?? 0);
        subtotal += lineSub;
        return {
          description: item.description,
          productId: item.productId,
          qty,
          unitPrice: item.unitPrice,
          discount: item.discount ?? 0,
          taxRate: item.taxRate ?? 0,
          subtotal: lineSub,
          boxes: boxes ?? null,
          pieces: pieces ?? null,
          tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
        };
      });
      const taxTotal = dto.items.reduce(
        (s, i) => s + (i.qty * i.unitPrice - (i.discount ?? 0)) * (i.taxRate ?? 0),
        0,
      );
      const invDiscount = dto.discount ?? Number(inv.discount);
      const shipping = dto.shippingFee ?? Number(inv.shippingFee);
      const total = subtotal - invDiscount + shipping + taxTotal;
      return this.prisma.forTenant().invoice.update({
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

    return this.prisma.forTenant().invoice.update({
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
    const updated = await this.prisma.forTenant().invoice.update({
      where: { id },
      data: { status: InvoiceStatus.SENT, sentAt: new Date() },
    });
    this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      customerId: updated.customerId,
      status: InvoiceStatus.SENT,
      total: Number(updated.total),
    });
    return updated;
  }

  /** Send the invoice as an actual email and mark as SENT. */
  async sendEmail(id: string, overrideEmail?: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true, email: true } },
        items: true,
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status === InvoiceStatus.VOID)
      throw new BadRequestException("Cannot send a voided invoice");

    const recipientEmail = overrideEmail || inv.customer?.email;
    if (!recipientEmail)
      throw new BadRequestException(
        "No email address on file for this customer. Provide an email address.",
      );

    // Get PDF URL (non-blocking — include in email if available)
    let pdfUrl: string | undefined;
    try {
      pdfUrl = await this.pdfService.getOrGenerate(id);
    } catch {
      this.logger.warn(
        `Could not generate PDF for invoice ${id} — email will be sent without PDF link`,
      );
    }

    await this.emailService.sendInvoice({
      to: recipientEmail,
      customerName: inv.customer?.businessName ?? "Customer",
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      issueDate: inv.issueDate
        ? new Date(inv.issueDate).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "",
      dueDate: inv.dueDate
        ? new Date(inv.dueDate).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "",
      total: Number(inv.total),
      items: inv.items.map((it: any) => ({
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        subtotal: Number(it.subtotal),
      })),
      pdfUrl,
      isReminder: false,
    });

    // Mark as SENT
    const updated = await this.prisma.forTenant().invoice.update({
      where: { id },
      data: { status: InvoiceStatus.SENT, sentAt: new Date() },
    });
    this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      customerId: updated.customerId,
      status: InvoiceStatus.SENT,
      total: Number(updated.total),
    });
    return { success: true, sentTo: recipientEmail };
  }

  /** Send a payment reminder email without changing the invoice status. */
  async sendReminder(id: string, overrideEmail?: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true, email: true } },
        items: true,
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status === InvoiceStatus.VOID || inv.status === InvoiceStatus.PAID)
      throw new BadRequestException("Cannot send reminder for a VOID or PAID invoice");

    const recipientEmail = overrideEmail || inv.customer?.email;
    if (!recipientEmail)
      throw new BadRequestException(
        "No email address on file for this customer. Provide an email address.",
      );

    let pdfUrl: string | undefined;
    try {
      pdfUrl = await this.pdfService.getOrGenerate(id);
    } catch {
      /* non-critical */
    }

    await this.emailService.sendInvoice({
      to: recipientEmail,
      customerName: inv.customer?.businessName ?? "Customer",
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      issueDate: inv.issueDate
        ? new Date(inv.issueDate).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "",
      dueDate: inv.dueDate
        ? new Date(inv.dueDate).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "",
      total: Number(inv.total),
      items: inv.items.map((it: any) => ({
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        subtotal: Number(it.subtotal),
      })),
      pdfUrl,
      isReminder: true,
    });

    return { success: true, sentTo: recipientEmail };
  }

  async voidInvoice(id: string) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status === InvoiceStatus.PAID)
      throw new BadRequestException("Cannot void a fully paid invoice");
    if (inv.status === InvoiceStatus.PARTIAL)
      throw new BadRequestException(
        "Cannot void an invoice with partial payments. Reverse or refund payments first.",
      );
    return this.prisma
      .forTenant()
      .invoice.update({ where: { id }, data: { status: InvoiceStatus.VOID } });
  }

  async revertInvoiceToDraft(id: string) {
    const inv = await this.findOneOrThrow(id);
    const revertableStatuses = [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE];
    if (!revertableStatuses.includes(inv.status as any)) {
      throw new BadRequestException(
        `Only SENT, VIEWED, or OVERDUE invoices with no payments can be reverted to Draft. Current status: ${inv.status}`,
      );
    }
    // Block if there are any payments
    const paymentCount = await this.prisma
      .forTenant()
      .invoicePayment.count({ where: { invoiceId: id } });
    if (paymentCount > 0) {
      throw new BadRequestException(
        "Cannot revert to Draft: this invoice has payments recorded. Void it instead.",
      );
    }
    return this.prisma.forTenant().invoice.update({
      where: { id },
      data: { status: InvoiceStatus.DRAFT, sentAt: null },
    });
  }

  async unvoidInvoice(id: string) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status !== InvoiceStatus.VOID) {
      throw new BadRequestException(
        `Only VOID invoices can be unvoided. Current status: ${inv.status}`,
      );
    }
    // Check if there were payments before voiding (there shouldn't be, since void blocks payments)
    // Revert to DRAFT so operator can review before re-sending
    return this.prisma.forTenant().invoice.update({
      where: { id },
      data: { status: InvoiceStatus.DRAFT },
    });
  }

  async reopenInvoice(id: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status !== InvoiceStatus.PAID)
      throw new BadRequestException("Only PAID invoices can be reopened");

    return this.prisma.forTenant().invoice.update({
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
    const inv = await this.prisma
      .forTenant()
      .invoice.findUnique({ where: { id }, include: { items: true } });
    if (!inv) throw new NotFoundException("Invoice not found");
    return this.prisma.forTenant().invoice.create({
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
            tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
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

  async listAllPayments(query: {
    page?: number;
    limit?: number;
    customerId?: string;
    method?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sortBy?: string;
    sortDir?: string;
  }) {
    const {
      page = 1,
      limit = 25,
      customerId,
      method,
      status,
      dateFrom,
      dateTo,
      search,
      sortBy,
      sortDir,
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (customerId) where.invoice = { customerId };
    if (method) where.method = method;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.paidAt = {};
      if (dateFrom) where.paidAt.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        where.paidAt.lte = end;
      }
    }
    if (search) {
      where.OR = [
        { paymentNumber: { contains: search, mode: "insensitive" } },
        { reference: { contains: search, mode: "insensitive" } },
        { invoice: { customer: { businessName: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const validSortFields: Record<string, any> = {
      paidAt: { paidAt: sortDir === "asc" ? "asc" : "desc" },
      amount: { amount: sortDir === "asc" ? "asc" : "desc" },
      createdAt: { createdAt: sortDir === "asc" ? "asc" : "desc" },
      paymentNumber: { paymentNumber: sortDir === "asc" ? "asc" : "desc" },
    };
    const orderBy = validSortFields[sortBy ?? ""] ?? { paidAt: "desc" };

    const include = {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          customerId: true,
          customer: { select: { id: true, businessName: true } },
        },
      },
    };

    const [data, total] = await Promise.all([
      this.prisma
        .forTenant()
        .invoicePayment.findMany({ where, skip, take: limit, orderBy, include }),
      this.prisma.forTenant().invoicePayment.count({ where }),
    ]);

    // Summary: total received (PAID only) and advance balance
    const summaryWhere = { ...where, status: "PAID" };
    const paidPayments = await this.prisma.forTenant().invoicePayment.findMany({
      where: summaryWhere,
      select: { amount: true },
    });
    const totalReceived = paidPayments.reduce((s, p) => s + Number(p.amount), 0);

    const advanceWhere: any = customerId ? { customerId } : {};
    const advances = await this.prisma.forTenant().advancePayment.findMany({
      where: advanceWhere,
      select: { balance: true },
    });
    const advanceBalance = advances.reduce((s, a) => s + Number(a.balance), 0);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      summary: { totalReceived, count: paidPayments.length, advanceBalance },
    };
  }

  async findPaymentById(paymentId: string) {
    const payment = await this.prisma.forTenant().invoicePayment.findUnique({
      where: { id: paymentId },
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
    });
    if (!payment) throw new NotFoundException("Payment not found");
    return payment;
  }

  // ─── Payment recording ────────────────────────────────────────────────────

  async recordPayment(id: string, dto: RecordInvoicePaymentDto) {
    return this.prisma.tenantTransaction(async (tx) => {
      // Lock the invoice row so concurrent payment requests serialize here
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;

      const inv = await tx.invoice.findUnique({
        where: { id },
        include: { payments: { where: { status: { not: "VOID" as any } } } },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot record payment on voided invoice");

      const alreadyPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      const remaining = total - alreadyPaid;
      const paymentStatus = dto.status ?? "PAID";

      if (paymentStatus === "PAID") {
        if (remaining <= 0) throw new BadRequestException("Invoice is already fully paid");
        if (dto.amount > remaining + 0.001)
          throw new BadRequestException(
            `Payment exceeds remaining balance of ${remaining.toFixed(2)}`,
          );
      }

      // Auto-generate payment number — use tenantId as the counter row key so
      // each tenant has its own independent sequence. Include a short tenant hash
      // in the payment number to avoid global @unique collisions across tenants.
      const counterKey = this.prisma.getTenantId() ?? "singleton";
      const tenantShort = counterKey.slice(0, 6).toUpperCase();
      const counter = await tx.paymentCounter.upsert({
        where: { id: counterKey },
        update: { next: { increment: 1 } },
        create: { id: counterKey, next: 2 },
      });
      const paymentNumber = `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;

      await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          bankCharges: dto.bankCharges,
          status: paymentStatus as any,
          paymentNumber,
        },
      });

      const newPaid = paymentStatus === "PAID" ? alreadyPaid + dto.amount : alreadyPaid;
      const newStatus =
        paymentStatus === "PAID" ? this.recomputeStatus(newPaid, total, inv.dueDate) : inv.status;

      const paid = await tx.invoice.update({
        where: { id },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
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
    return this.prisma.tenantTransaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot edit payment on voided invoice");

      const payment = inv.payments.find((p) => p.id === paymentId);
      if (!payment) throw new NotFoundException("Payment not found");

      const newPaymentStatus = dto.status ?? (payment as any).status ?? "PAID";

      // When voiding: treat the payment as $0 for balance checks
      const effectiveAmount = newPaymentStatus === "VOID" ? 0 : dto.amount;

      // Sum all other non-void payments plus the effective new amount
      const othersTotal = inv.payments
        .filter((p) => p.id !== paymentId && (p as any).status !== "VOID")
        .reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      if (newPaymentStatus !== "VOID" && dto.amount > total - othersTotal + 0.001) {
        throw new BadRequestException(`Payment amount exceeds remaining balance`);
      }

      await tx.invoicePayment.update({
        where: { id: paymentId },
        data: {
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
          ...(dto.paidAt && { paidAt: new Date(dto.paidAt) }),
          ...(dto.bankCharges !== undefined && { bankCharges: dto.bankCharges }),
          status: newPaymentStatus as any,
        },
      });

      const newPaid = othersTotal + effectiveAmount;
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
      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
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
    return this.prisma.tenantTransaction(async (tx) => {
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
      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
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
    return this.prisma.forTenant().invoice.update({
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

  // ─── Delete ───────────────────────────────────────────────────────────────

  async deleteInvoice(id: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");

      if (inv.payments.length > 0) {
        throw new BadRequestException(
          "Cannot delete an invoice that has recorded payments. Remove all payments first, or void the invoice.",
        );
      }

      // Unlink credit notes that were generated for this invoice
      await tx.creditNote.updateMany({
        where: { invoiceId: id },
        data: { invoiceId: null },
      });

      // Delete line items
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });

      // Delete the invoice (also detaches orderId reference)
      await tx.invoice.delete({ where: { id } });

      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId: id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        status: "DELETED" as any,
        total: Number(inv.total),
      });

      return { id, message: "Invoice deleted successfully" };
    });
  }

  // ─── Standalone (bulk-allocation) payment ────────────────────────────────

  async recordStandalonePayment(dto: StandalonePaymentDto) {
    const paymentGroupId = randomUUID();
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    const status = dto.status ?? "PAID";

    return this.prisma.tenantTransaction(async (tx) => {
      // Generate a block of sequential payment numbers (tenant-scoped counter)
      const counterKey = this.prisma.getTenantId() ?? "singleton";
      const counter = await tx.paymentCounter.upsert({
        where: { id: counterKey },
        update: { next: { increment: dto.allocations.length } },
        create: { id: counterKey, next: dto.allocations.length + 1 },
      });

      const payments: any[] = [];
      for (let i = 0; i < dto.allocations.length; i++) {
        const alloc = dto.allocations[i];
        const paymentNumber = `PAY-${String(counter.next - dto.allocations.length + i).padStart(4, "0")}`;

        // Validate invoice belongs to customer and is not voided
        const invoice = await tx.invoice.findFirst({
          where: { id: alloc.invoiceId, customerId: dto.customerId },
          include: { payments: { where: { status: { not: "VOID" as any } } } },
        });
        if (!invoice)
          throw new NotFoundException(`Invoice ${alloc.invoiceId} not found for customer`);
        if (invoice.status === "VOID")
          throw new BadRequestException(`Invoice ${alloc.invoiceId} is voided`);

        const payment = await tx.invoicePayment.create({
          data: {
            invoiceId: alloc.invoiceId,
            amount: alloc.amount,
            method: dto.method as any,
            paidAt,
            bankCharges: dto.bankCharges,
            reference: dto.reference,
            notes: dto.notes,
            status: status as any,
            paymentNumber,
            paymentGroupId,
          },
        });
        payments.push(payment);

        if (status === "PAID") {
          const allPayments = await tx.invoicePayment.findMany({
            where: { invoiceId: alloc.invoiceId, status: { not: "VOID" as any } },
          });
          const totalPaid = allPayments.reduce((s, p) => s + Number(p.amount), 0);
          const newStatus = this.recomputeStatus(totalPaid, Number(invoice.total), invoice.dueDate);
          await tx.invoice.update({
            where: { id: alloc.invoiceId },
            data: {
              status: newStatus,
              paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null,
            },
          });
        }
      }

      // Handle excess amount → create AdvancePayment
      const allocatedTotal = dto.allocations.reduce((s, a) => s + a.amount, 0);
      const excess = dto.totalAmount - allocatedTotal;
      if (excess > 0.001) {
        await tx.advancePayment.create({
          data: {
            customerId: dto.customerId,
            amount: excess,
            balance: excess,
            method: dto.method as any,
            reference: dto.reference,
            notes: dto.notes,
            receivedAt: paidAt,
          },
        });
      }

      return { payments, paymentGroupId, excess: Math.max(0, excess) };
    });
  }

  // ─── Void a single payment ────────────────────────────────────────────────

  async voidPayment(invoiceId: string, paymentId: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      const payment = await tx.invoicePayment.findFirst({
        where: { id: paymentId, invoiceId },
      });
      if (!payment) throw new NotFoundException("Payment not found");
      if ((payment as any).status === "VOID")
        throw new BadRequestException("Payment already voided");

      await tx.invoicePayment.update({
        where: { id: paymentId },
        data: { status: "VOID" as any },
      });

      // Recompute invoice status treating this payment as $0
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: { where: { status: { not: "VOID" as any } } } },
      });
      if (!invoice) throw new NotFoundException("Invoice not found");

      const totalPaid = invoice.payments
        .filter((p) => p.id !== paymentId)
        .reduce((s, p) => s + Number(p.amount), 0);
      const newStatus = this.recomputeStatus(totalPaid, Number(invoice.total), invoice.dueDate);
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? invoice.paidAt : null,
        },
      });

      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        status: newStatus,
        total: Number(invoice.total),
      });
      return { success: true };
    });
  }

  // ─── Export payments as CSV ───────────────────────────────────────────────

  async exportPayments(params: {
    customerId?: string;
    method?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sortBy?: string;
    sortDir?: string;
  }): Promise<string> {
    const { customerId, method, status, dateFrom, dateTo, search, sortBy, sortDir } = params;

    const where: any = {};
    if (customerId) where.invoice = { customerId };
    if (method) where.method = method;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.paidAt = {};
      if (dateFrom) where.paidAt.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        where.paidAt.lte = end;
      }
    }
    if (search) {
      where.OR = [
        { paymentNumber: { contains: search, mode: "insensitive" } },
        { reference: { contains: search, mode: "insensitive" } },
        { invoice: { customer: { businessName: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const validSortFields: Record<string, any> = {
      paidAt: { paidAt: sortDir === "asc" ? "asc" : "desc" },
      amount: { amount: sortDir === "asc" ? "asc" : "desc" },
      createdAt: { createdAt: sortDir === "asc" ? "asc" : "desc" },
      paymentNumber: { paymentNumber: sortDir === "asc" ? "asc" : "desc" },
    };
    const orderBy = validSortFields[sortBy ?? ""] ?? { paidAt: "desc" };

    const rows = await this.prisma.forTenant().invoicePayment.findMany({
      where,
      orderBy,
      include: {
        invoice: {
          select: {
            invoiceNumber: true,
            customer: { select: { businessName: true } },
          },
        },
      },
    });

    const escape = (v: any) => {
      const s = v == null ? "" : String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const header = "Payment#,Date,Customer,Invoice#,Method,Reference,Bank Charges,Amount,Status";
    const lines = rows.map((r: any) =>
      [
        escape(r.paymentNumber ?? ""),
        escape(r.paidAt ? new Date(r.paidAt).toISOString().split("T")[0] : ""),
        escape(r.invoice?.customer?.businessName ?? ""),
        escape(r.invoice?.invoiceNumber ?? ""),
        escape(r.method ?? ""),
        escape(r.reference ?? ""),
        escape(r.bankCharges != null ? Number(r.bankCharges).toFixed(2) : ""),
        escape(Number(r.amount).toFixed(2)),
        escape(r.status ?? ""),
      ].join(","),
    );

    return [header, ...lines].join("\n");
  }

  // ─── Cron ─────────────────────────────────────────────────────────────────

  async markOverdue() {
    const now = new Date();
    await this.prisma.forTenant().invoice.updateMany({
      where: {
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIAL] },
        dueDate: { lt: now },
      },
      data: { status: InvoiceStatus.OVERDUE },
    });
  }

  // ─── Retroactive Price Adjustment ─────────────────────────────────────────

  async applyPriceAdjustment(
    id: string,
    dto: { items: { itemId: string; newUnitPrice: number }[]; scope: string; sinceDate?: string },
  ) {
    const invoice = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");

    // Build a map of itemId → newUnitPrice for quick lookup
    const priceMap = new Map(dto.items.map((i) => [i.itemId, i.newUnitPrice]));

    // Build a map of itemId → productId from this invoice's items (used for bulk scope)
    const productIdMap = new Map(invoice.items.map((li) => [li.id, li.productId]));

    // Helper: update items on a single invoice and recalculate totals
    const applyToInvoice = async (inv: typeof invoice, localPriceMap: Map<string, number>) => {
      const auditLine = `\n[${new Date().toLocaleDateString()} — Price adjusted by operator]`;

      for (const item of inv.items) {
        const newPrice = localPriceMap.get(item.id);
        if (newPrice == null) continue;
        const newSubtotal = Number(item.qty) * newPrice - Number(item.discount ?? 0);
        await this.prisma.forTenant().invoiceItem.update({
          where: { id: item.id },
          data: { unitPrice: newPrice, subtotal: newSubtotal },
        });
      }

      // Recalculate invoice totals from fresh item data
      const updatedItems = await this.prisma
        .forTenant()
        .invoiceItem.findMany({ where: { invoiceId: inv.id } });
      const subtotal = updatedItems.reduce((s, li) => s + Number(li.subtotal), 0);
      const taxAmount = updatedItems.reduce(
        (s, li) => s + Number(li.subtotal) * Number(li.taxRate ?? 0),
        0,
      );
      const total = subtotal - Number(inv.discount ?? 0) + Number(inv.shippingFee ?? 0) + taxAmount;

      await this.prisma.forTenant().invoice.update({
        where: { id: inv.id },
        data: {
          subtotal,
          taxAmount,
          total,
          notes: (inv.notes ?? "") + auditLine,
        },
      });
    };

    if (dto.scope === "SINGLE") {
      await applyToInvoice(invoice, priceMap);
    } else {
      // ALL_CUSTOMER_SINCE: find all invoices for the same customer on or after sinceDate
      if (!dto.sinceDate) throw new BadRequestException("sinceDate is required for bulk scope");

      // Build productId → newUnitPrice map from this invoice (to apply same price to same product elsewhere)
      const productPriceMap = new Map<string, number>();
      for (const [itemId, newPrice] of priceMap.entries()) {
        const productId = productIdMap.get(itemId);
        if (productId) productPriceMap.set(productId, newPrice);
      }

      const targetInvoices = await this.prisma.forTenant().invoice.findMany({
        where: {
          customerId: invoice.customerId,
          createdAt: { gte: new Date(dto.sinceDate) },
        },
        include: { items: true },
      });

      for (const inv of targetInvoices) {
        // Build itemId → newUnitPrice for items whose productId matches
        const localMap = new Map<string, number>();
        for (const item of inv.items) {
          if (item.productId && productPriceMap.has(item.productId)) {
            localMap.set(item.id, productPriceMap.get(item.productId)!);
          }
        }
        if (localMap.size > 0) {
          await applyToInvoice(inv, localMap);
        }
      }
    }

    return this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: { items: true, customer: { select: { id: true, businessName: true } } },
    });
  }
}
