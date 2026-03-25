import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CreditNotesService {
  constructor(private readonly prisma: PrismaService) {}

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

  async create(dto: { customerId: string; invoiceId?: string; amount: number; reason?: string }) {
    return this.prisma.creditNote.create({
      data: {
        creditNoteNumber: await this.nextCnNumber(),
        customerId: dto.customerId,
        invoiceId: dto.invoiceId,
        amount: dto.amount,
        reason: dto.reason,
        status: "OPEN",
      },
      include: { customer: { select: { id: true, businessName: true } } },
    });
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

  async findOne(id: string) {
    const cn = await this.prisma.creditNote.findUnique({
      where: { id },
      include: { customer: { select: { id: true, businessName: true } }, invoice: { select: { id: true, invoiceNumber: true } } },
    });
    if (!cn) throw new NotFoundException("Credit note not found");
    return cn;
  }

  // OPEN is the "issued" state — this is a no-op provided for API parity
  async issue(id: string) {
    return this.findOne(id);
  }

  async applyToInvoice(creditNoteId: string, invoiceId: string) {
    const cn = await this.prisma.creditNote.findUnique({ where: { id: creditNoteId } });
    if (!cn || cn.status !== "OPEN") throw new BadRequestException("Credit note not available");
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException("Invoice not found");
    await this.prisma.creditNote.update({ where: { id: creditNoteId }, data: { status: "APPLIED", appliedToInvoiceId: invoiceId } });
    return { applied: true };
  }

  async voidCreditNote(id: string) {
    return this.prisma.creditNote.update({ where: { id }, data: { status: "VOID" } });
  }
}
