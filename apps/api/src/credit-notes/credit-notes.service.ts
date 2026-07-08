import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { roundMoney } from "../common/pricing";
import { InvoiceStatus, PaymentMethod } from "@prisma/client";

@Injectable()
export class CreditNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly ledger: RegulatedLedgerService,
  ) {}

  /** Round a quantity to 3 decimals (matches the Decimal(12,3) columns). */
  private round3(n: number): number {
    return Math.round(n * 1000) / 1000;
  }

  private async nextCnNumber() {
    const year = new Date().getFullYear();
    const prefix = `CN-${year}-`;
    const last = await this.prisma.forTenant().creditNote.findFirst({
      where: { creditNoteNumber: { startsWith: prefix } },
      orderBy: { creditNoteNumber: "desc" },
    });
    const seq = last ? parseInt(last.creditNoteNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  private recomputeStatus(
    totalPaid: number,
    total: number,
    dueDate: Date | null,
    currentStatus?: InvoiceStatus,
  ): InvoiceStatus {
    // DRAFT, VOID, and WRITTEN_OFF are terminal/deliberate states — never auto-override.
    if (
      currentStatus === InvoiceStatus.DRAFT ||
      currentStatus === InvoiceStatus.VOID ||
      currentStatus === InvoiceStatus.WRITTEN_OFF
    ) {
      return currentStatus;
    }
    if (totalPaid >= total - 0.001) return InvoiceStatus.PAID;
    if (totalPaid > 0) return InvoiceStatus.PARTIAL;
    if (dueDate && new Date(dueDate) < new Date()) return InvoiceStatus.OVERDUE;
    return InvoiceStatus.SENT;
  }

  async create(dto: { customerId: string; invoiceId?: string; amount: number; reason?: string }) {
    if (!dto.amount || dto.amount <= 0)
      throw new BadRequestException("Amount must be greater than 0");

    // If linked to an invoice, validate + prepare the per-category breakdown that
    // drives a faithful regulated-ledger reversal (W5c) — the credit note header is
    // a single lump sum, so we derive per-line amounts from the source invoice.
    let cnItemsData: Array<{
      invoiceItemId: string;
      trackedCategoryId: string | null;
      amount: number;
      qty: number;
      categoryTax: number;
    }> = [];
    if (dto.invoiceId) {
      const invoice = await this.prisma.forTenant().invoice.findUnique({
        where: { id: dto.invoiceId },
        select: {
          total: true,
          customerId: true,
          items: {
            select: {
              id: true,
              subtotal: true,
              qty: true,
              trackedCategoryId: true,
              categoryTaxAmount: true,
              product: { select: { trackedCategoryId: true } },
            },
          },
        },
      });
      if (!invoice) throw new BadRequestException("Invoice not found");
      if (invoice.customerId !== dto.customerId)
        throw new BadRequestException("Invoice does not belong to this customer");

      // Sum existing credit notes for this invoice
      const existingCredits = await this.prisma.forTenant().creditNote.aggregate({
        where: { invoiceId: dto.invoiceId, status: { not: "VOID" } },
        _sum: { amount: true },
      });
      const totalExisting = Number(existingCredits._sum.amount ?? 0);
      const invoiceTotal = Number(invoice.total);
      if (totalExisting + dto.amount > invoiceTotal) {
        throw new BadRequestException(
          `Credit note amount (${dto.amount}) would exceed invoice total (${invoiceTotal}). Already credited: ${totalExisting}.`,
        );
      }

      // Allocate the credit proportionally across the invoice's lines by pre-tax
      // subtotal, snapshotting each line's regulated category. The cumulative-amount
      // cap above bounds cumulative reversal to ≤ the original sale.
      const fraction = invoiceTotal > 0 ? Math.min(1, dto.amount / invoiceTotal) : 0;
      cnItemsData = (invoice.items ?? []).map((it: any) => ({
        invoiceItemId: it.id,
        trackedCategoryId: it.trackedCategoryId ?? it.product?.trackedCategoryId ?? null,
        amount: roundMoney(Number(it.subtotal) * fraction),
        qty: this.round3(Number(it.qty) * fraction),
        categoryTax: roundMoney(Number(it.categoryTaxAmount ?? 0) * fraction),
      }));
    }

    const tenantId = this.prisma.getTenantId();
    const creditNoteNumber = await this.nextCnNumber();
    const cn = await this.prisma.tenantTransaction(async (tx: any) => {
      const created = await tx.creditNote.create({
        data: {
          creditNoteNumber,
          customerId: dto.customerId,
          invoiceId: dto.invoiceId,
          amount: dto.amount,
          reason: dto.reason,
          status: "ISSUED",
        },
        include: { customer: { select: { id: true, businessName: true } } },
      });
      if (cnItemsData.length > 0 && tenantId) {
        await tx.creditNoteItem.createMany({
          data: cnItemsData.map((i) => ({ ...i, creditNoteId: created.id, tenantId })),
        });
        // W5c: reverse the regulated ledger for the credited regulated portion.
        await this.ledger.reverseCreditNoteEntries({ creditNoteId: created.id, db: tx });
      }
      return created;
    });

    this.gateway.emitCreditNoteCreated(this.prisma.getTenantId(), {
      creditNoteId: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      customerId: cn.customerId,
      amount: Number(cn.amount),
    });

    return cn;
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
        { creditNoteNumber: { contains: search, mode: "insensitive" } },
        { customer: { businessName: { contains: search, mode: "insensitive" } } },
        { reason: { contains: search, mode: "insensitive" } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.forTenant().creditNote.findMany({
        where,
        include: { customer: { select: { id: true, businessName: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.forTenant().creditNote.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findAllForUser(
    user: JwtPayload,
    customerId?: string,
    status?: string,
    search?: string,
    dateFrom?: string,
    dateTo?: string,
    page = 1,
    limit = 20,
  ) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      return this.findAll(customer.id, status, search, dateFrom, dateTo, page, limit);
    }
    if (user.role === "DRIVER") {
      // Drivers have no business reading credit notes
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }
    return this.findAll(customerId, status, search, dateFrom, dateTo, page, limit);
  }

  async findOne(id: string) {
    const cn = await this.prisma.forTenant().creditNote.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
      },
    });
    if (!cn) throw new NotFoundException("Credit note not found");
    return cn;
  }

  async findOneForUser(id: string, user: JwtPayload) {
    const cn = await this.findOne(id);
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || cn.customerId !== customer.id) throw new ForbiddenException();
    }
    return cn;
  }

  async issue(id: string) {
    return this.findOne(id);
  }

  async applyToInvoice(creditNoteId: string, invoiceId: string, amount?: number) {
    return this.prisma.tenantTransaction(
      async (tx) => {
        const cn = await tx.creditNote.findUnique({ where: { id: creditNoteId } });
        if (!cn || cn.status === "APPLIED" || cn.status === "VOID")
          throw new BadRequestException("Credit note is not available for application");

        const inv = await tx.invoice.findUnique({
          where: { id: invoiceId },
          include: { payments: true },
        });
        if (!inv) throw new NotFoundException("Invoice not found");

        const notApplicableStatuses: InvoiceStatus[] = [
          InvoiceStatus.PAID,
          InvoiceStatus.VOID,
          InvoiceStatus.WRITTEN_OFF,
        ];
        if (notApplicableStatuses.includes(inv.status)) {
          throw new BadRequestException(
            `Cannot apply credit note to invoice with status ${inv.status}`,
          );
        }

        if (cn.customerId !== inv.customerId) {
          throw new BadRequestException("Credit note and invoice belong to different customers");
        }

        const alreadyPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        const invoiceBalance = Number(inv.total) - alreadyPaid;
        const cnRemaining = Number(cn.amount) - Number(cn.amountUsed);
        const applyAmount = Math.min(cnRemaining, invoiceBalance, amount ?? Infinity);

        if (applyAmount <= 0.001)
          throw new BadRequestException(
            "Credit note has no remaining balance or invoice is fully paid",
          );

        // Create invoice payment record for the credit note
        await tx.invoicePayment.create({
          data: {
            invoiceId,
            amount: applyAmount,
            method: PaymentMethod.CREDIT_NOTE,
            creditNoteId: cn.id,
            reference: cn.creditNoteNumber,
          },
        });

        // Recompute invoice status
        const newPaid = alreadyPaid + applyAmount;
        const newStatus = this.recomputeStatus(newPaid, Number(inv.total), inv.dueDate, inv.status);
        const updatedInv = await tx.invoice.update({
          where: { id: invoiceId },
          data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
          include: {
            customer: { select: { id: true, businessName: true } },
            items: true,
            payments: { orderBy: { createdAt: "desc" } },
          },
        });

        // Update amountUsed; mark APPLIED only when fully exhausted
        const newAmountUsed = Number(cn.amountUsed) + applyAmount;
        const fullyApplied = newAmountUsed >= Number(cn.amount) - 0.001;
        await tx.creditNote.update({
          where: { id: creditNoteId },
          data: {
            amountUsed: newAmountUsed,
            status: fullyApplied ? "APPLIED" : "ISSUED",
            appliedToInvoiceId: fullyApplied ? invoiceId : cn.appliedToInvoiceId,
          },
        });

        return updatedInv;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async voidCreditNote(id: string) {
    return this.prisma.tenantTransaction(async (tx: any) => {
      const updated = await tx.creditNote.update({ where: { id }, data: { status: "VOID" } });
      // W5c: undo the regulated ledger reversal booked at creation.
      await this.ledger.unreverseCreditNoteEntries({ creditNoteId: id, db: tx });
      return updated;
    });
  }
}
