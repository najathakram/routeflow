import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { lockBillRows } from "../vendor-bills/bill-locks";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { PrismaService } from "../prisma/prisma.service";
import { isOverdue, overdueCutoff, startOfCalendarDay } from "../common/calendar-date";
import { computeDepositFields } from "../invoices/deposit-fields";
import { tenantTimeZone } from "../common/tenant-time-zone";
import {
  CheckStatus,
  InvoiceStatus,
  TxnStatus,
  PaymentStatus,
  CreditNoteStatus,
} from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import {
  ACCRUAL_REVENUE_STATUSES,
  estimateCogs,
  fetchAccrualNetSales,
  fetchAccrualNetSalesByCustomer,
  fetchBadDebtExpense,
  fetchCostIndex,
  fetchInvoicedSaleLines,
  fetchProductCostFacts,
  soldProductIds,
} from "../common/invoiced-sales";
import { ListTransactionsDto } from "./dto/list-transactions.dto";
import { RecordPaymentDto } from "./dto/record-payment.dto";
import { BulkMarkPaidDto } from "../vendor-bills/dto/bulk-mark-paid.dto";
import { InvoiceService } from "./invoice.service";
import { StorageService } from "../storage/storage.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import Anthropic from "@anthropic-ai/sdk";
import { compressDocument } from "../storage/compress.util";
import { IRS_SYSTEM_CATEGORIES } from "./irs-categories.constant";
import {
  CONFIRMED_PAYMENT,
  RECEIVED_METHOD_FILTER,
  splitConfirmed,
  sumConfirmed,
} from "../invoices/payment-predicates";
import { settledDateFilter } from "../invoices/settled-date-filter";
import { lockInvoicesForPayment } from "../invoices/invoice-send-guard";
import { overdueInvoiceCount } from "../invoices/invoice-balance-sql";
import { confirmedBalance } from "../invoices/invoice-balance-classify";

/**
 * Receipt-extraction model. Receipts are small documents where a misread line
 * lands directly in the books, so this path pays for the most capable model;
 * kept as its own constant so it can diverge from the OCR scanners'.
 */
const RECEIPT_MODEL = "claude-opus-4-5-20251101";

