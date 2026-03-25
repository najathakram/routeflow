import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class VendorBillsService {
  constructor(private readonly prisma: PrismaService) {}

  private async nextBillNumber() {
    const year = new Date().getFullYear();
    const prefix = `BILL-${year}-`;
    const last = await this.prisma.vendorBill.findFirst({
      where: { billNumber: { startsWith: prefix } },
      orderBy: { billNumber: "desc" },
    });
    const seq = last ? parseInt(last.billNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  async create(dto: any) {
    // Calculate totalOwed from line items if provided, otherwise use dto.totalOwed
    let totalOwed = dto.totalOwed ?? 0;
    if (dto.items && Array.isArray(dto.items) && dto.items.length > 0) {
      totalOwed = dto.items.reduce((sum: number, item: any) => sum + (Number(item.qty) || 1) * Number(item.unitCost || 0), 0);
    }
    return this.prisma.vendorBill.create({
      data: {
        billNumber: await this.nextBillNumber(),
        supplierId: dto.supplierId,
        status: "DRAFT",
        totalOwed,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        notes: dto.notes,
      },
      include: { supplier: { select: { id: true, name: true } } },
    });
  }

  async receive(id: string) {
    const bill = await this.prisma.vendorBill.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException("Bill not found");
    return this.prisma.vendorBill.update({
      where: { id },
      data: { status: "RECEIVED", receivedDate: new Date() },
      include: { supplier: { select: { id: true, name: true } } },
    });
  }

  async voidBill(id: string) {
    return this.prisma.vendorBill.update({ where: { id }, data: { status: "DRAFT" as any } });
  }

  async findAll(supplierId?: string, status?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (supplierId) where.supplierId = supplierId;
    if (status) where.status = status;
    const [data, total] = await Promise.all([
      this.prisma.vendorBill.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          payments: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.vendorBill.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const bill = await this.prisma.vendorBill.findUnique({
      where: { id },
      include: { supplier: true, payments: { orderBy: { createdAt: "desc" } } },
    });
    if (!bill) throw new NotFoundException("Vendor bill not found");
    return bill;
  }

  async recordPayment(id: string, dto: { amount: number; method: string; reference?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.vendorBill.findUnique({ where: { id }, include: { payments: true } });
      if (!bill) throw new NotFoundException("Bill not found");
      const alreadyPaid = bill.payments.reduce((s, p) => s + Number(p.amount), 0);
      const remaining = Number(bill.totalOwed) - alreadyPaid;
      if (remaining <= 0) throw new BadRequestException("Bill already fully paid");
      await tx.billPayment.create({
        data: { vendorBillId: id, amount: dto.amount, method: dto.method as any, reference: dto.reference },
      });
      const newPaid = alreadyPaid + dto.amount;
      const newStatus = newPaid >= Number(bill.totalOwed) - 0.001 ? "PAID" : "PARTIAL";
      return tx.vendorBill.update({
        where: { id },
        data: { totalPaid: newPaid, status: newStatus as any },
        include: { supplier: { select: { id: true, name: true } }, payments: { orderBy: { createdAt: "desc" } } },
      });
    });
  }
}
