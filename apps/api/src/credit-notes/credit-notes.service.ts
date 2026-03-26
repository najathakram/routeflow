import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";

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

  async create(dto: { customerId: string; invoiceId?: string; amount: number; reason?: string }) {
    if (!dto.amount || dto.amount <= 0) throw new BadRequestException("Amount must be greater than 0");
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
      include: { customer: { select: { id: true, businessName: true } }, invoice: { select: { id: true, invoiceNumber: true } } },
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

  async applyToInvoice(creditNoteId: string, invoiceId: string) {
    const cn = await this.prisma.creditNote.findUnique({ where: { id: creditNoteId } });
    if (!cn || cn.status !== "ISSUED") throw new BadRequestException("Credit note not available");
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException("Invoice not found");
    await this.prisma.creditNote.update({ where: { id: creditNoteId }, data: { status: "APPLIED", appliedToInvoiceId: invoiceId } });
    return { applied: true };
  }

  async voidCreditNote(id: string) {
    return this.prisma.creditNote.update({ where: { id }, data: { status: "VOID" } });
  }
}
