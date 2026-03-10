import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TxnStatus } from '@prisma/client';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import { RecordPaymentDto } from './dto/record-payment.dto';

@Injectable()
export class BookkeepingService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListTransactionsDto) {
    const { status, customerId, dateFrom, dateTo, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const txn = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true } },
        order: { select: { id: true, orderNumber: true } },
        items: { include: { orderItem: { include: { product: { select: { id: true, name: true } } } } } },
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!txn) throw new NotFoundException('Transaction not found');
    return txn;
  }

  async recordPayment(id: string, dto: RecordPaymentDto) {
    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.findUnique({ where: { id }, include: { payments: true } });
      if (!txn) throw new NotFoundException('Transaction not found');

      await tx.payment.create({
        data: {
          transactionId: id,
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
        },
      });

      const totalPaid = txn.payments.reduce((sum, p) => sum + Number(p.amount), 0) + dto.amount;
      const totalOwed = Number(txn.totalOwed);

      let newStatus: TxnStatus;
      let paidAt: Date | null = null;
      if (totalPaid >= totalOwed) {
        newStatus = TxnStatus.PAID;
        paidAt = new Date();
      } else if (totalPaid > 0) {
        newStatus = TxnStatus.PARTIAL;
      } else {
        newStatus = TxnStatus.UNPAID;
      }

      return tx.transaction.update({
        where: { id },
        data: { totalPaid, status: newStatus, paidAt },
        include: {
          customer: { select: { id: true, businessName: true } },
          payments: { orderBy: { createdAt: 'desc' } },
        },
      });
    });
  }

  async getSummary() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 7);

    const [totalRevenueResult, outstandingResult, paymentsThisWeekResult, overdueCount] =
      await Promise.all([
        this.prisma.transaction.aggregate({
          where: { status: TxnStatus.PAID, paidAt: { gte: startOfMonth } },
          _sum: { totalOwed: true },
        }),
        this.prisma.transaction.findMany({
          where: { status: { in: [TxnStatus.UNPAID, TxnStatus.PARTIAL] } },
          select: { totalOwed: true, totalPaid: true },
        }),
        this.prisma.payment.aggregate({
          where: { createdAt: { gte: startOfWeek } },
          _sum: { amount: true },
        }),
        this.prisma.transaction.count({
          where: {
            status: { not: TxnStatus.PAID },
            dueDate: { lt: now },
          },
        }),
      ]);

    const outstandingReceivables = outstandingResult.reduce(
      (sum, t) => sum + (Number(t.totalOwed) - Number(t.totalPaid)),
      0,
    );

    return {
      totalRevenue: Number(totalRevenueResult._sum.totalOwed ?? 0),
      outstandingReceivables,
      paymentsThisWeek: Number(paymentsThisWeekResult._sum.amount ?? 0),
      overdueCount,
    };
  }
}