@Injectable()
export class BookkeepingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceService: InvoiceService,
    private readonly storage: StorageService,
    private readonly vendorBillsService: VendorBillsService,
    private readonly systemConfig: SystemConfigService,
    private readonly platformConfig: PlatformConfigService,
    private readonly commissionEngine: CommissionEngineService,
  ) {}

  async onModuleInit() {
    // These helpers were designed for a single-tenant setup. In multi-tenant
    // mode there is no tenant context at startup, so they would run unscoped
    // across ALL tenants — potentially hanging on large data sets. Skip them
    // at boot; they will be lazily called per-tenant on first request instead.
  }

  /**
   * B440 fix-round finding 2: the accrual-net-sales helpers (invoiced-sales.ts)
   * fail CLOSED on tenant scoping — they take `tenantId: string`, not
   * `string | null`, and put it in every where-clause explicitly rather than
   * relying solely on `forTenant()`'s ambient injection (which silently
   * returns the UNSCOPED client under a null tenant context). Every caller
   * of those helpers resolves its tenantId through here first.
   */
  private requireTenantId(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new Error("No tenant context for bookkeeping read");
    return tenantId;
  }

  async findAll(query: ListTransactionsDto) {
    const { status, customerId, dateFrom, dateTo, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    // Base filter: exclude drafts and voided invoices
    const where: any = {
      status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID] },
    };

    // Map TxnStatus filter values to InvoiceStatus
    if (status === "PAID") {
      where.status = InvoiceStatus.PAID;
    } else if (status === "PARTIAL") {
      where.status = InvoiceStatus.PARTIAL;
    } else if (status === "UNPAID") {
      where.status = { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE] };
    }

    if (customerId) where.customerId = customerId;
    if (dateFrom || dateTo) {
      where.issueDate = {};
      if (dateFrom) where.issueDate.gte = new Date(dateFrom);
      if (dateTo) {
        const d = new Date(dateTo);
        d.setUTCHours(23, 59, 59, 999);
        where.issueDate.lte = d;
      }
    }

    const [invoices, total] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          payments: { orderBy: { createdAt: "desc" }, take: 1 },
          order: { select: { id: true, orderNumber: true, status: true } },
        },
        skip,
        take: limit,
        orderBy: { issueDate: "desc" },
      }),
      this.prisma.forTenant().invoice.count({ where }),
    ]);

    const data = invoices.map((inv) => {
      // F03/R1: the ledger's paid total counts CONFIRMED (PAID) money only — a
      // DRAFT payment isn't collected, nor is a VOID (bounced) one (P5-12). The
      // rows themselves are still returned unfiltered so the UI can badge them.
      // B421: totalPaid is cash-only — a CREDIT_NOTE or ADVANCE application
      // must not render as cash the tenant collected on this transaction.
      const { cash: paid, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
      let ledgerStatus: TxnStatus;
      if (inv.status === InvoiceStatus.PAID) ledgerStatus = TxnStatus.PAID;
      else if (inv.status === InvoiceStatus.PARTIAL) ledgerStatus = TxnStatus.PARTIAL;
      else ledgerStatus = TxnStatus.UNPAID;
      return {
        id: inv.id,
        status: ledgerStatus,
        customerId: inv.customerId,
        createdAt: inv.issueDate,
        totalOwed: Number(inv.total),
        totalPaid: paid,
        creditApplied,
        advanceApplied,
        customer: inv.customer,
        order: inv.order ?? { orderNumber: inv.invoiceNumber },
        payments: inv.payments,
      };
    });

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true } },
        order: { select: { id: true, orderNumber: true, status: true } },
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!inv) throw new NotFoundException("Transaction not found");
    // F03/R1: the ledger's paid total counts CONFIRMED (PAID) money only — a
    // DRAFT payment isn't collected, nor is a VOID (bounced) one (P5-12). The
    // rows themselves are still returned unfiltered so the UI can badge them.
    // B421: totalPaid is cash-only — a CREDIT_NOTE or ADVANCE application
    // must not render as cash the tenant collected on this transaction.
    const { cash: paid, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
    let ledgerStatus: TxnStatus;
    if (inv.status === InvoiceStatus.PAID) ledgerStatus = TxnStatus.PAID;
    else if (inv.status === InvoiceStatus.PARTIAL) ledgerStatus = TxnStatus.PARTIAL;
    else ledgerStatus = TxnStatus.UNPAID;
    return {
      id: inv.id,
      status: ledgerStatus,
      customerId: inv.customerId,
      createdAt: inv.issueDate,
      totalOwed: Number(inv.total),
      totalPaid: paid,
      creditApplied,
      advanceApplied,
      customer: inv.customer,
      order: inv.order ?? { orderNumber: inv.invoiceNumber },
      payments: inv.payments,
      items: [],
    };
  }

  async recordPayment(id: string, dto: RecordPaymentDto) {
    return this.prisma.tenantTransaction(async (tx) => {
      // SA-404f F1: FIRST lock (Order →) Invoice, so the status read below sees a committed VOID
      // and refuses, instead of writing PAID/PARTIAL back over it.
      await lockInvoicesForPayment(tx, [id]);
      const inv = await tx.invoice.findUnique({
        where: { id },
        // F03/R1: this sum ADVANCES invoice state (the status write below is
        // derived from it), so it counts CONFIRMED (PAID) money only — a DRAFT
        // payment would mark the invoice PAID off money nobody has, and a VOID
        // (bounced) one would wrongly reject a legitimate re-payment (P5-12).
        include: { payments: { where: CONFIRMED_PAYMENT } },
      });
      if (!inv) throw new NotFoundException("Transaction not found");
      // B312: this ledger writer had no status guard at all — unlike invoices.service's
      // recordPayment (which refuses VOID), a WRITTEN_OFF invoice's `remaining` balance is
      // still > 0 (write-off doesn't touch `total`), so this path would happily flip it back
      // to PARTIAL/PAID — resurrecting a forgiven invoice as if it were still collectible.
      if (inv.status === InvoiceStatus.VOID || inv.status === InvoiceStatus.WRITTEN_OFF) {
        throw new BadRequestException(
          `Cannot record a payment on a ${inv.status === InvoiceStatus.VOID ? "voided" : "written-off"} invoice.`,
        );
      }

      // B812: round every monetary write — summing already-rounded payments can
      // still land off-cent in float (0.70 + 0.10 === 0.7999999999999999), which
      // left a fully-paid invoice stuck at PARTIAL and refused every further
      // payment as an overpayment (matches payBillFully's own pattern below).
      const alreadyPaid = roundMoney(inv.payments.reduce((sum, p) => sum + Number(p.amount), 0));
      const totalOwed = Number(inv.total);
      const remaining = roundMoney(totalOwed - alreadyPaid);
      if (remaining <= 0) {
        throw new BadRequestException("Transaction is already fully paid");
      }
      // B801/SA-121: round every monetary write — a sub-cent dto.amount (e.g.
      // 10.005) would otherwise land off-cent in the stored payment.
      const paymentAmount = roundMoney(dto.amount);
      if (paymentAmount > remaining + 0.001) {
        throw new BadRequestException(
          `Payment of ${paymentAmount} exceeds remaining balance of ${remaining.toFixed(2)}`,
        );
      }

      await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount: paymentAmount,
          method: dto.method as any,
          reference: dto.reference,
          notes: dto.notes,
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          checkStatus: dto.method === "CHECK" ? CheckStatus.RECORDED : null,
        },
      });

      const totalPaid = roundMoney(alreadyPaid + paymentAmount);
      const newInvStatus =
        totalPaid >= totalOwed
          ? InvoiceStatus.PAID
          : totalPaid > 0
            ? InvoiceStatus.PARTIAL
            : InvoiceStatus.SENT;

      const updated = await tx.invoice.update({
        where: { id },
        data: {
          status: newInvStatus,
          ...(newInvStatus === InvoiceStatus.PAID ? { paidAt: new Date() } : {}),
        },
        include: {
          customer: { select: { id: true, businessName: true } },
          payments: { orderBy: { createdAt: "desc" } },
          order: { select: { id: true, orderNumber: true, status: true } },
        },
      });

      // Commission hook: this ledger path creates a PAID payment directly —
      // the accrual's payable must move with the cash in the same tx.
      await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);

      let ledgerStatus: TxnStatus;
      if (updated.status === InvoiceStatus.PAID) ledgerStatus = TxnStatus.PAID;
      else if (updated.status === InvoiceStatus.PARTIAL) ledgerStatus = TxnStatus.PARTIAL;
      else ledgerStatus = TxnStatus.UNPAID;

      // F03/R1: same CONFIRMED basis as findAll/findOne above. B421: cash-only
      // totalPaid, same as findAll/findOne above.
      const {
        cash: paid2,
        creditApplied: creditApplied2,
        advanceApplied: advanceApplied2,
      } = splitConfirmed(updated.payments);
      return {
        id: updated.id,
        status: ledgerStatus,
        customerId: updated.customerId,
        createdAt: updated.issueDate,
        totalOwed: Number(updated.total),
        totalPaid: paid2,
        creditApplied: creditApplied2,
        advanceApplied: advanceApplied2,
        customer: updated.customer,
        order: updated.order ?? { orderNumber: updated.invoiceNumber },
        payments: updated.payments,
      };
    });
  }

  async getPdfUrl(id: string): Promise<{ url: string } | null> {
    const url = await this.invoiceService.getPresignedUrl(id);
    if (!url) return null;
    return { url };
  }

  // ── Expense Categories ──
  async listExpenseCategories() {
    // Include both tenant-specific AND system-wide default categories (tenantId = null).
    // Exclude INVENTORY_PURCHASE — those expenses are handled in the Vendor Bills /
    // Inventory Purchases tab and should never appear in the Other Expenses filter.
    const tenantId = this.prisma.getTenantId();

    // Defensive lazy seed: if this tenant has no system (non-custom) categories,
    // bring in the IRS Schedule C list. Cheap and idempotent.
    if (tenantId) {
      const systemCount = await this.prisma.expenseCategory.count({
        where: { tenantId, isCustom: false },
      });
      if (systemCount === 0) {
        await this.ensureSystemCategories(tenantId);
      }
    }

    const rows = await this.prisma.expenseCategory.findMany({
      where: {
        OR: [{ tenantId }, { tenantId: null }],
        NOT: { code: "INVENTORY_PURCHASE" },
      },
      orderBy: [
        // tenant-specific rows first so they win deduplication
        { tenantId: "desc" },
        { name: "asc" },
      ],
    });

    // Deduplicate by code, keeping the tenant-specific row over any global null-tenant copy
    const seen = new Set<string>();
    return rows.filter((c) => {
      const key = c.code ?? c.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async createExpenseCategory(dto: { name: string; code: string }) {
    return this.prisma.forTenant().expenseCategory.create({
      data: { name: dto.name, code: dto.code, isCustom: true },
    });
  }

  /**
   * Idempotent per-tenant seed of the IRS Schedule C category list.
   * Safe to call multiple times: only inserts codes that don't already
   * exist for this tenant.
   */
  async ensureSystemCategories(tenantId?: string): Promise<{ inserted: number }> {
    const tid = tenantId ?? this.prisma.getTenantId();
    if (!tid) return { inserted: 0 };
    const existing = await this.prisma.expenseCategory.findMany({
      where: { tenantId: tid },
      select: { code: true },
    });
    const have = new Set(existing.map((c) => c.code));
    const toInsert = IRS_SYSTEM_CATEGORIES.filter((c) => !have.has(c.code));
    if (toInsert.length === 0) return { inserted: 0 };
    await this.prisma.expenseCategory.createMany({
      data: toInsert.map((c) => ({
        name: c.name,
        code: c.code,
        isCustom: false,
        tenantId: tid,
      })),
      skipDuplicates: true,
    });
    return { inserted: toInsert.length };
  }

  // ── Mileage Rates ──
  async listMileageRates() {
    return this.prisma.forTenant().mileageRate.findMany({ orderBy: { startDate: "desc" } });
  }

  async createMileageRate(dto: { startDate: string; ratePerUnit: number; unit?: string }) {
    return this.prisma.forTenant().mileageRate.create({
      data: {
        startDate: new Date(dto.startDate),
        ratePerUnit: dto.ratePerUnit,
        unit: dto.unit ?? "MILE",
      },
    });
  }

  async deleteMileageRate(id: string) {
    const rate = await this.prisma.forTenant().mileageRate.findUnique({ where: { id } });
    if (!rate) throw new NotFoundException("Mileage rate not found");
    return this.prisma.forTenant().mileageRate.delete({ where: { id } });
  }

  /** Find the applicable mileage rate for a given date: the most recent rate with startDate <= expenseDate */
  async getApplicableMileageRate(expenseDate: Date, unit = "MILE") {
    return this.prisma.forTenant().mileageRate.findFirst({
      where: { unit, startDate: { lte: expenseDate } },
      orderBy: { startDate: "desc" },
    });
  }

  // ── Expenses ──
  private get expenseInclude() {
    return {
      category: true,
      supplier: { select: { id: true, name: true } },
      customer: { select: { id: true, businessName: true } },
      lineItems: { orderBy: { createdAt: "asc" as const } },
    };
  }

  async listExpenses(query: {
    categoryId?: string;
    supplierId?: string;
    customerId?: string;
    from?: string;
    to?: string;
    type?: string;
    page?: number;
    limit?: number;
  }) {
    const { categoryId, supplierId, customerId, from, to, type, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = { deletedAt: null };
    if (categoryId) {
      where.categoryId = categoryId;
    } else {
      // Exclude inventory-purchase expenses from the general list — they belong in vendor bills
      const invCat = await this.prisma
        .forTenant()
        .expenseCategory.findFirst({ where: { code: "INVENTORY_PURCHASE" } });
      if (invCat) where.category = { code: { not: "INVENTORY_PURCHASE" } };
    }
    if (supplierId) where.supplierId = supplierId;
    if (customerId) where.customerId = customerId;
    if (type === "mileage") where.isMileage = true;
    if (type === "itemized") where.isItemized = true;
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
      this.prisma.forTenant().expense.findMany({
        where,
        include: this.expenseInclude,
        skip,
        take: limit,
        orderBy: { date: "desc" },
      }),
      this.prisma.forTenant().expense.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createExpense(dto: any, userId: string) {
    const { lineItems, isMileage, isItemized, ...rest } = dto;

    // For mileage expenses, auto-lookup the applicable rate if not provided
    let computedAmount = rest.amount;
    let rateSnapshot = rest.mileageRateSnapshot;
    if (isMileage && rest.distance && !rateSnapshot) {
      const date = new Date(rest.date);
      const rate = await this.getApplicableMileageRate(date, rest.mileageUnit ?? "MILE");
      if (rate) {
        rateSnapshot = Number(rate.ratePerUnit);
        // B781: round every monetary write — distance x a sub-cent rate (e.g. $0.335/mi)
        // lands off-cent in float (3 x 0.335 === 1.0050000000000001).
        computedAmount = roundMoney(Number(rest.distance) * rateSnapshot);
      }
    }

    // For itemized expenses, amount = sum of the ROUNDED line items — each line
    // is rounded below at write time too, so the header total always equals
    // the sum of the stored lines (never a mismatch from summing raw floats).
    const roundedLineItems = isItemized
      ? lineItems?.map((li: any) => ({ ...li, amount: roundMoney(Number(li.amount)) }))
      : undefined;
    if (isItemized && roundedLineItems?.length) {
      computedAmount = roundedLineItems.reduce((s: number, li: any) => s + li.amount, 0);
    }

    // B781: round every monetary write, on every path — including a plain
    // passthrough `rest.amount` and a mileage expense whose rate the CLIENT
    // already snapshotted (the web form always sends mileageRateSnapshot, so
    // the auto-lookup branch above never rounds it there; distance x a
    // sub-cent rate still lands off-cent in float either way).
    computedAmount = roundMoney(Number(computedAmount));

    const expense = await this.prisma.forTenant().expense.create({
      data: {
        categoryId: rest.categoryId ?? null,
        supplierId: rest.supplierId ?? null,
        customerId: rest.customerId ?? null,
        amount: computedAmount,
        date: new Date(rest.date),
        description: rest.description,
        paymentMethod: rest.paymentMethod,
        notes: rest.notes,
        referenceNumber: rest.referenceNumber,
        performedById: userId,
        isItemized: isItemized ?? false,
        isMileage: isMileage ?? false,
        isBillable: rest.isBillable ?? false,
        employeeName: rest.employeeName,
        mileageUnit: rest.mileageUnit,
        distance: rest.distance ?? null,
        mileageRateSnapshot: rateSnapshot ?? null,
        ...(isItemized && roundedLineItems?.length
          ? {
              lineItems: {
                create: roundedLineItems.map((li: any) => ({
                  account: li.account,
                  notes: li.notes,
                  amount: li.amount,
                  tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
                })),
              },
            }
          : {}),
      },
      include: this.expenseInclude,
    });
    await this.maybeConvertToVendorBill(expense);
    return expense;
  }

  async bulkCreateExpenses(dtos: any[], userId: string) {
    const results = await Promise.allSettled(dtos.map((dto) => this.createExpense(dto, userId)));
    const created = results.filter((r) => r.status === "fulfilled").length;
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason?.message ?? "Unknown error");
    return { created, errors };
  }

  async updateExpense(id: string, dto: any) {
    const existing = await this.prisma.forTenant().expense.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, receivedAt: true, paidAt: true, vendorBillId: true },
    });
    if (!existing) throw new NotFoundException("Expense not found");

    const statusPatch = this.buildStatusPatch(existing, dto);

    const updated = await this.prisma.forTenant().expense.update({
      where: { id },
      data: {
        // SA-121/B801: round every monetary write.
        ...(dto.amount !== undefined && { amount: roundMoney(dto.amount) }),
        ...(dto.date && { date: new Date(dto.date) }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.referenceNumber !== undefined && { referenceNumber: dto.referenceNumber }),
        ...(dto.isBillable !== undefined && { isBillable: dto.isBillable }),
        ...(dto.employeeName !== undefined && { employeeName: dto.employeeName }),
        ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
        ...statusPatch,
      },
      include: this.expenseInclude,
    });
    await this.maybeConvertToVendorBill(updated);
    return updated;
  }

  /**
   * Derive the {status, receivedAt, paidAt} patch from an update DTO.
   * Auto-stamps timestamps on first transition into RECEIVED or PAID.
   */
  private buildStatusPatch(
    existing: { status: string; receivedAt: Date | null; paidAt: Date | null },
    dto: { status?: string; receivedAt?: string | Date | null; paidAt?: string | Date | null },
  ): { status?: string; receivedAt?: Date | null; paidAt?: Date | null } {
    const patch: { status?: string; receivedAt?: Date | null; paidAt?: Date | null } = {};
    if (dto.status && dto.status !== existing.status) {
      patch.status = dto.status;
      if (dto.status === "RECEIVED" && !existing.receivedAt) patch.receivedAt = new Date();
      if (dto.status === "PAID") {
        if (!existing.receivedAt) patch.receivedAt = new Date();
        if (!existing.paidAt) patch.paidAt = new Date();
      }
    }
    if (dto.receivedAt !== undefined) {
      patch.receivedAt = dto.receivedAt ? new Date(dto.receivedAt as string) : null;
    }
    if (dto.paidAt !== undefined) {
      patch.paidAt = dto.paidAt ? new Date(dto.paidAt as string) : null;
    }
    return patch;
  }

  /** Bulk status transition — used by the expenses-page selection action bar. */
  async batchUpdateExpenseStatus(
    ids: string[],
    status: "PENDING" | "RECEIVED" | "PAID" | "VOID",
  ): Promise<{ updated: number; failed: { id: string; reason: string }[] }> {
    const failed: { id: string; reason: string }[] = [];
    let updated = 0;
    for (const id of ids) {
      try {
        await this.updateExpense(id, { status });
        updated++;
      } catch (e: any) {
        failed.push({ id, reason: e?.message ?? "unknown" });
      }
    }
    return { updated, failed };
  }

  /**
   * Bulk "mark paid" — each eligible id gets one full-remaining `BillPayment`
   * through the SAME ledger every other payment writes (no special status
   * jump straight to PAID). Follows the vendor-bills `bulkDelete`
   * partition-and-report convention: eligibility is precomputed, an
   * ineligible id is reported in `skipped`, never thrown.
   *
   * `ids` may be VendorBill ids (the vendor-bills list) or Expense ids (the
   * expenses list). Landmine 2: `Expense.vendorBillId` is a bare unique
   * column with no Prisma relation, so a bill-linked expense needs a manual
   * second lookup — marking it paid pays off the underlying BILL (the money
   * side) via the same ledger, while `updateExpense`/`buildStatusPatch` still
   * stamps the expense's own status/receivedAt/paidAt exactly as before. An
   * unlinked expense has no bill ledger to pay against, so it just flips
   * status — unchanged from what `batchUpdateExpenseStatus` already does.
   */
  async bulkMarkPaid(dto: BulkMarkPaidDto): Promise<{
    paid: number;
    totalAmount: number;
    skipped: { id: string; billNumber: string; reason: string }[];
  }> {
    const ids = Array.from(new Set(dto.ids));
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    const skipped: { id: string; billNumber: string; reason: string }[] = [];
    let paid = 0;
    let totalAmount = 0;

    if (ids.length === 0) return { paid, totalAmount, skipped };

    // Identity only — the money side (status/owed/paid) is re-read inside
    // payBillFully's transaction, never carried over from this snapshot.
    const bills = await this.prisma.forTenant().vendorBill.findMany({
      where: { id: { in: ids } },
      select: { id: true, billNumber: true },
    });
    const billsById = new Map(bills.map((b) => [b.id, b]));

    // Whatever didn't resolve to a bill might be an expense (landmine 2).
    const expenseIds = ids.filter((id) => !billsById.has(id));
    const expenses = expenseIds.length
      ? await this.prisma.forTenant().expense.findMany({
          where: { id: { in: expenseIds }, deletedAt: null },
          select: { id: true, status: true, vendorBillId: true },
        })
      : [];
    const expensesById = new Map(expenses.map((e) => [e.id, e]));

    for (const id of ids) {
      try {
        const bill = billsById.get(id);
        if (bill) {
          const result = await this.payBillFully(bill.id, dto, paidAt);
          if (result.ok) {
            paid++;
            totalAmount = roundMoney(totalAmount + result.amount);
          } else {
            skipped.push({ id: bill.id, billNumber: bill.billNumber, reason: result.reason });
          }
          continue;
        }

        const expense = expensesById.get(id);
        if (!expense) {
          skipped.push({ id, billNumber: "", reason: "Not found" });
          continue;
        }

        if (expense.vendorBillId) {
          const linkedBill = await this.prisma.forTenant().vendorBill.findFirst({
            where: { id: expense.vendorBillId },
            select: { id: true, billNumber: true },
          });
          if (!linkedBill) {
            skipped.push({ id, billNumber: "", reason: "Linked bill not found" });
            continue;
          }
          const result = await this.payBillFully(linkedBill.id, dto, paidAt);
          if (!result.ok) {
            skipped.push({ id, billNumber: linkedBill.billNumber, reason: result.reason });
            continue;
          }
          // Bill is paid through the ledger; keep the expense's own status
          // truthful too — buildStatusPatch's auto-stamping is untouched.
          await this.updateExpense(expense.id, { status: "PAID" });
          paid++;
          totalAmount = roundMoney(totalAmount + result.amount);
          continue;
        }

        // Unlinked expense — no bill ledger to pay against. Unchanged from
        // batchUpdateExpenseStatus: flip status, no BillPayment row.
        await this.updateExpense(expense.id, { status: "PAID" });
        paid++;
      } catch (e: any) {
        skipped.push({ id, billNumber: "", reason: e?.message ?? "Unknown error" });
      }
    }

    return { paid, totalAmount, skipped };
  }

  /**
   * Full-remaining payment for one bill — the exact math `recordPayment`
   * uses (`newPaid >= totalOwed - 0.001 ? PAID : PARTIAL`), so a bulk
   * mark-paid bill reaches the same state a manual full payment would.
   * Landmine 1: eligibility is `totalOwed − totalPaid > 0.001`, arithmetic
   * only — VendorBillStatus.PARTIAL is overloaded (short-received OR
   * part-paid) so it is never trusted here, only used to exclude VOID.
   *
   * The bill is re-read INSIDE the transaction and what it already owes is
   * totalled off the BillPayment ledger (exactly as `recordPayment` does),
   * never off the caller's pre-loop snapshot: one request can reach the same
   * bill twice — a bill id AND the expense linked to it — and a stale
   * `totalPaid` would write a second full payment against a bill this very
   * loop just settled, leaving the ledger double what the column says.
   */
  private async payBillFully(
    billId: string,
    dto: BulkMarkPaidDto,
    paidAt: Date,
  ): Promise<{ ok: true; amount: number } | { ok: false; reason: string }> {
    return this.prisma.tenantTransaction(async (tx) => {
      // B285: lock the bill before reading its payments (a concurrent payment/void otherwise
      // leaves this write planning from a stale balance).
      await lockBillRows(tx, this.prisma.getTenantId(), [billId]);
      const bill = await tx.vendorBill.findUnique({
        where: { id: billId },
        include: { payments: true },
      });
      if (!bill) return { ok: false as const, reason: "Bill not found" };
      if (bill.status === "VOID") return { ok: false as const, reason: "Bill is void" };

      const alreadyPaid = roundMoney(
        (bill.payments ?? []).reduce((s: number, p: any) => s + Number(p.amount), 0),
      );
      const remaining = roundMoney(Number(bill.totalOwed) - alreadyPaid);
      if (remaining <= 0.001) return { ok: false as const, reason: "No outstanding balance" };

      await tx.billPayment.create({
        data: {
          vendorBillId: bill.id,
          amount: remaining,
          method: dto.method,
          reference: dto.reference,
          paidAt,
        },
      });
      const newPaid = roundMoney(alreadyPaid + remaining);
      const newStatus = newPaid >= Number(bill.totalOwed) - 0.001 ? "PAID" : "PARTIAL";
      await tx.vendorBill.update({
        where: { id: bill.id },
        data: { totalPaid: newPaid, status: newStatus as any },
      });

      return { ok: true as const, amount: remaining };
    });
  }

  async deleteExpense(id: string) {
    return this.prisma
      .forTenant()
      .expense.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ── Expense Receipt Management ─────────────────────────────────────────────

  async getExpense(id: string) {
    return this.findExpenseOrThrow(id);
  }

  private async findExpenseOrThrow(id: string) {
    const expense = await this.prisma.forTenant().expense.findFirst({
      where: { id, deletedAt: null },
      include: this.expenseInclude,
    });
    if (!expense) throw new NotFoundException("Expense not found");
    return expense;
  }

  async uploadExpenseReceipt(
    id: string,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<{ url: string }> {
    await this.findExpenseOrThrow(id);

    const compressed = await compressDocument(buffer, mimeType);
    const key = `expenses/${id}/receipt.${compressed.ext}`;
    await this.storage.upload(key, compressed.buffer, compressed.mimeType);

    await this.prisma.forTenant().expense.update({
      where: { id },
      data: {
        receiptKey: key,
        receiptOriginalName: originalName,
        receiptMimeType: compressed.mimeType,
      },
    });

    const url = await this.storage.presignedUrl(key);
    return { url };
  }

  async getExpenseReceiptUrl(id: string): Promise<{ url: string }> {
    const expense = await this.findExpenseOrThrow(id);
    if (!expense.receiptKey) throw new NotFoundException("No receipt uploaded for this expense");
    const url = await this.storage.presignedUrl(expense.receiptKey);
    return { url };
  }

  async deleteExpenseReceipt(id: string): Promise<{ success: boolean }> {
    const expense = await this.findExpenseOrThrow(id);
    if (!expense.receiptKey) throw new NotFoundException("No receipt to delete");
    await this.storage.delete(expense.receiptKey);
    await this.prisma.forTenant().expense.update({
      where: { id },
      data: { receiptKey: null, receiptOriginalName: null, receiptMimeType: null },
    });
    return { success: true };
  }

  async extractExpenseItems(id: string) {
    const expense = await this.findExpenseOrThrow(id);
    if (!expense.receiptKey)
      throw new BadRequestException("Upload a receipt first before extracting items");

    // Fetch receipt from storage
    const receiptBuffer = await this.storage.download(expense.receiptKey);
    const mimeType = (expense as any).receiptMimeType ?? "image/jpeg";

    // Key priority: tenant key (SystemConfig) → platform key → env var.
    const tenantKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey = await this.platformConfig.resolveAnthropicKey(tenantKey);
    if (!apiKey) throw new BadRequestException("Anthropic API key not configured");

    const anthropic = new Anthropic({ apiKey });
    const base64 = receiptBuffer.toString("base64");
    const isPdf = mimeType === "application/pdf";

    const fileBlock = isPdf
      ? ({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        } as any)
      : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };

    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: RECEIPT_MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              fileBlock,
              {
                type: "text",
                text: `Extract all line items from this receipt/invoice. Return valid JSON only:\n{"vendor":"...","date":"YYYY-MM-DD or null","total":0.00,"items":[{"description":"...","qty":1,"unitCost":0.00,"amount":0.00}]}`,
              },
            ],
          },
        ],
      });
    } catch (err) {
      await this.platformConfig.recordAiUsage({
        tenantId: this.prisma.getTenantId(),
        feature: "ocr.expense_receipt",
        model: RECEIPT_MODEL,
        success: false,
      });
      throw err;
    }

    // The call succeeded, so the spend is real — record it even if parsing
    // the response fails below.
    await this.platformConfig.recordAiUsage({
      tenantId: this.prisma.getTenantId(),
      feature: "ocr.expense_receipt",
      model: RECEIPT_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    let parsed: any = {};
    try {
      const text = (response.content[0] as any).text ?? "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      throw new BadRequestException("Could not parse receipt — please check the image quality");
    }

    const items: any[] = parsed.items ?? [];
    // B801: round every monetary write — an OCR-extracted amount (or a
    // distance/rate-style value) can land off-cent in float, exactly like
    // B781's mileage/itemized case. Round each line here, once, and reuse the
    // SAME rounded value for both the stored line and the header total below,
    // so the header always equals the sum of the stored lines.
    const roundedAmounts = items.map((item: any) =>
      roundMoney(Number(item.amount ?? item.unitCost ?? 0)),
    );

    // Replace existing line items with extracted ones
    await this.prisma.forTenant().expenseLineItem.deleteMany({ where: { expenseId: id } });
    if (items.length > 0) {
      await this.prisma.forTenant().expenseLineItem.createMany({
        data: items.map((item: any, idx: number) => ({
          expenseId: id,
          account: item.description ?? "Item",
          notes: null,
          amount: roundedAmounts[idx],
          unitCost: item.unitCost != null ? Number(item.unitCost) : null,
          qty: item.qty != null ? Number(item.qty) : null,
        })),
      });
    }

    const totalFromItems = roundMoney(roundedAmounts.reduce((s: number, a: number) => s + a, 0));

    const updated = await this.prisma.forTenant().expense.update({
      where: { id },
      data: {
        isItemized: items.length > 0,
        ...(totalFromItems > 0 && { amount: totalFromItems }),
        ...(parsed.vendor && !(expense as any).description ? { description: parsed.vendor } : {}),
      },
      include: this.expenseInclude,
    });

    return updated;
  }

  // ── Inventory Purchase Auto-Routing ────────────────────────────────────────

  private async maybeConvertToVendorBill(expense: any): Promise<void> {
    if (!expense.categoryId) return;
    const category = await this.prisma
      .forTenant()
      .expenseCategory.findUnique({ where: { id: expense.categoryId } });
    if (!category || category.code !== "INVENTORY_PURCHASE") return;
    if (expense.vendorBillId) return; // already converted

    const lineItems = await this.prisma
      .forTenant()
      .expenseLineItem.findMany({ where: { expenseId: expense.id } });

    const bill = await this.vendorBillsService.create({
      requireSupplier: false,
      supplierId: expense.supplierId ?? undefined,
      totalOwed: Number(expense.amount),
      billDate: expense.date?.toISOString(),
      notes: expense.description ?? undefined,
      items: lineItems.map((li) => ({
        description: li.account,
        qty: li.qty != null ? Number(li.qty) : 1,
        unitCost: li.unitCost != null ? Number(li.unitCost) : Number(li.amount),
        productId: (li as any).productId ?? undefined,
      })),
    });

    await this.prisma.forTenant().expense.update({
      where: { id: expense.id },
      data: { vendorBillId: bill.id },
    });
  }

  async ensureInventoryPurchaseCategory(): Promise<void> {
    const existing = await this.prisma
      .forTenant()
      .expenseCategory.findFirst({ where: { code: "INVENTORY_PURCHASE" } });
    if (!existing) {
      await this.prisma.forTenant().expenseCategory.create({
        data: { name: "Inventory Purchase", code: "INVENTORY_PURCHASE", isCustom: false },
      });
    }
  }

  /** Convert any pre-existing INVENTORY_PURCHASE expenses that were never turned into vendor bills. */
  async backfillInventoryPurchaseExpenses(): Promise<void> {
    const category = await this.prisma
      .forTenant()
      .expenseCategory.findFirst({ where: { code: "INVENTORY_PURCHASE" } });
    if (!category) return;
    const unconverted = await this.prisma.forTenant().expense.findMany({
      where: { categoryId: category.id, vendorBillId: null, deletedAt: null },
    });
    for (const expense of unconverted) {
      await this.maybeConvertToVendorBill(expense).catch(() => {});
    }
  }

  // ── P&L Report ──
  /**
   * B440: revenue is accrual net sales (issued, non-void/draft, net of
   * credit notes and external refunds — see `fetchAccrualNetSales`), never
   * cash. COGS is estimated from the SAME accrual invoice set as revenue
   * (ACCRUAL_REVENUE_STATUSES, windowed on issueDate — one collection with
   * revenue, L-119) so both sides of gross profit share a basis. Each line
   * is costed at qty × the product's point-in-time average cost at the
   * invoice's issueDate (invoice lines carry no cost of their own;
   * `StockMovement type:"SALE"` rows are a stock-ledger record, not a COGS source — see common/invoiced-sales.ts).
   * COGS stays gross of restocked returns (FU-2, deliberate — not fixed
   * here). No tobacco exclusion here: accounting records always reflect real
   * financials. B456: `netProfit` also subtracts `badDebtExpense` — the
   * unpaid balance of any invoice WRITTEN_OFF in this window — a cost
   * `revenue` (WRITTEN_OFF *is* revenue at issue) makes necessary the
   * instant it's counted.
   */
  async getProfitAndLoss(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const window = { gte: fromDate, lte: toDate };
    const tenantId = this.requireTenantId();

    const [netSales, cogsLines, expenses, badDebtExpense] = await Promise.all([
      fetchAccrualNetSales(this.prisma.forTenant(), tenantId, window),
      fetchInvoicedSaleLines(this.prisma.forTenant(), {
        from: fromDate,
        to: toDate,
        dateBasis: "issueDate",
        status: ACCRUAL_REVENUE_STATUSES,
      }),
      this.prisma.forTenant().expense.findMany({
        where: { deletedAt: null, date: { gte: fromDate, lte: toDate } },
        include: { category: true },
      }),
      fetchBadDebtExpense(this.prisma.forTenant(), tenantId, window),
    ]);

    const revenue = netSales.net;
    const productIds = soldProductIds(cogsLines);
    const [costIndex, costFacts] = await Promise.all([
      fetchCostIndex(this.prisma.forTenant(), productIds, toDate),
      fetchProductCostFacts(this.prisma.forTenant(), productIds),
    ]);
    const cogs = roundMoney(estimateCogs(cogsLines, costIndex, costFacts));
    const grossProfit = roundMoney(revenue - cogs);
    const opEx = roundMoney(expenses.reduce((s, e) => s + Number(e.amount), 0));
    const netProfit = roundMoney(grossProfit - opEx - badDebtExpense);

    const byCategory = expenses.reduce((acc: any, e) => {
      const cat = e.category?.name ?? "Uncategorized";
      acc[cat] = (acc[cat] ?? 0) + Number(e.amount);
      return acc;
    }, {});

    return {
      revenue,
      grossRevenue: netSales.gross,
      creditNotes: netSales.creditNotes,
      externalRefunds: netSales.externalRefunds,
      cogs,
      grossProfit,
      operatingExpenses: opEx,
      badDebtExpense,
      netProfit,
      netMarginPct: revenue > 0 ? (netProfit / revenue) * 100 : 0,
      expensesByCategory: byCategory,
      period: { from: fromDate, to: toDate },
    };
  }

  // ── AR Aging Report ──
  /** @deprecated Use getArAgingInvoices() instead — this now delegates to it */
  async getArAging() {
    return this.getArAgingInvoices();
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

    const CfPayStatus = PaymentStatus;
    const [payments, expenses, bills] = await Promise.all([
      this.prisma.forTenant().invoicePayment.findMany({
        // B421: cash-flow's "totalIn" is money genuinely received — a
        // CREDIT_NOTE application is never cash, but an ADVANCE application
        // is (bookkeeping never reads AdvancePayment directly, so this row
        // is the only place that already-real cash is ever recorded; see
        // RECEIVED_METHOD_FILTER's own doc). Excludes ONLY CREDIT_NOTE.
        where: {
          status: CfPayStatus.PAID,
          method: RECEIVED_METHOD_FILTER,
          ...settledDateFilter({ gte: fromDate, lte: toDate }),
        },
        orderBy: { paidAt: "asc" },
      }),
      this.prisma.forTenant().expense.findMany({
        where: { deletedAt: null, date: { gte: fromDate, lte: toDate } },
        orderBy: { date: "asc" },
      }),
      this.prisma.forTenant().billPayment.findMany({
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
    const tz = await tenantTimeZone(this.prisma); // SA-488: the tenant's due day
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);

    const [netSales, outstandingInvoices, paymentsThisWeekResult, overdueCount] = await Promise.all(
      [
        // B440: totalRevenue is accrual net sales (this month to date), never
        // a cash/paidAt-windowed aggregate.
        fetchAccrualNetSales(this.prisma.forTenant(), this.requireTenantId(), {
          gte: startOfMonth,
          lte: now,
        }),
        this.prisma.forTenant().invoice.findMany({
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
          select: {
            total: true,
            // F03/R1: only a CONFIRMED payment reduces what's outstanding. This
            // must agree with getMobileDashboard/getFinanceDashboard — the same
            // tenant reads /bookkeeping/summary and /bookkeeping/dashboard side
            // by side and they must not disagree.
            payments: { where: CONFIRMED_PAYMENT, select: { amount: true, status: true } },
          },
        }),
        // F03/R1/T-B11s: weekly receipts are CONFIRMED (PAID) money only —
        // getCashFlow's basis, not the historical "everything but VOID" one.
        // B421: same RECEIVED_METHOD_FILTER as getCashFlow.totalIn — a
        // CREDIT_NOTE application is not a "receipt", an ADVANCE application is.
        // check-payments PR-2b (M2): collected basis is settledAt ?? paidAt,
        // same as getCashFlow — never the raw recorded (createdAt) date.
        this.prisma.forTenant().invoicePayment.aggregate({
          where: {
            ...CONFIRMED_PAYMENT,
            method: RECEIVED_METHOD_FILTER,
            ...settledDateFilter({ gte: sevenDaysAgo, lte: now }),
          },
          _sum: { amount: true },
        }),
        // SA-770 (row 294): overdue = past its due day AND a balance is owed (the one SQL predicate),
        // so an overpaid or exactly-paid invoice that is not yet PAID is not counted.
        overdueInvoiceCount(this.prisma, this.requireTenantId(), overdueCutoff(now, tz), {
          statuses: [
            InvoiceStatus.SENT,
            InvoiceStatus.VIEWED,
            InvoiceStatus.PARTIAL,
            InvoiceStatus.OVERDUE,
          ],
        }),
      ],
    );

    // SA-770 row 310: each open invoice adds its CLAMPED balance, so an overpaid one never nets against
    // what other customers owe (and float dust is not a receivable).
    const outstandingReceivables = roundMoney(
      outstandingInvoices.reduce((sum, inv) => sum + confirmedBalance(inv.total, inv.payments), 0),
    );

    return {
      totalRevenue: netSales.net,
      grossRevenue: netSales.gross,
      creditNotes: netSales.creditNotes,
      externalRefunds: netSales.externalRefunds,
      outstandingReceivables,
      paymentsThisWeek: Number(paymentsThisWeekResult._sum.amount ?? 0),
      overdueCount,
    };
  }

  // ── Mobile Analytics Dashboard ──
  /**
   * Returns the six KPI numbers the mobile analytics screen needs.
   * Uses current calendar year as the aggregation window.
   */
  async getMobileDashboard() {
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const window = { gte: startOfYear, lte: now };
    const tenantId = this.requireTenantId();

    const [invoiceAgg, paymentAgg, expenseAgg, outstandingInvoices, netSales, badDebtExpense] =
      await Promise.all([
        // Total invoiced (YTD, non-draft/void)
        this.prisma.forTenant().invoice.aggregate({
          where: {
            issueDate: { gte: startOfYear },
            status: {
              notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF],
            },
          },
          _sum: { total: true },
        }),
        // Total collected (YTD invoice payments) — CONFIRMED (PAID) only (F03/R1/
        // T-B11s): an unconfirmed DRAFT payment is not money in hand any more than
        // a VOID (bounced, P5-12) one is; this must match getCashFlow's basis.
        // B421: same RECEIVED_METHOD_FILTER — a CREDIT_NOTE application was
        // never "collected", an ADVANCE application already was (at deposit time).
        // check-payments PR-2b (M2): collected basis is settledAt ?? paidAt.
        this.prisma.forTenant().invoicePayment.aggregate({
          where: {
            ...CONFIRMED_PAYMENT,
            method: RECEIVED_METHOD_FILTER,
            ...settledDateFilter(window),
          },
          _sum: { amount: true },
        }),
        // Total expenses (YTD)
        this.prisma.forTenant().expense.aggregate({
          where: { deletedAt: null, date: { gte: startOfYear } },
          _sum: { amount: true },
        }),
        // Outstanding receivables (unpaid balances)
        this.prisma.forTenant().invoice.findMany({
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
          select: {
            total: true,
            // F03/R1: only a CONFIRMED payment actually reduces what's outstanding —
            // a DRAFT one hasn't been collected yet, so the balance still stands.
            payments: { where: CONFIRMED_PAYMENT, select: { amount: true, status: true } },
          },
        }),
        // B440: revenue = accrual net sales, never totalCollected.
        fetchAccrualNetSales(this.prisma.forTenant(), tenantId, window),
        // B456: an invoice WRITTEN_OFF this year is a P&L expense the instant
        // its total counts as revenue (ACCRUAL_REVENUE_STATUSES includes
        // WRITTEN_OFF).
        fetchBadDebtExpense(this.prisma.forTenant(), tenantId, window),
      ]);

    const totalInvoiced = Number(invoiceAgg._sum.total ?? 0);
    const totalCollected = Number(paymentAgg._sum.amount ?? 0);
    const totalExpenses = Number(expenseAgg._sum.amount ?? 0);
    const totalOutstanding = roundMoney(
      outstandingInvoices.reduce((sum, inv) => sum + confirmedBalance(inv.total, inv.payments), 0),
    );

    return {
      revenue: netSales.net,
      expenses: totalExpenses,
      netIncome: roundMoney(netSales.net - totalExpenses - badDebtExpense),
      totalInvoiced,
      totalCollected,
      totalOutstanding,
    };
  }

  // ── Finance Dashboard ──
  async getFinanceDashboard() {
    const now = new Date();
    const tz = await tenantTimeZone(this.prisma); // SA-488: the tenant's due day
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const tenantId = this.requireTenantId();

    const unpaidInvoices = await this.prisma.forTenant().invoice.findMany({
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
      // F03/R1: AR-aging balances net out only CONFIRMED (PAID) payments — a
      // DRAFT one (unconfirmed) hasn't reduced what's owed, same as excluding
      // VOID (bounced) ones (P5-12).
      include: { payments: { where: CONFIRMED_PAYMENT } },
    });

    let arCurrent = 0,
      ar1_15 = 0,
      ar16_30 = 0,
      ar31_45 = 0,
      ar45plus = 0;
    for (const inv of unpaidInvoices) {
      const bal = confirmedBalance(inv.total, inv.payments);
      if (bal <= 0) continue;
      if (!inv.dueDate || !isOverdue(inv.dueDate, now, tz)) {
        arCurrent += bal;
        continue;
      }
      const daysPast = Math.floor((now.getTime() - inv.dueDate.getTime()) / 86400000);
      if (daysPast <= 15) ar1_15 += bal;
      else if (daysPast <= 30) ar16_30 += bal;
      else if (daysPast <= 45) ar31_45 += bal;
      else ar45plus += bal;
    }
    // Each contribution is a cents-exact clamped balance; round the running sums so the buckets and the
    // total agree to the cent (no float dust between them).
    arCurrent = roundMoney(arCurrent);
    ar1_15 = roundMoney(ar1_15);
    ar16_30 = roundMoney(ar16_30);
    ar31_45 = roundMoney(ar31_45);
    ar45plus = roundMoney(ar45plus);
    const totalReceivables = roundMoney(arCurrent + ar1_15 + ar16_30 + ar31_45 + ar45plus);

    const monthlyData: Array<{ month: string; sales: number; receipts: number; expenses: number }> =
      [];
    // B440: gross/creditNotes/externalRefunds summed across the 12 buckets,
    // for the top-level breakdown below (mirrors getSummary/getProfitAndLoss's
    // own additive breakdown fields).
    let grossSalesYtd = 0,
      creditNotesYtd = 0,
      externalRefundsYtd = 0;
    for (let m = 0; m < 12; m++) {
      const mStart = new Date(now.getFullYear(), m, 1);
      const rawMEnd = new Date(now.getFullYear(), m + 1, 0, 23, 59, 59, 999);
      // Opus review of check-payments PR-2b: cap the CURRENT (in-progress)
      // month's bucket at `now`, not the month's last instant — otherwise it
      // disagrees with getPeriodSummary's "thisMonth" figure below, which
      // already caps at `now`. A finished month is unaffected (rawMEnd <= now).
      const mEnd = rawMEnd > now ? now : rawMEnd;
      const [netSales, receiptsAgg, expensesAgg] = await Promise.all([
        // B440: sales is accrual net sales, not the inline gross aggregate.
        fetchAccrualNetSales(this.prisma.forTenant(), tenantId, { gte: mStart, lte: mEnd }),
        // F03/R1/T-B11s: receipts are CONFIRMED (PAID) money only — matches
        // getCashFlow's basis, not the historical "everything but VOID" one.
        // B421: same RECEIVED_METHOD_FILTER as getCashFlow.totalIn.
        // check-payments PR-2b (M2): collected basis is settledAt ?? paidAt.
        this.prisma.forTenant().invoicePayment.aggregate({
          where: {
            ...CONFIRMED_PAYMENT,
            method: RECEIVED_METHOD_FILTER,
            ...settledDateFilter({ gte: mStart, lte: mEnd }),
          },
          _sum: { amount: true },
        }),
        this.prisma.forTenant().expense.aggregate({
          where: { deletedAt: null, date: { gte: mStart, lte: mEnd } },
          _sum: { amount: true },
        }),
      ]);
      grossSalesYtd = roundMoney(grossSalesYtd + netSales.gross);
      creditNotesYtd = roundMoney(creditNotesYtd + netSales.creditNotes);
      externalRefundsYtd = roundMoney(externalRefundsYtd + netSales.externalRefunds);
      monthlyData.push({
        month: mStart.toLocaleString("default", { month: "short" }),
        sales: netSales.net,
        receipts: Number(receiptsAgg._sum.amount ?? 0),
        expenses: Number(expensesAgg._sum.amount ?? 0),
      });
    }
    const totalSales = monthlyData.reduce((s, m) => s + m.sales, 0);
    const totalReceipts = monthlyData.reduce((s, m) => s + m.receipts, 0);
    const totalExpenses = monthlyData.reduce((s, m) => s + m.expenses, 0);

    const expenses = await this.prisma.forTenant().expense.findMany({
      where: { deletedAt: null, date: { gte: startOfYear } },
      include: { category: true },
    });
    const byCat: Record<string, number> = {};
    for (const e of expenses) {
      const catName = e.category?.name ?? "Uncategorized";
      byCat[catName] = (byCat[catName] ?? 0) + Number(e.amount);
    }
    const topExpenses = Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, amount]) => ({ name, amount }));

    const getPeriodSummary = async (from: Date) => {
      const [netSales, r] = await Promise.all([
        // B440: sales is accrual net sales, not the inline gross aggregate —
        // same fix as the monthlySales loop above.
        fetchAccrualNetSales(this.prisma.forTenant(), tenantId, { gte: from, lte: now }),
        // F03/R1/T-B11s: same CONFIRMED (PAID) basis as monthlySales.totalReceipts.
        // B421: same RECEIVED_METHOD_FILTER too.
        // check-payments PR-2b (M2): collected basis is settledAt ?? paidAt.
        this.prisma.forTenant().invoicePayment.aggregate({
          where: {
            ...CONFIRMED_PAYMENT,
            method: RECEIVED_METHOD_FILTER,
            ...settledDateFilter({ gte: from, lte: now }),
          },
          _sum: { amount: true },
        }),
      ]);
      const dueInvoices = await this.prisma.forTenant().invoice.findMany({
        where: {
          status: {
            in: [
              InvoiceStatus.SENT,
              InvoiceStatus.VIEWED,
              InvoiceStatus.PARTIAL,
              InvoiceStatus.OVERDUE,
            ],
          },
          issueDate: { gte: from },
        },
        // F03/R1: a DRAFT payment hasn't reduced the due balance yet, same as
        // excluding VOID (bounced) ones (P5-12).
        include: { payments: { where: CONFIRMED_PAYMENT } },
      });
      const due = roundMoney(
        dueInvoices.reduce((sum, inv) => sum + confirmedBalance(inv.total, inv.payments), 0),
      );
      return { sales: netSales.net, receipts: Number(r._sum.amount ?? 0), due };
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
      // B440: additive breakdown of totalSales into its accrual components,
      // mirroring getSummary/getProfitAndLoss's own breakdown fields.
      grossSales: grossSalesYtd,
      creditNotes: creditNotesYtd,
      externalRefunds: externalRefundsYtd,
    };
  }

  async getArAgingInvoices(intervalDays = 30) {
    const now = new Date();
    const tz = await tenantTimeZone(this.prisma); // SA-488: the tenant's due day
    const interval = Math.max(1, intervalDays);
    const invoices = await this.prisma.forTenant().invoice.findMany({
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
        customer: { select: { id: true, businessName: true } },
        // F03/R1: AR-aging balances net out CONFIRMED (PAID) payments only — a
        // DRAFT one hasn't reduced what's owed, same as a VOID (bounced) one
        // (P5-12). Keeps this report agreeing with getFinanceDashboard's AR bucket.
        payments: { where: CONFIRMED_PAYMENT },
      },
    });

    // Dynamic bucket labels based on interval
    const bucketKeys = [
      "current",
      `days1_${interval}`,
      `days${interval + 1}_${interval * 2}`,
      `days${interval * 2 + 1}_${interval * 3}`,
      `days${interval * 3}plus`,
    ];
    const buckets: Record<string, any[]> = {};
    for (const key of bucketKeys) buckets[key] = [];

    // #1529 / SA-517: the deposit's "today" is the tenant's day (the same zone the buckets age in).
    const todayIso = startOfCalendarDay(now, tz).toISOString().slice(0, 10);
    const depositOverdue = { count: 0, outstanding: 0 };

    for (const inv of invoices) {
      const paid = sumConfirmed(inv.payments); // the deposit check's full confirmed total
      const balance = confirmedBalance(inv.total, inv.payments);
      if (balance <= 0) continue;
      // #1529: the deposit rides each row (the invoice list's own read-time math); the buckets
      // below still age by dueDate, so an overdue deposit on a not-yet-due invoice stays CURRENT
      // and is surfaced by these fields and the top-level summary instead.
      const deposit = computeDepositFields(inv, paid, todayIso);
      if (deposit.depositOverdue) {
        depositOverdue.count += 1;
        depositOverdue.outstanding += roundMoney((deposit.depositAmount ?? 0) - paid);
      }
      const entry = {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customer: inv.customer,
        total: Number(inv.total),
        balance,
        dueDate: inv.dueDate,
        status: inv.status,
        depositAmount: deposit.depositAmount,
        depositDueDate: inv.depositDueDate ?? null,
        depositOverdue: deposit.depositOverdue,
      };
      if (!inv.dueDate || !isOverdue(inv.dueDate, now, tz)) {
        buckets[bucketKeys[0]].push(entry);
        continue;
      }
      const daysPast = Math.floor((now.getTime() - inv.dueDate.getTime()) / 86400000);
      if (daysPast <= interval) buckets[bucketKeys[1]].push(entry);
      else if (daysPast <= interval * 2) buckets[bucketKeys[2]].push(entry);
      else if (daysPast <= interval * 3) buckets[bucketKeys[3]].push(entry);
      else buckets[bucketKeys[4]].push(entry);
    }
    // Cents-exact balances summed per bucket, rounded so the buckets and the total agree with the
    // finance dashboard's AR aging to the cent (no float dust).
    const sum = (arr: any[]) => roundMoney(arr.reduce((s, e) => s + e.balance, 0));
    const totals: Record<string, number> = {};
    let grandTotal = 0;
    for (const key of bucketKeys) {
      totals[key] = sum(buckets[key]);
      grandTotal += totals[key];
    }
    totals.total = roundMoney(grandTotal);
    depositOverdue.outstanding = roundMoney(depositOverdue.outstanding);

    // #1529: `depositOverdue` is its own top-level key, never a `totals` key (totals stay the AR
    // buckets, agreeing with the finance dashboard).
    return { buckets, totals, intervalDays: interval, depositOverdue };
  }

  async getSalesByCustomer(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const tenantId = this.requireTenantId();
    // B440: salesAmount is accrual net (gross - creditNotes - externalRefunds)
    // per customer, never clamped at 0 — a CN-only customer (no invoices of
    // its own) legitimately nets negative.
    const [netByCustomer, invoices, customers] = await Promise.all([
      fetchAccrualNetSalesByCustomer(this.prisma.forTenant(), tenantId, {
        gte: fromDate,
        lte: toDate,
      }),
      // B440 Fable review of #791: invoiceCount uses the SAME predicate as
      // salesAmount (ACCRUAL_REVENUE_STATUSES — WRITTEN_OFF counts, only
      // DRAFT/VOID excluded), not the narrower REAL_INVOICE_STATUSES-style
      // filter — otherwise a customer's row could show sales from an invoice
      // its own invoiceCount didn't count.
      this.prisma.forTenant().invoice.findMany({
        where: {
          status: { notIn: [...ACCRUAL_REVENUE_STATUSES.notIn] },
          issueDate: { gte: fromDate, lte: toDate },
        },
        include: { customer: { select: { id: true, businessName: true } } },
      }),
      this.prisma.forTenant().customer.findMany({ select: { id: true, businessName: true } }),
    ]);
    const businessNameById = new Map(customers.map((c) => [c.id, c.businessName]));
    const invoiceCountById = new Map<string, number>();
    for (const inv of invoices) {
      invoiceCountById.set(inv.customerId, (invoiceCountById.get(inv.customerId) ?? 0) + 1);
    }
    const data = [...netByCustomer.entries()].map(([customerId, net]) => ({
      customerId,
      businessName: businessNameById.get(customerId) ?? "Unknown",
      invoiceCount: invoiceCountById.get(customerId) ?? 0,
      salesAmount: net.net,
    }));
    return {
      data: data.sort((a, b) => b.salesAmount - a.salesAmount),
      period: { from: fromDate, to: toDate },
    };
  }

  async getSalesByItem(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    // Query via Invoice (correct tenantId) and include items via relation.
    // Direct invoiceItem.findMany with forTenant() would inject tenantId on InvoiceItem,
    // but older nested-created items (written before nested creates were stamped) may have
    // tenantId=null, so we go through Invoice.
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF] },
        issueDate: { gte: fromDate, lte: toDate },
      },
      include: {
        items: { include: { product: { select: { id: true, name: true } } } },
      },
    });
    const byItem: Record<
      string,
      { productId: string | null; name: string; qty: number; amount: number }
    > = {};
    for (const inv of invoices) {
      for (const item of inv.items) {
        const key = item.productId ?? `desc:${item.description}`;
        const name = item.product?.name ?? item.description;
        if (!byItem[key]) byItem[key] = { productId: item.productId, name, qty: 0, amount: 0 };
        byItem[key].qty += Number(item.qty);
        byItem[key].amount += Number(item.subtotal);
      }
    }
    return {
      data: Object.values(byItem).sort((a, b) => b.amount - a.amount),
      period: { from: fromDate, to: toDate },
    };
  }

  async getCustomerBalanceSummary() {
    // Get all non-draft/non-void invoices for full invoiced + received calculation
    const allInvoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID] },
      },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true, phone: true } },
        // F03/R1: received/balance/overdue count CONFIRMED (PAID) payments only —
        // a DRAFT one isn't money received, same as a VOID (bounced) one (P5-12).
        payments: { where: CONFIRMED_PAYMENT },
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
        invoicedAmount: number;
        receivedAmount: number;
        closingBalance: number;
        indicator: string;
      }
    > = {};
    const now = new Date();
    const tz = await tenantTimeZone(this.prisma); // SA-488: the tenant's due day
    const unpaidStatuses: Set<string> = new Set([
      InvoiceStatus.SENT,
      InvoiceStatus.VIEWED,
      InvoiceStatus.PARTIAL,
      InvoiceStatus.OVERDUE,
    ]);

    for (const inv of allInvoices) {
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
          invoicedAmount: 0,
          receivedAmount: 0,
          closingBalance: 0,
          indicator: "\u2014",
        };

      const paid = sumConfirmed(inv.payments);
      byCustomer[key].invoicedAmount += Number(inv.total);
      byCustomer[key].receivedAmount += paid;

      if (unpaidStatuses.has(inv.status)) {
        // SA-770 row 310: `balance` (what the customer still OWES) and `overdue` add the CLAMPED invoice
        // balance, so an overpaid open invoice never nets against the customer's other invoices.
        const bal = confirmedBalance(inv.total, inv.payments);
        byCustomer[key].invoiceCount++;
        byCustomer[key].balance = roundMoney(byCustomer[key].balance + bal);
        if (isOverdue(inv.dueDate, now, tz)) {
          byCustomer[key].overdue = roundMoney(byCustomer[key].overdue + bal);
        }
      }
    }

    // Compute closing balance and indicator for each customer. SIGNED BY DESIGN (a NET position, never
    // clamped): invoiced minus received over every non-draft invoice, shown with a Dr/Cr indicator, so an
    // overpayment reads as a credit (Cr).
    for (const cust of Object.values(byCustomer)) {
      // rounded to cents BEFORE the sign picks Dr/Cr, so float dust (1.1 - 11 x 0.1 = 2e-16) reads as zero
      cust.closingBalance = roundMoney(cust.invoicedAmount - cust.receivedAmount);
      if (cust.closingBalance > 0) cust.indicator = "Dr";
      else if (cust.closingBalance < 0) cust.indicator = "Cr";
      else cust.indicator = "\u2014";
    }

    return { data: Object.values(byCustomer).sort((a, b) => b.balance - a.balance) };
  }

  async getInvoiceDetailsReport(from?: string, to?: string, status?: string, customerId?: string) {
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
    if (customerId) where.customerId = customerId;
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where,
      include: {
        customer: { select: { id: true, businessName: true } },
        // F03/R1: paid/balance count CONFIRMED (PAID) payments only — a DRAFT one
        // hasn't been collected, same as a VOID (bounced) one (P5-12).
        payments: { where: CONFIRMED_PAYMENT },
      },
      orderBy: { issueDate: "desc" },
    });
    return {
      data: invoices.map((inv) => {
        const paid = sumConfirmed(inv.payments);
        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customer: inv.customer,
          issueDate: inv.issueDate,
          dueDate: inv.dueDate,
          status: inv.status,
          total: Number(inv.total),
          paid,
          // display: the owed balance, clamped (an overpayment stays visible as paid > total)
          balance: confirmedBalance(inv.total, inv.payments),
        };
      }),
      period: { from: fromDate, to: toDate },
    };
  }

  /**
   * B456: `total` is sourced through `fetchBadDebtExpense` — the SAME
   * expression the P&L's `badDebtExpense` uses — so the two figures always
   * agree for the same window. `from`/`to` are optional and default to
   * full-tenant-history (this method had no window before B440); `data`'s
   * own listing query is intentionally left unwindowed (unlike `total`) so a
   * legacy WRITTEN_OFF invoice with no `writtenOffAt` timestamp still shows
   * up in the human-readable list even though it can't be windowed.
   */
  async getBadDebtsReport(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(0);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();

    const [invoices, expense] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where: { status: InvoiceStatus.WRITTEN_OFF },
        include: {
          customer: { select: { id: true, businessName: true } },
          // F03/R1: bad-debt paid/balance totals count CONFIRMED (PAID)
          // payments only — a DRAFT one isn't recovered money, nor is a VOID
          // one (P5-12).
          payments: { where: CONFIRMED_PAYMENT },
        },
        orderBy: { writtenOffAt: "desc" },
      }),
      // B456/Fable review of #791: this is the P&L's pre-tax, windowed
      // expense figure — NOT the same number as `total` below, which is the
      // gross balance the `data` rows sum to (what the web footer displays).
      fetchBadDebtExpense(this.prisma.forTenant(), this.requireTenantId(), {
        gte: fromDate,
        lte: toDate,
      }),
    ]);
    const data = invoices.map((inv) => {
      const paid = sumConfirmed(inv.payments);
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
        balance: confirmedBalance(inv.total, inv.payments),
      };
    });
    return {
      data,
      // Gross — Σ balance over `data`, so the web footer always equals the
      // column it's summing. Never the pre-tax/windowed `expense` figure.
      total: roundMoney(data.reduce((sum, d) => sum + d.balance, 0)),
      expense,
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
    // B421: a "Payments Received" report — a CREDIT_NOTE application is not
    // a payment received (it's a credit extended), so it belongs in neither
    // the listed rows nor the total. ADVANCE stays (already-real cash).
    const payments = await this.prisma.forTenant().invoicePayment.findMany({
      where: {
        status: PaymentStatus.PAID,
        method: RECEIVED_METHOD_FILTER,
        ...settledDateFilter({ gte: fromDate, lte: toDate }),
      },
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
      orderBy: { paidAt: "desc" },
    });
    const effectiveDate = (p: (typeof payments)[number]) => p.settledAt ?? p.paidAt ?? p.createdAt;
    payments.sort((a, b) => effectiveDate(b).getTime() - effectiveDate(a).getTime());
    return {
      data: payments.map((p) => ({
        id: p.id,
        createdAt: effectiveDate(p),
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
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const invoices = await this.prisma.forTenant().invoice.findMany({
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

    // Distribution across day buckets
    const total = withDaysFiltered.length;
    const bucketCounts = { "0-15d": 0, "16-30d": 0, "31-45d": 0, ">45d": 0 };
    for (const inv of withDaysFiltered) {
      const d = inv.daysToPayment!;
      if (d <= 15) bucketCounts["0-15d"]++;
      else if (d <= 30) bucketCounts["16-30d"]++;
      else if (d <= 45) bucketCounts["31-45d"]++;
      else bucketCounts[">45d"]++;
    }
    const distribution = {
      "0-15d": total > 0 ? Math.round((bucketCounts["0-15d"] / total) * 10000) / 100 : 0,
      "16-30d": total > 0 ? Math.round((bucketCounts["16-30d"] / total) * 10000) / 100 : 0,
      "31-45d": total > 0 ? Math.round((bucketCounts["31-45d"] / total) * 10000) / 100 : 0,
      ">45d": total > 0 ? Math.round((bucketCounts[">45d"] / total) * 10000) / 100 : 0,
    };

    return {
      data: withDays,
      averageDays: Math.round(avg),
      distribution,
      period: { from: fromDate, to: toDate },
    };
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
    const expenses = await this.prisma.forTenant().expense.findMany({
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
    const expenses = await this.prisma.forTenant().expense.findMany({
      where: { deletedAt: null, date: { gte: fromDate, lte: toDate } },
      include: { category: true },
    });
    const byCat: Record<
      string,
      { categoryId: string; categoryName: string; count: number; total: number }
    > = {};
    for (const e of expenses) {
      const key = e.categoryId ?? "uncategorized";
      if (!byCat[key])
        byCat[key] = {
          categoryId: key,
          categoryName: e.category?.name ?? "Uncategorized",
          count: 0,
          total: 0,
        };
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
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const expenses = await this.prisma.forTenant().expense.findMany({
      where: {
        deletedAt: null,
        date: { gte: fromDate, lte: toDate },
        customerId: { not: null },
      },
      include: { customer: { select: { id: true, businessName: true } } },
    });
    const byCust: Record<
      string,
      { customerId: string; customerName: string; count: number; totalAmount: number }
    > = {};
    for (const e of expenses) {
      const key = e.customerId!;
      if (!byCust[key])
        byCust[key] = {
          customerId: key,
          customerName: e.customer?.businessName ?? "Unknown",
          count: 0,
          totalAmount: 0,
        };
      byCust[key].count++;
      byCust[key].totalAmount += Number(e.amount);
    }
    return {
      data: Object.values(byCust).sort((a, b) => b.totalAmount - a.totalAmount),
      period: { from: fromDate, to: toDate },
    };
  }

  // ── Sales by Driver Report ──
  async getSalesByDriver(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();

    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        status: { notIn: [InvoiceStatus.VOID, InvoiceStatus.DRAFT] },
        issueDate: { gte: fromDate, lte: toDate },
      },
      include: {
        order: {
          select: {
            routeRun: {
              select: {
                driverId: true,
                driver: {
                  select: { id: true, contactName: true, user: { select: { username: true } } },
                },
              },
            },
          },
        },
      },
    });

    const byDriver: Record<
      string,
      {
        driverId: string;
        driverName: string;
        invoiceCount: number;
        salesTotal: number;
        salesWithTax: number;
      }
    > = {};
    for (const inv of invoices) {
      const driver = inv.order?.routeRun?.driver;
      if (!driver) continue;
      const key = driver.id;
      if (!byDriver[key])
        byDriver[key] = {
          driverId: driver.id,
          driverName: driver.contactName ?? driver.user.username,
          invoiceCount: 0,
          salesTotal: 0,
          salesWithTax: 0,
        };
      byDriver[key].invoiceCount++;
      byDriver[key].salesTotal += Number(inv.subtotal);
      byDriver[key].salesWithTax += Number(inv.total);
    }

    return {
      data: Object.values(byDriver).sort((a, b) => b.salesWithTax - a.salesWithTax),
      period: { from: fromDate, to: toDate },
    };
  }

  // ── AR Aging Details Report ──
  async getArAgingDetails(from?: string, to?: string, customerId?: string) {
    const now = new Date();
    const where: any = {
      status: { in: [InvoiceStatus.SENT, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE] },
    };
    if (from || to) {
      where.issueDate = {};
      if (from) where.issueDate.gte = new Date(from);
      if (to) {
        const d = new Date(to);
        d.setUTCHours(23, 59, 59, 999);
        where.issueDate.lte = d;
      }
    }
    if (customerId) where.customerId = customerId;

    const invoices = await this.prisma.forTenant().invoice.findMany({
      where,
      include: {
        customer: { select: { id: true, businessName: true } },
        // F03/R1: AR-aging balances net out CONFIRMED (PAID) payments only — a
        // DRAFT one hasn't reduced what's owed, same as a VOID one (P5-12).
        payments: { where: CONFIRMED_PAYMENT },
      },
      orderBy: { issueDate: "desc" },
    });

    const data = invoices
      .map((inv) => {
        const balance = confirmedBalance(inv.total, inv.payments);
        const refDate = inv.dueDate ?? inv.issueDate;
        const ageDays = Math.max(0, Math.floor((now.getTime() - refDate.getTime()) / 86400000));
        return {
          id: inv.id,
          date: inv.issueDate,
          dueDate: inv.dueDate,
          invoiceNumber: inv.invoiceNumber,
          status: inv.status,
          customerName: inv.customer.businessName,
          customerId: inv.customerId,
          ageDays,
          amount: Number(inv.total),
          balance,
        };
      })
      .filter((row) => row.balance > 0);

    return { data };
  }

  // ── Estimate Details Report ──
  async getEstimateDetails(from?: string, to?: string, status?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    const where: any = { createdAt: { gte: fromDate, lte: toDate } };
    if (status) where.status = status;

    const estimates = await this.prisma.forTenant().estimate.findMany({
      where,
      include: { customer: { select: { id: true, businessName: true } } },
      orderBy: { createdAt: "desc" },
    });

    return {
      data: estimates.map((est) => ({
        id: est.id,
        status: est.status,
        date: est.createdAt,
        expiresAt: est.expiresAt,
        estimateNumber: est.estimateNumber,
        customerName: est.customer.businessName,
        customerId: est.customerId,
        total: Number(est.total),
      })),
      period: { from: fromDate, to: toDate },
    };
  }

  // ── Refund History Report ──
  async getRefundHistory(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();

    const [voidPayments, appliedCreditNotes] = await Promise.all([
      this.prisma.forTenant().invoicePayment.findMany({
        where: { status: PaymentStatus.VOID, createdAt: { gte: fromDate, lte: toDate } },
        include: {
          invoice: {
            select: {
              invoiceNumber: true,
              customer: { select: { id: true, businessName: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { status: CreditNoteStatus.APPLIED, createdAt: { gte: fromDate, lte: toDate } },
        include: {
          customer: { select: { id: true, businessName: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const rows: Array<{
      date: Date;
      reference: string;
      customerName: string;
      customerId: string;
      method: string;
      amount: number;
      type: string;
    }> = [];

    for (const p of voidPayments) {
      rows.push({
        date: p.createdAt,
        reference: p.paymentNumber ?? p.reference ?? p.id,
        customerName: p.invoice.customer.businessName,
        customerId: p.invoice.customer.id,
        method: p.method,
        amount: Number(p.amount),
        type: "VOID_PAYMENT",
      });
    }

    for (const cn of appliedCreditNotes) {
      rows.push({
        date: cn.createdAt,
        reference: cn.creditNoteNumber,
        customerName: cn.customer.businessName,
        customerId: cn.customer.id,
        method: "CREDIT_NOTE",
        amount: Number(cn.amount),
        type: "CREDIT_NOTE",
      });
    }

    rows.sort((a, b) => b.date.getTime() - a.date.getTime());

    return {
      data: rows,
      period: { from: fromDate, to: toDate },
    };
  }

  // ── Receivable Summary Report ──
  async getReceivableSummary(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();

    const [invoices, creditNotes, payments] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where: {
          status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID] },
          issueDate: { gte: fromDate, lte: toDate },
        },
        include: {
          customer: { select: { id: true, businessName: true } },
          // F03/R1: invoice balances net out CONFIRMED (PAID) payments only — a
          // DRAFT one hasn't been collected, same as a VOID one (P5-12). The
          // separate payment LISTING below deliberately keeps every row and
          // carries `status` through to the renderer.
          payments: { where: CONFIRMED_PAYMENT },
        },
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { createdAt: { gte: fromDate, lte: toDate } },
        include: { customer: { select: { id: true, businessName: true } } },
      }),
      this.prisma.forTenant().invoicePayment.findMany({
        // check-payments PR-2b (M2): stays on createdAt intentionally — this
        // is a raw LISTING of payment rows for display, not a collected-
        // money total, so it isn't one of the collected readers M2 governs.
        where: { createdAt: { gte: fromDate, lte: toDate } },
        include: {
          invoice: {
            select: {
              invoiceNumber: true,
              customer: { select: { id: true, businessName: true } },
            },
          },
        },
      }),
    ]);

    const rows: Array<{
      customerName: string;
      date: Date;
      transactionNumber: string;
      type: string;
      status: string;
      total: number;
      balance: number;
    }> = [];

    for (const inv of invoices) {
      rows.push({
        customerName: inv.customer.businessName,
        date: inv.issueDate,
        transactionNumber: inv.invoiceNumber,
        type: "INVOICE",
        status: inv.status,
        total: Number(inv.total),
        balance: confirmedBalance(inv.total, inv.payments),
      });
    }

    for (const cn of creditNotes) {
      rows.push({
        customerName: cn.customer.businessName,
        date: cn.createdAt,
        transactionNumber: cn.creditNoteNumber,
        type: "CREDIT_NOTE",
        status: cn.status,
        total: Number(cn.amount),
        balance: Number(cn.amount) - Number(cn.amountUsed),
      });
    }

    for (const p of payments) {
      rows.push({
        customerName: p.invoice.customer.businessName,
        date: p.createdAt,
        transactionNumber: p.paymentNumber ?? p.id,
        type: "PAYMENT",
        status: p.status,
        total: Number(p.amount),
        balance: 0,
      });
    }

    rows.sort((a, b) => a.date.getTime() - b.date.getTime());

    return {
      data: rows,
      period: { from: fromDate, to: toDate },
    };
  }
}
