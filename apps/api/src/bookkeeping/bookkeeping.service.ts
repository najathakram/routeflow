import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { InvoiceStatus, TxnStatus, PaymentStatus, CreditNoteStatus } from "@prisma/client";
import { ListTransactionsDto } from "./dto/list-transactions.dto";
import { RecordPaymentDto } from "./dto/record-payment.dto";
import { InvoiceService } from "./invoice.service";
import { StorageService } from "../storage/storage.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { SystemConfigService } from "../system-config/system-config.service";
import Anthropic from "@anthropic-ai/sdk";
import * as sharp from "sharp";
import { IRS_SYSTEM_CATEGORIES } from "./irs-categories.constant";

@Injectable()
export class BookkeepingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceService: InvoiceService,
    private readonly storage: StorageService,
    private readonly vendorBillsService: VendorBillsService,
    private readonly configService: ConfigService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async onModuleInit() {
    // These helpers were designed for a single-tenant setup. In multi-tenant
    // mode there is no tenant context at startup, so they would run unscoped
    // across ALL tenants — potentially hanging on large data sets. Skip them
    // at boot; they will be lazily called per-tenant on first request instead.
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
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
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
    const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
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
      customer: inv.customer,
      order: inv.order ?? { orderNumber: inv.invoiceNumber },
      payments: inv.payments,
      items: [],
    };
  }

  async recordPayment(id: string, dto: RecordPaymentDto) {
    return this.prisma.tenantTransaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Transaction not found");

      const alreadyPaid = inv.payments.reduce((sum, p) => sum + Number(p.amount), 0);
      const totalOwed = Number(inv.total);
      const remaining = totalOwed - alreadyPaid;
      if (remaining <= 0) {
        throw new BadRequestException("Transaction is already fully paid");
      }
      if (dto.amount > remaining + 0.001) {
        throw new BadRequestException(
          `Payment of ${dto.amount} exceeds remaining balance of ${remaining.toFixed(2)}`,
        );
      }

      await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount: dto.amount,
          method: dto.method as any,
          reference: dto.reference,
          notes: dto.notes,
          status: PaymentStatus.PAID,
          paidAt: new Date(),
        },
      });

      const totalPaid = alreadyPaid + dto.amount;
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

      let ledgerStatus: TxnStatus;
      if (updated.status === InvoiceStatus.PAID) ledgerStatus = TxnStatus.PAID;
      else if (updated.status === InvoiceStatus.PARTIAL) ledgerStatus = TxnStatus.PARTIAL;
      else ledgerStatus = TxnStatus.UNPAID;

      const paid2 = updated.payments.reduce((s, p) => s + Number(p.amount), 0);
      return {
        id: updated.id,
        status: ledgerStatus,
        customerId: updated.customerId,
        createdAt: updated.issueDate,
        totalOwed: Number(updated.total),
        totalPaid: paid2,
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

    return this.prisma.expenseCategory.findMany({
      where: {
        OR: [{ tenantId }, { tenantId: null }],
        NOT: { code: "INVENTORY_PURCHASE" },
      },
      orderBy: { name: "asc" },
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
        computedAmount = Number(rest.distance) * rateSnapshot;
      }
    }

    // For itemized expenses, amount = sum of line items
    if (isItemized && lineItems?.length) {
      computedAmount = lineItems.reduce((s: number, li: any) => s + Number(li.amount), 0);
    }

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
        ...(isItemized && lineItems?.length
          ? {
              lineItems: {
                create: lineItems.map((li: any) => ({
                  account: li.account,
                  notes: li.notes,
                  amount: li.amount,
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
        ...(dto.amount !== undefined && { amount: dto.amount }),
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

  async deleteExpense(id: string) {
    return this.prisma
      .forTenant()
      .expense.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ── Expense Receipt Management ─────────────────────────────────────────────

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

    const isPdf = mimeType === "application/pdf";
    let finalBuffer = buffer;
    let finalMime = mimeType;

    if (!isPdf) {
      // Compress images: resize to max 1600px wide, JPEG 80% quality
      finalBuffer = await (sharp as any)(buffer)
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      finalMime = "image/jpeg";
    }

    const ext = isPdf ? "pdf" : "jpg";
    const key = `expenses/${id}/receipt.${ext}`;
    await this.storage.upload(key, finalBuffer, finalMime);

    await this.prisma.forTenant().expense.update({
      where: { id },
      data: {
        receiptKey: key,
        receiptOriginalName: originalName,
        receiptMimeType: finalMime,
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

    // Retrieve Anthropic API key
    const storedKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey = storedKey?.length
      ? storedKey
      : this.configService.get<string>("ANTHROPIC_API_KEY");
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

    const response = await anthropic.messages.create({
      model: "claude-opus-4-5-20251101",
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

    let parsed: any = {};
    try {
      const text = (response.content[0] as any).text ?? "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      throw new BadRequestException("Could not parse receipt — please check the image quality");
    }

    const items: any[] = parsed.items ?? [];

    // Replace existing line items with extracted ones
    await this.prisma.forTenant().expenseLineItem.deleteMany({ where: { expenseId: id } });
    if (items.length > 0) {
      await this.prisma.forTenant().expenseLineItem.createMany({
        data: items.map((item: any) => ({
          expenseId: id,
          account: item.description ?? "Item",
          notes: null,
          amount: Number(item.amount ?? item.unitCost ?? 0),
          unitCost: item.unitCost != null ? Number(item.unitCost) : null,
          qty: item.qty != null ? Number(item.qty) : null,
        })),
      });
    }

    const totalFromItems = items.reduce((s: number, i: any) => s + Number(i.amount ?? 0), 0);

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
      this.prisma.forTenant().invoice.aggregate({
        where: { status: InvoiceStatus.PAID, paidAt: { gte: fromDate, lte: toDate } },
        _sum: { total: true },
      }),
      this.prisma.forTenant().stockMovement.findMany({
        where: { type: "SALE", createdAt: { gte: fromDate, lte: toDate } },
        select: { quantity: true, unitCost: true },
      }),
      this.prisma.forTenant().expense.findMany({
        where: { deletedAt: null, date: { gte: fromDate, lte: toDate } },
        include: { category: true },
      }),
    ]);

    const revenue = Number(revenueAgg._sum.total ?? 0);
    const cogs = cogsMovements.reduce(
      (s, m) => s + Math.abs(Number(m.quantity)) * Number(m.unitCost ?? 0),
      0,
    );
    const grossProfit = revenue - cogs;
    const opEx = expenses.reduce((s, e) => s + Number(e.amount), 0);
    const netProfit = grossProfit - opEx;

    const byCategory = expenses.reduce((acc: any, e) => {
      const cat = e.category?.name ?? "Uncategorized";
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
        where: { status: CfPayStatus.PAID, paidAt: { gte: fromDate, lte: toDate } },
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
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);

    const [totalRevenueResult, outstandingInvoices, paymentsThisWeekResult, overdueCount] =
      await Promise.all([
        this.prisma.forTenant().invoice.aggregate({
          where: { status: InvoiceStatus.PAID, paidAt: { gte: startOfMonth } },
          _sum: { total: true },
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
          select: { total: true, payments: { select: { amount: true } } },
        }),
        this.prisma.forTenant().invoicePayment.aggregate({
          where: { createdAt: { gte: sevenDaysAgo } },
          _sum: { amount: true },
        }),
        this.prisma.forTenant().invoice.count({
          where: {
            status: {
              in: [
                InvoiceStatus.SENT,
                InvoiceStatus.VIEWED,
                InvoiceStatus.PARTIAL,
                InvoiceStatus.OVERDUE,
              ],
            },
            dueDate: { lt: now },
          },
        }),
      ]);

    const outstandingReceivables = outstandingInvoices.reduce((sum, inv) => {
      const paid = inv.payments.reduce((s: number, p: any) => s + Number(p.amount), 0);
      return sum + (Number(inv.total) - paid);
    }, 0);

    return {
      totalRevenue: Number(totalRevenueResult._sum.total ?? 0),
      outstandingReceivables,
      paymentsThisWeek: Number(paymentsThisWeekResult._sum.amount ?? 0),
      overdueCount,
    };
  }

  // ── Finance Dashboard ──
  async getFinanceDashboard() {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

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
        this.prisma.forTenant().invoice.aggregate({
          where: {
            status: {
              notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF],
            },
            issueDate: { gte: mStart, lte: mEnd },
          },
          _sum: { total: true },
        }),
        this.prisma.forTenant().invoicePayment.aggregate({
          where: { createdAt: { gte: mStart, lte: mEnd } },
          _sum: { amount: true },
        }),
        this.prisma.forTenant().expense.aggregate({
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
      const [s, r] = await Promise.all([
        this.prisma.forTenant().invoice.aggregate({
          where: {
            status: {
              notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF],
            },
            issueDate: { gte: from },
          },
          _sum: { total: true },
        }),
        this.prisma.forTenant().invoicePayment.aggregate({
          where: { createdAt: { gte: from } },
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

  async getArAgingInvoices(intervalDays = 30) {
    const now = new Date();
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
      include: { customer: { select: { id: true, businessName: true } }, payments: true },
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
        buckets[bucketKeys[0]].push(entry);
        continue;
      }
      const daysPast = Math.floor((now.getTime() - inv.dueDate.getTime()) / 86400000);
      if (daysPast <= interval) buckets[bucketKeys[1]].push(entry);
      else if (daysPast <= interval * 2) buckets[bucketKeys[2]].push(entry);
      else if (daysPast <= interval * 3) buckets[bucketKeys[3]].push(entry);
      else buckets[bucketKeys[4]].push(entry);
    }
    const sum = (arr: any[]) => arr.reduce((s, e) => s + e.balance, 0);
    const totals: Record<string, number> = {};
    let grandTotal = 0;
    for (const key of bucketKeys) {
      totals[key] = sum(buckets[key]);
      grandTotal += totals[key];
    }
    totals.total = grandTotal;

    return { buckets, totals, intervalDays: interval };
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
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF] },
        issueDate: { gte: fromDate, lte: toDate },
      },
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
    // but nested-created items have tenantId=null (bypass extension), so we go through Invoice.
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
        invoicedAmount: number;
        receivedAmount: number;
        closingBalance: number;
        indicator: string;
      }
    > = {};
    const now = new Date();
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

      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      byCustomer[key].invoicedAmount += Number(inv.total);
      byCustomer[key].receivedAmount += paid;

      if (unpaidStatuses.has(inv.status)) {
        const bal = Number(inv.total) - paid;
        byCustomer[key].invoiceCount++;
        byCustomer[key].balance += bal;
        if (inv.dueDate && inv.dueDate < now) byCustomer[key].overdue += bal;
      }
    }

    // Compute closing balance and indicator for each customer
    for (const cust of Object.values(byCustomer)) {
      cust.closingBalance = cust.invoicedAmount - cust.receivedAmount;
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
    const invoices = await this.prisma.forTenant().invoice.findMany({
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
    const payments = await this.prisma.forTenant().invoicePayment.findMany({
      where: { status: PaymentStatus.PAID, paidAt: { gte: fromDate, lte: toDate } },
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
    return {
      data: payments.map((p) => ({
        id: p.id,
        createdAt: p.paidAt ?? p.createdAt,
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
        payments: true,
      },
      orderBy: { issueDate: "desc" },
    });

    const data = invoices
      .map((inv) => {
        const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        const balance = Number(inv.total) - paid;
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
          payments: true,
        },
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { createdAt: { gte: fromDate, lte: toDate } },
        include: { customer: { select: { id: true, businessName: true } } },
      }),
      this.prisma.forTenant().invoicePayment.findMany({
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
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      rows.push({
        customerName: inv.customer.businessName,
        date: inv.issueDate,
        transactionNumber: inv.invoiceNumber,
        type: "INVOICE",
        status: inv.status,
        total: Number(inv.total),
        balance: Number(inv.total) - paid,
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
