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
    return this.prisma.expenseCategory.findMany({ orderBy: { name: "asc" } });
  }

  async createExpenseCategory(dto: { name: string; code: string }) {
    return this.prisma.expenseCategory.create({
      data: { name: dto.name, code: dto.code, isCustom: true },
    });
  }

  // ── Expenses ──
  async listExpenses(query: {
    categoryId?: string;
    supplierId?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const { categoryId, supplierId, from, to, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = { deletedAt: null };
    if (categoryId) where.categoryId = categoryId;
    if (supplierId) where.supplierId = supplierId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) {
        const d = new Date(to);
        d.setUTCHours(23, 59, 59, 999);
        where.date.lte = d;
      }
    }
    const [data, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        include: { category: true, supplier: { select: { id: true, name: true } } },
        skip,
        take: limit,
        orderBy: { date: "desc" },
      }),
      this.prisma.expense.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createExpense(dto: any, userId: string) {
    const cat = await this.prisma.expenseCategory.findUnique({ where: { id: dto.categoryId } });
    if (!cat) throw new Error("Expense category not found");
    return this.prisma.expense.create({
      data: {
        categoryId: dto.categoryId,
        supplierId: dto.supplierId,
        amount: dto.amount,
        date: new Date(dto.date),
        description: dto.description,
        paymentMethod: dto.paymentMethod,
        notes: dto.notes,
        performedById: userId,
      },
      include: { category: true, supplier: { select: { id: true, name: true } } },
    });
  }

  async updateExpense(id: string, dto: any) {
    return this.prisma.expense.update({
      where: { id },
      data: {
        ...(dto.amount && { amount: dto.amount }),
        ...(dto.date && { date: new Date(dto.date) }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });
  }

  async deleteExpense(id: string) {
    return this.prisma.expense.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ── P&L Report ──
  async getProfitAndLoss(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();

    const [revenueAgg, cogsMovements, expenses] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { status: "PAID", paidAt: { gte: fromDate, lte: toDate } },
        _sum: { totalOwed: true },
      }),
      this.prisma.stockMovement.findMany({
        where: { type: "SALE", createdAt: { gte: fromDate, lte: toDate } },
        select: { quantity: true, unitCost: true },
      }),
      this.prisma.expense.findMany({
        where: { deletedAt: null, date: { gte: fromDate, lte: toDate } },
        include: { category: true },
      }),
    ]);

    const revenue = Number(revenueAgg._sum.totalOwed ?? 0);
    const cogs = cogsMovements.reduce(
      (s, m) => s + Math.abs(Number(m.quantity)) * Number(m.unitCost ?? 0),
      0,
    );
    const grossProfit = revenue - cogs;
    const opEx = expenses.reduce((s, e) => s + Number(e.amount), 0);
    const netProfit = grossProfit - opEx;

    const byCategory = expenses.reduce((acc: any, e) => {
      const cat = e.category.name;
      acc[cat] = (acc[cat] ?? 0) + Number(e.amount);
      return acc;
    }, {});

    return {
      revenue,
      cogs,
      grossProfit,
      operatingExpenses: opEx,
      netProfit,
      netMarginPct: revenue > 0 ? (netProfit / revenue) * 100 : 0,
      expensesByCategory: byCategory,
      period: { from: fromDate, to: toDate },
    };
  }

  // ── AR Aging Report ──
  async getArAging() {
    const now = new Date();
    const txns = await this.prisma.transaction.findMany({
      where: { status: { in: ["UNPAID", "PARTIAL"] } },
      include: { customer: { select: { id: true, businessName: true } } },
    });

    const buckets: Record<string, any[]> = {
      current: [],
      days1_30: [],
      days31_60: [],
      days61_90: [],
      days90plus: [],
    };

    for (const t of txns) {
      const remaining = Number(t.totalOwed) - Number(t.totalPaid);
      if (remaining <= 0) continue;
      const entry = { id: t.id, customer: t.customer, amount: remaining, dueDate: t.dueDate };
      if (!t.dueDate || t.dueDate >= now) {
        buckets.current.push(entry);
        continue;
      }
      const daysPast = Math.floor((now.getTime() - t.dueDate.getTime()) / 86400000);
      if (daysPast <= 30) buckets.days1_30.push(entry);
      else if (daysPast <= 60) buckets.days31_60.push(entry);
      else if (daysPast <= 90) buckets.days61_90.push(entry);
      else buckets.days90plus.push(entry);
    }

    const sum = (arr: any[]) => arr.reduce((s, e) => s + e.amount, 0);
    return {
      buckets,
      totals: {
        current: sum(buckets.current),
        days1_30: sum(buckets.days1_30),
        days31_60: sum(buckets.days31_60),
        days61_90: sum(buckets.days61_90),
        days90plus: sum(buckets.days90plus),
        total: txns.reduce((s, t) => s + Math.max(0, Number(t.totalOwed) - Number(t.totalPaid)), 0),
      },
    };
  }

  // ── Cash Flow ──
  async getCashFlow(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();

    const [payments, expenses, bills] = await Promise.all([
      this.prisma.payment.findMany({
        where: { paidAt: { gte: fromDate, lte: toDate } },
        orderBy: { paidAt: "asc" },
      }),
      this.prisma.expense.findMany({
        where: { deletedAt: null, date: { gte: fromDate, lte: toDate } },
        orderBy: { date: "asc" },
      }),
      this.prisma.billPayment.findMany({
        where: { paidAt: { gte: fromDate, lte: toDate } },
        orderBy: { paidAt: "asc" },
      }),
    ]);

    const totalIn = payments.reduce((s, p) => s + Number(p.amount), 0);
    const totalOut =
      expenses.reduce((s, e) => s + Number(e.amount), 0) +
      bills.reduce((s, b) => s + Number(b.amount), 0);
    return {
      totalIn,
      totalOut,
      netCashFlow: totalIn - totalOut,
      period: { from: fromDate, to: toDate },
    };
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

  // ── Finance Dashboard ──
  async getFinanceDashboard() {
    const { InvoiceStatus } = await import("@prisma/client");
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const unpaidInvoices = await this.prisma.invoice.findMany({
      where: {
        status: {
          in: [
            InvoiceStatus.SENT,
            InvoiceStatus.VIEWED,
            InvoiceStatus.PARTIAL,
            InvoiceStatus.OVERDUE,
          ],
        },
      },
      include: { payments: true },
    });

    let arCurrent = 0,
      ar1_15 = 0,
      ar16_30 = 0,
      ar31_45 = 0,
      ar45plus = 0;
    for (const inv of unpaidInvoices) {
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const bal = Number(inv.total) - paid;
      if (bal <= 0) continue;
      if (!inv.dueDate || inv.dueDate >= now) {
        arCurrent += bal;
        continue;
      }
      const daysPast = Math.floor((now.getTime() - inv.dueDate.getTime()) / 86400000);
      if (daysPast <= 15) ar1_15 += bal;
      else if (daysPast <= 30) ar16_30 += bal;
      else if (daysPast <= 45) ar31_45 += bal;
      else ar45plus += bal;
    }
    const totalReceivables = arCurrent + ar1_15 + ar16_30 + ar31_45 + ar45plus;

    const monthlyData: Array<{ month: string; sales: number; receipts: number; expenses: number }> =
      [];
    for (let m = 0; m < 12; m++) {
      const mStart = new Date(now.getFullYear(), m, 1);
      const mEnd = new Date(now.getFullYear(), m + 1, 0, 23, 59, 59, 999);
      const [salesAgg, receiptsAgg, expensesAgg] = await Promise.all([
        this.prisma.invoice.aggregate({
          where: { status: InvoiceStatus.PAID, paidAt: { gte: mStart, lte: mEnd } },
          _sum: { total: true },
        }),
        this.prisma.invoicePayment.aggregate({
          where: { createdAt: { gte: mStart, lte: mEnd } },
          _sum: { amount: true },
        }),
        this.prisma.expense.aggregate({
          where: { deletedAt: null, date: { gte: mStart, lte: mEnd } },
          _sum: { amount: true },
        }),
      ]);
      monthlyData.push({
        month: mStart.toLocaleString("default", { month: "short" }),
        sales: Number(salesAgg._sum.total ?? 0),
        receipts: Number(receiptsAgg._sum.amount ?? 0),
        expenses: Number(expensesAgg._sum.amount ?? 0),
      });
    }
    const totalSales = monthlyData.reduce((s, m) => s + m.sales, 0);
    const totalReceipts = monthlyData.reduce((s, m) => s + m.receipts, 0);
    const totalExpenses = monthlyData.reduce((s, m) => s + m.expenses, 0);

    const expenses = await this.prisma.expense.findMany({
      where: { deletedAt: null, date: { gte: startOfYear } },
      include: { category: true },
    });
    const byCat: Record<string, number> = {};
    for (const e of expenses) {
      byCat[e.category.name] = (byCat[e.category.name] ?? 0) + Number(e.amount);
    }
    const topExpenses = Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, amount]) => ({ name, amount }));

    const getPeriodSummary = async (from: Date) => {
      const [s, r] = await Promise.all([
        this.prisma.invoice.aggregate({
          where: { issueDate: { gte: from } },
          _sum: { total: true },
        }),
        this.prisma.invoicePayment.aggregate({
          where: { createdAt: { gte: from } },
          _sum: { amount: true },
        }),
      ]);
      const dueInvoices = await this.prisma.invoice.findMany({
        where: {
          status: {
            in: [
              InvoiceStatus.SENT,
              InvoiceStatus.VIEWED,
              InvoiceStatus.PARTIAL,
              InvoiceStatus.OVERDUE,
            ],
          },
          dueDate: { gte: from },
        },
        include: { payments: true },
      });
      const due = dueInvoices.reduce((sum, inv) => {
        const b = Number(inv.total) - inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        return sum + Math.max(0, b);
      }, 0);
      return { sales: Number(s._sum.total ?? 0), receipts: Number(r._sum.amount ?? 0), due };
    };
    const [today, thisWeek, thisMonth, thisQuarter, thisYear] = await Promise.all([
      getPeriodSummary(startOfToday),
      getPeriodSummary(startOfWeek),
      getPeriodSummary(startOfMonth),
      getPeriodSummary(startOfQuarter),
      getPeriodSummary(startOfYear),
    ]);

    return {
      arAging: {
        total: totalReceivables,
        current: arCurrent,
        days1_15: ar1_15,
        days16_30: ar16_30,
        days31_45: ar31_45,
        days45plus: ar45plus,
      },
      monthlySales: { data: monthlyData, totalSales, totalReceipts, totalExpenses },
      topExpenses,
      summaryTable: { today, thisWeek, thisMonth, thisQuarter, thisYear },
    };
  }

  async getArAgingInvoices() {
    const { InvoiceStatus } = await import("@prisma/client");
    const now = new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: {
          in: [
            InvoiceStatus.SENT,
            InvoiceStatus.VIEWED,
            InvoiceStatus.PARTIAL,
            InvoiceStatus.OVERDUE,
          ],
        },
      },
      include: { customer: { select: { id: true, businessName: true } }, payments: true },
    });

    const buckets: Record<string, any[]> = {
      current: [],
      days1_30: [],
      days31_60: [],
      days61_90: [],
      days90plus: [],
    };
    for (const inv of invoices) {
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const balance = Number(inv.total) - paid;
      if (balance <= 0) continue;
      const entry = {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customer: inv.customer,
        total: Number(inv.total),
        balance,
        dueDate: inv.dueDate,
        status: inv.status,
      };
      if (!inv.dueDate || inv.dueDate >= now) {
        buckets.current.push(entry);
        continue;
      }
      const daysPast = Math.floor((now.getTime() - inv.dueDate.getTime()) / 86400000);
      if (daysPast <= 30) buckets.days1_30.push(entry);
      else if (daysPast <= 60) buckets.days31_60.push(entry);
      else if (daysPast <= 90) buckets.days61_90.push(entry);
      else buckets.days90plus.push(entry);
    }
    const sum = (arr: any[]) => arr.reduce((s, e) => s + e.balance, 0);
    return {
      buckets,
      totals: {
        current: sum(buckets.current),
        days1_30: sum(buckets.days1_30),
        days31_60: sum(buckets.days31_60),
        days61_90: sum(buckets.days61_90),
        days90plus: sum(buckets.days90plus),
        total: sum([
          ...buckets.current,
          ...buckets.days1_30,
          ...buckets.days31_60,
          ...buckets.days61_90,
          ...buckets.days90plus,
        ]),
      },
    };
  }

  async getSalesByCustomer(from?: string, to?: string) {
    const { InvoiceStatus } = await import("@prisma/client");
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: { status: InvoiceStatus.PAID, paidAt: { gte: fromDate, lte: toDate } },
      include: { customer: { select: { id: true, businessName: true } } },
    });
    const byCustomer: Record<
      string,
      { customerId: string; businessName: string; invoiceCount: number; salesAmount: number }
    > = {};
    for (const inv of invoices) {
      const key = inv.customerId;
      if (!byCustomer[key])
        byCustomer[key] = {
          customerId: key,
          businessName: inv.customer.businessName,
          invoiceCount: 0,
          salesAmount: 0,
        };
      byCustomer[key].invoiceCount++;
      byCustomer[key].salesAmount += Number(inv.total);
    }
    return {
      data: Object.values(byCustomer).sort((a, b) => b.salesAmount - a.salesAmount),
      period: { from: fromDate, to: toDate },
    };
  }

  async getSalesByItem(from?: string, to?: string) {
    const { InvoiceStatus } = await import("@prisma/client");
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const items = await this.prisma.invoiceItem.findMany({
      where: { invoice: { status: InvoiceStatus.PAID, paidAt: { gte: fromDate, lte: toDate } } },
      include: { product: { select: { id: true, name: true } } },
    });
    const byItem: Record<
      string,
      { productId: string | null; name: string; qty: number; amount: number }
    > = {};
    for (const item of items) {
      const key = item.productId ?? `desc:${item.description}`;
      const name = item.product?.name ?? item.description;
      if (!byItem[key]) byItem[key] = { productId: item.productId, name, qty: 0, amount: 0 };
      byItem[key].qty += Number(item.qty);
      byItem[key].amount += Number(item.subtotal);
    }
    return {
      data: Object.values(byItem).sort((a, b) => b.amount - a.amount),
      period: { from: fromDate, to: toDate },
    };
  }

  async getCustomerBalanceSummary() {
    const { InvoiceStatus } = await import("@prisma/client");
    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: {
          in: [
            InvoiceStatus.SENT,
            InvoiceStatus.VIEWED,
            InvoiceStatus.PARTIAL,
            InvoiceStatus.OVERDUE,
          ],
        },
      },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true, phone: true } },
        payments: true,
      },
    });
    const byCustomer: Record<
      string,
      {
        customerId: string;
        businessName: string;
        contactName?: string;
        phone?: string;
        invoiceCount: number;
        balance: number;
        overdue: number;
      }
    > = {};
    const now = new Date();
    for (const inv of invoices) {
      const key = inv.customerId;
      if (!byCustomer[key])
        byCustomer[key] = {
          customerId: key,
          businessName: inv.customer.businessName,
          contactName: inv.customer.contactName ?? undefined,
          phone: inv.customer.phone ?? undefined,
          invoiceCount: 0,
          balance: 0,
          overdue: 0,
        };
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const bal = Number(inv.total) - paid;
      byCustomer[key].invoiceCount++;
      byCustomer[key].balance += bal;
      if (inv.dueDate && inv.dueDate < now) byCustomer[key].overdue += bal;
    }
    return { data: Object.values(byCustomer).sort((a, b) => b.balance - a.balance) };
  }

  async getInvoiceDetailsReport(from?: string, to?: string, status?: string) {
    const { InvoiceStatus } = await import("@prisma/client");
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const where: any = { issueDate: { gte: fromDate, lte: toDate } };
    if (status) where.status = status as (typeof InvoiceStatus)[keyof typeof InvoiceStatus];
    const invoices = await this.prisma.invoice.findMany({
      where,
      include: { customer: { select: { id: true, businessName: true } }, payments: true },
      orderBy: { issueDate: "desc" },
    });
    return {
      data: invoices.map((inv) => {
        const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customer: inv.customer,
          issueDate: inv.issueDate,
          dueDate: inv.dueDate,
          status: inv.status,
          total: Number(inv.total),
          paid,
          balance: Number(inv.total) - paid,
        };
      }),
      period: { from: fromDate, to: toDate },
    };
  }

  async getBadDebtsReport() {
    const { InvoiceStatus } = await import("@prisma/client");
    const invoices = await this.prisma.invoice.findMany({
      where: { status: InvoiceStatus.WRITTEN_OFF },
      include: { customer: { select: { id: true, businessName: true } }, payments: true },
      orderBy: { writtenOffAt: "desc" },
    });
    return {
      data: invoices.map((inv) => {
        const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customer: inv.customer,
          issueDate: inv.issueDate,
          dueDate: inv.dueDate,
          writtenOffAt: inv.writtenOffAt,
          writeOffReason: inv.writeOffReason,
          total: Number(inv.total),
          paid,
          balance: Number(inv.total) - paid,
        };
      }),
      total: invoices.reduce(
        (s, inv) =>
          s + Number(inv.total) - inv.payments.reduce((p, py) => p + Number(py.amount), 0),
        0,
      ),
    };
  }

  async getPaymentsReceivedReport(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const payments = await this.prisma.invoicePayment.findMany({
      where: { createdAt: { gte: fromDate, lte: toDate } },
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
      orderBy: { createdAt: "desc" },
    });
    return {
      data: payments.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        amount: Number(p.amount),
        method: p.method,
        reference: p.reference,
        invoiceId: p.invoiceId,
        invoiceNumber: p.invoice.invoiceNumber,
        customer: p.invoice.customer,
      })),
      total: payments.reduce((s, p) => s + Number(p.amount), 0),
      period: { from: fromDate, to: toDate },
    };
  }

  async getTimeToGetPaid(from?: string, to?: string) {
    const { InvoiceStatus } = await import("@prisma/client");
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: { status: InvoiceStatus.PAID, paidAt: { gte: fromDate, lte: toDate } },
      select: {
        id: true,
        invoiceNumber: true,
        issueDate: true,
        paidAt: true,
        total: true,
        customerId: true,
        customer: { select: { id: true, businessName: true } },
      },
    });
    const withDays = invoices.map((inv) => ({
      ...inv,
      total: Number(inv.total),
      daysToPayment:
        inv.paidAt && inv.issueDate
          ? Math.floor((inv.paidAt.getTime() - inv.issueDate.getTime()) / 86400000)
          : null,
    }));
    const withDaysFiltered = withDays.filter((i) => i.daysToPayment !== null);
    const avg =
      withDaysFiltered.length > 0
        ? withDaysFiltered.reduce((s, i) => s + (i.daysToPayment ?? 0), 0) / withDaysFiltered.length
        : 0;
    return { data: withDays, averageDays: Math.round(avg), period: { from: fromDate, to: toDate } };
  }

  async getExpenseDetailsReport(from?: string, to?: string, categoryId?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const where: any = { deletedAt: null, date: { gte: fromDate, lte: toDate } };
    if (categoryId) where.categoryId = categoryId;
    const expenses = await this.prisma.expense.findMany({
      where,
      include: { category: true, supplier: { select: { id: true, name: true } } },
      orderBy: { date: "desc" },
    });
    return {
      data: expenses.map((e) => ({
        id: e.id,
        date: e.date,
        category: e.category,
        supplier: e.supplier,
        amount: Number(e.amount),
        description: e.description,
        paymentMethod: e.paymentMethod,
        notes: e.notes,
      })),
      total: expenses.reduce((s, e) => s + Number(e.amount), 0),
      period: { from: fromDate, to: toDate },
    };
  }

  async getExpensesByCategoryReport(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const expenses = await this.prisma.expense.findMany({
      where: { deletedAt: null, date: { gte: fromDate, lte: toDate } },
      include: { category: true },
    });
    const byCat: Record<
      string,
      { categoryId: string; categoryName: string; count: number; total: number }
    > = {};
    for (const e of expenses) {
      const key = e.categoryId;
      if (!byCat[key])
        byCat[key] = { categoryId: key, categoryName: e.category.name, count: 0, total: 0 };
      byCat[key].count++;
      byCat[key].total += Number(e.amount);
    }
    return {
      data: Object.values(byCat).sort((a, b) => b.total - a.total),
      grandTotal: expenses.reduce((s, e) => s + Number(e.amount), 0),
      period: { from: fromDate, to: toDate },
    };
  }

  async getExpensesByCustomerReport(from?: string, to?: string) {
    return {
      data: [],
      period: {
        from: from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1),
        to: to ? new Date(to) : new Date(),
      },
    };
  }
}
