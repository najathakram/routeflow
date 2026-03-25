import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TxnStatus } from "@prisma/client";
import { ListTransactionsDto } from "./dto/list-transactions.dto";
import { RecordPaymentDto } from "./dto/record-payment.dto";
import { InvoiceService } from "./invoice.service";

@Injectable()
export class BookkeepingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceService: InvoiceService,
  ) {}

  async findAll(query: ListTransactionsDto) {
    const { status, customerId, dateFrom, dateTo, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setUTCHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          payments: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
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
        order: { select: { id: true, orderNumber: true, status: true } },
        items: {
          include: { orderItem: { include: { product: { select: { id: true, name: true } } } } },
        },
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!txn) throw new NotFoundException("Transaction not found");
    return txn;
  }

  async recordPayment(id: string, dto: RecordPaymentDto) {
    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.findUnique({ where: { id }, include: { payments: true } });
      if (!txn) throw new NotFoundException("Transaction not found");

      const alreadyPaid = txn.payments.reduce((sum, p) => sum + Number(p.amount), 0);
      const totalOwed = Number(txn.totalOwed);
      const remaining = totalOwed - alreadyPaid;
      if (remaining <= 0) {
        throw new BadRequestException("Transaction is already fully paid");
      }
      if (dto.amount > remaining + 0.001) {
        throw new BadRequestException(
          `Payment of ${dto.amount} exceeds remaining balance of ${remaining.toFixed(2)}`,
        );
      }

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
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
    });
  }

  async getPdfUrl(id: string): Promise<{ url: string } | null> {
    const url = await this.invoiceService.getPresignedUrl(id);
    if (!url) return null;
    return { url };
  }

  // ── Expense Categories ──
  async listExpenseCategories() {
    return this.prisma.expenseCategory.findMany({ orderBy: { name: 'asc' } });
  }

  async createExpenseCategory(dto: { name: string; code: string }) {
    return this.prisma.expenseCategory.create({ data: { name: dto.name, code: dto.code, isCustom: true } });
  }

  // ── Expenses ──
  async listExpenses(query: { categoryId?: string; supplierId?: string; from?: string; to?: string; page?: number; limit?: number }) {
    const { categoryId, supplierId, from, to, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = { deletedAt: null };
    if (categoryId) where.categoryId = categoryId;
    if (supplierId) where.supplierId = supplierId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) { const d = new Date(to); d.setUTCHours(23,59,59,999); where.date.lte = d; }
    }
    const [data, total] = await Promise.all([
      this.prisma.expense.findMany({ where, include: { category: true, supplier: { select: { id: true, name: true } } }, skip, take: limit, orderBy: { date: 'desc' } }),
      this.prisma.expense.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createExpense(dto: any, userId: string) {
    const cat = await this.prisma.expenseCategory.findUnique({ where: { id: dto.categoryId } });
    if (!cat) throw new Error('Expense category not found');
    return this.prisma.expense.create({
      data: { categoryId: dto.categoryId, supplierId: dto.supplierId, amount: dto.amount, date: new Date(dto.date), description: dto.description, paymentMethod: dto.paymentMethod, notes: dto.notes, performedById: userId },
      include: { category: true, supplier: { select: { id: true, name: true } } },
    });
  }

  async updateExpense(id: string, dto: any) {
    return this.prisma.expense.update({ where: { id }, data: { ...(dto.amount && { amount: dto.amount }), ...(dto.date && { date: new Date(dto.date) }), ...(dto.description !== undefined && { description: dto.description }), ...(dto.notes !== undefined && { notes: dto.notes }) } });
  }

  async deleteExpense(id: string) {
    return this.prisma.expense.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ── P&L Report ──
  async getProfitAndLoss(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to ? (() => { const d = new Date(to); d.setUTCHours(23,59,59,999); return d; })() : new Date();

    const [revenueAgg, cogsMovements, expenses] = await Promise.all([
      this.prisma.transaction.aggregate({ where: { status: 'PAID', paidAt: { gte: fromDate, lte: toDate } }, _sum: { totalOwed: true } }),
      this.prisma.stockMovement.findMany({ where: { type: 'SALE', createdAt: { gte: fromDate, lte: toDate } }, select: { quantity: true, unitCost: true } }),
      this.prisma.expense.findMany({ where: { deletedAt: null, date: { gte: fromDate, lte: toDate } }, include: { category: true } }),
    ]);

    const revenue = Number(revenueAgg._sum.totalOwed ?? 0);
    const cogs = cogsMovements.reduce((s, m) => s + Math.abs(Number(m.quantity)) * Number(m.unitCost ?? 0), 0);
    const grossProfit = revenue - cogs;
    const opEx = expenses.reduce((s, e) => s + Number(e.amount), 0);
    const netProfit = grossProfit - opEx;

    const byCategory = expenses.reduce((acc: any, e) => {
      const cat = e.category.name;
      acc[cat] = (acc[cat] ?? 0) + Number(e.amount);
      return acc;
    }, {});

    return { revenue, cogs, grossProfit, operatingExpenses: opEx, netProfit, netMarginPct: revenue > 0 ? (netProfit / revenue) * 100 : 0, expensesByCategory: byCategory, period: { from: fromDate, to: toDate } };
  }

  // ── AR Aging Report ──
  async getArAging() {
    const now = new Date();
    const txns = await this.prisma.transaction.findMany({
      where: { status: { in: ['UNPAID', 'PARTIAL'] } },
      include: { customer: { select: { id: true, businessName: true } } },
    });

    const buckets: Record<string, any[]> = { current: [], days1_30: [], days31_60: [], days61_90: [], days90plus: [] };

    for (const t of txns) {
      const remaining = Number(t.totalOwed) - Number(t.totalPaid);
      if (remaining <= 0) continue;
      const entry = { id: t.id, customer: t.customer, amount: remaining, dueDate: t.dueDate };
      if (!t.dueDate || t.dueDate >= now) { buckets.current.push(entry); continue; }
      const daysPast = Math.floor((now.getTime() - t.dueDate.getTime()) / 86400000);
      if (daysPast <= 30) buckets.days1_30.push(entry);
      else if (daysPast <= 60) buckets.days31_60.push(entry);
      else if (daysPast <= 90) buckets.days61_90.push(entry);
      else buckets.days90plus.push(entry);
    }

    const sum = (arr: any[]) => arr.reduce((s, e) => s + e.amount, 0);
    return { buckets, totals: { current: sum(buckets.current), days1_30: sum(buckets.days1_30), days31_60: sum(buckets.days31_60), days61_90: sum(buckets.days61_90), days90plus: sum(buckets.days90plus), total: txns.reduce((s, t) => s + Math.max(0, Number(t.totalOwed) - Number(t.totalPaid)), 0) } };
  }

  // ── Cash Flow ──
  async getCashFlow(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to ? (() => { const d = new Date(to); d.setUTCHours(23,59,59,999); return d; })() : new Date();

    const [payments, expenses, bills] = await Promise.all([
      this.prisma.payment.findMany({ where: { paidAt: { gte: fromDate, lte: toDate } }, orderBy: { paidAt: 'asc' } }),
      this.prisma.expense.findMany({ where: { deletedAt: null, date: { gte: fromDate, lte: toDate } }, orderBy: { date: 'asc' } }),
      this.prisma.billPayment.findMany({ where: { paidAt: { gte: fromDate, lte: toDate } }, orderBy: { paidAt: 'asc' } }),
    ]);

    const totalIn = payments.reduce((s, p) => s + Number(p.amount), 0);
    const totalOut = expenses.reduce((s, e) => s + Number(e.amount), 0) + bills.reduce((s, b) => s + Number(b.amount), 0);
    return { totalIn, totalOut, netCashFlow: totalIn - totalOut, period: { from: fromDate, to: toDate } };
  }

  async getSummary() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);

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
          where: { createdAt: { gte: sevenDaysAgo } },
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
