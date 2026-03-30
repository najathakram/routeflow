import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { InvoiceStatus, PaymentMethod } from "@prisma/client";

@Injectable()
export class CreditNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  private async nextCnNumber() {
    const year = new Date().getFullYear();
    const prefix = `CN-${year}-`;
    const last = await this.prisma.creditNote.findFirst({
      where: { creditNoteNumber: { startsWith: prefix } },
      orderBy: { creditNoteNumber: "desc" },
    });
    const seq = last ? parseInt(last.creditNoteNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  private recomputeStatus(totalPaid: number, total: number, dueDate: Date | null): InvoiceStatus {
    if (totalPaid >= total - 0.001) return InvoiceStatus.PAID;
    if (totalPaid > 0) return InvoiceStatus.PARTIAL;
    if (dueDate && new Date(dueDate) < new Date()) return InvoiceStatus.OVERDUE;
    return InvoiceStatus.SENT;
  }

  async create(dto: { customerId: string; invoiceId?: string; amount: number; reason?: string }) {
    if (!dto.amount || dto.amount <= 0)
      throw new BadRequestException("Amount must be greater than 0");
    const cn = await this.prisma.creditNote.create({
      data: {
        creditNoteNumber: await this.nextCnNumber(),
        customerId: dto.customerId,
        invoiceId: dto.invoiceId,
        amount: dto.amount,
        reason: dto.reason,
        status: "ISSUED",
      },
      include: { customer: { select: { id: true, businessName: true } } },
    });

    this.gateway.emitCreditNoteCreated({
      creditNoteId: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      customerId: cn.customerId,
      amount: Number(cn.amount),
    });

    return cn;
  }

  async findAll(customerId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = customerId ? { customerId } : {};
    const [data, total] = await Promise.all([
      this.prisma.creditNote.findMany({
        where,
        include: { customer: { select: { id: true, businessName: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.creditNote.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findAllForUser(user: JwtPayload, customerId?: string, page = 1, limit = 20) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer) return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      return this.findAll(customer.id, page, limit);
    }
    return this.findAll(customerId, page, limit);
  }

  async findOne(id: string) {
    const cn = await this.prisma.creditNote.findUnique({
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
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer || cn.customerId !== customer.id) throw new ForbiddenException();
    }
    return cn;
  }

  async issue(id: string) {
    return this.findOne(id);
  }

  async applyToInvoice(creditNoteId: string, invoiceId: string, amount?: number) {
    return this.prisma.$transaction(async (tx) => {
      const cn = await tx.creditNote.findUnique({ where: { id: creditNoteId } });
      if (!cn || cn.status !== "ISSUED")
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
      const cnAmount = Number(cn.amount);
      const applyAmount = Math.min(cnAmount, invoiceBalance, amount ?? Infinity);

      if (applyAmount <= 0) throw new BadRequestException("Invoice has no outstanding balance");

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
      const newStatus = this.recomputeStatus(newPaid, Number(inv.total), inv.dueDate);
      const updatedInv = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });

      // Mark credit note as APPLIED
      await tx.creditNote.update({
        where: { id: creditNoteId },
        data: { status: "APPLIED", appliedToInvoiceId: invoiceId },
      });

      return updatedInv;
    });
  }

  async voidCreditNote(id: string) {
    return this.prisma.creditNote.update({ where: { id }, data: { status: "VOID" } });
  }
}
