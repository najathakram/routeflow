import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { Prisma, MovementType } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";

@Injectable()
export class VendorBillsService {
  private readonly logger = new Logger(VendorBillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  private async nextBillNumber() {
    const year = new Date().getFullYear();
    const prefix = `BILL-${year}-`;
    const last = await this.prisma.forTenant().vendorBill.findFirst({
      where: { billNumber: { startsWith: prefix } },
      orderBy: { billNumber: "desc" },
    });
    const seq = last ? parseInt(last.billNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  async create(dto: any) {
    // supplierId is required when creating manually from the UI, but optional for import-created bills
    if (dto.requireSupplier !== false) {
      if (!dto.supplierId || typeof dto.supplierId !== "string" || dto.supplierId.trim() === "") {
        throw new BadRequestException("Please select a supplier before creating the bill.");
      }
    }
    const supplierId = (dto.supplierId && dto.supplierId.trim()) ? dto.supplierId.trim() : null;

    // Calculate totalOwed from line items if provided, otherwise use dto.totalOwed
    let totalOwed = dto.totalOwed ?? 0;
    if (dto.items && Array.isArray(dto.items) && dto.items.length > 0) {
      totalOwed = dto.items.reduce(
        (sum: number, item: any) =>
          sum + (Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0),
        0,
      );
    }

    const bill = await this.prisma.forTenant().vendorBill.create({
      data: {
        billNumber: await this.nextBillNumber(),
        ...(supplierId ? { supplierId } : {}),
        status: "DRAFT",
        totalOwed,
        billDate: dto.billDate ? new Date(dto.billDate) : null,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        notes: dto.notes,
        items:
          dto.items && dto.items.length > 0
            ? {
                createMany: {
                  data: dto.items.map((item: any) => ({
                    productId: item.productId || null,
                    description: item.description || item.name || "",
                    qty: new Prisma.Decimal(item.qty || 1),
                    unitCost: new Prisma.Decimal(item.unitCost ?? item.unitPrice ?? 0),
                  })),
                },
              }
            : undefined,
      },
      include: {
        supplier: { select: { id: true, name: true } },
        items: {
          include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
        },
      },
    });

    return bill;
  }

  async update(id: string, dto: any) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status !== "DRAFT") {
      throw new BadRequestException("Only DRAFT bills can be edited. Revert to draft first.");
    }

    // Recalculate total if items are provided
    let totalOwed: number | undefined;
    if (dto.items && Array.isArray(dto.items)) {
      totalOwed = dto.items.reduce(
        (sum: number, item: any) =>
          sum + (Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0),
        0,
      );
    }

    return this.prisma.tenantTransaction(async (tx) => {
      // Delete existing items and recreate if items provided
      if (dto.items !== undefined) {
        await tx.vendorBillItem.deleteMany({ where: { vendorBillId: id } });
      }

      return tx.vendorBill.update({
        where: { id },
        data: {
          ...(dto.supplierId !== undefined && { supplierId: dto.supplierId }),
          ...(dto.billDate !== undefined && {
            billDate: dto.billDate ? new Date(dto.billDate) : null,
          }),
          ...(dto.dueDate !== undefined && { dueDate: dto.dueDate ? new Date(dto.dueDate) : null }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(totalOwed !== undefined && { totalOwed }),
          ...(dto.items !== undefined && dto.items.length > 0
            ? {
                items: {
                  createMany: {
                    data: dto.items.map((item: any) => ({
                      productId: item.productId || null,
                      description: item.description || item.name || "",
                      qty: new Prisma.Decimal(item.qty || 1),
                      unitCost: new Prisma.Decimal(item.unitCost ?? item.unitPrice ?? 0),
                    })),
                  },
                },
              }
            : {}),
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
    });
  }

  async receive(id: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");

    // Update bill status
    const updated = await this.prisma.tenantTransaction(async (tx) => {
      const updatedBill = await tx.vendorBill.update({
        where: { id },
        data: { status: "RECEIVED", receivedDate: new Date() },
        include: {
          supplier: { select: { id: true, name: true } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
        },
      });

      // Sync inventory for each product-linked item
      for (const item of bill.items) {
        if (!item.productId || !item.product) continue;

        const product = item.product;
        const qty = new Prisma.Decimal(item.qty);
        const unitCost = new Prisma.Decimal(item.unitCost);
        const currentStock = product.currentStock;
        const currentAvgCost = product.averageCost ?? new Prisma.Decimal(0);

        // Weighted average cost
        let newAvgCost: Prisma.Decimal;
        if (currentStock.lte(0)) {
          newAvgCost = unitCost;
        } else {
          newAvgCost = currentStock
            .mul(currentAvgCost)
            .add(qty.mul(unitCost))
            .div(currentStock.add(qty));
        }

        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: MovementType.PURCHASE,
            quantity: qty,
            unitCost,
            supplierId: bill.supplierId,
            reference: bill.billNumber,
            notes: `Auto-synced from vendor bill ${bill.billNumber}`,
          },
        });

        await tx.product.update({
          where: { id: item.productId },
          data: {
            currentStock: { increment: qty },
            averageCost: newAvgCost,
          },
        });
      }

      return updatedBill;
    });

    return updated;
  }

  async revertToDraft(id: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    const allowedStatuses = ["RECEIVED", "PARTIAL"] as const;
    if (!(allowedStatuses as readonly string[]).includes(bill.status)) {
      throw new BadRequestException(
        `Only RECEIVED or PARTIAL bills can be reverted to DRAFT. Current status: ${bill.status}`,
      );
    }

    return this.prisma.tenantTransaction(async (tx) => {
      // Reverse inventory for each product-linked item
      for (const item of bill.items) {
        if (!item.productId) continue;

        const qty = new Prisma.Decimal(item.qty);
        const unitCost = new Prisma.Decimal(item.unitCost);

        // Delete the stock movement created when this bill was received
        await tx.stockMovement.deleteMany({
          where: {
            productId: item.productId,
            reference: bill.billNumber,
            type: MovementType.PURCHASE,
          },
        });

        // Read current product state within the transaction for accurate AVCO reversal
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { currentStock: true, averageCost: true },
        });
        if (!product) continue;

        const currentStock = new Prisma.Decimal(product.currentStock);
        const currentAvgCost = new Prisma.Decimal(product.averageCost ?? 0);
        const stockAfterRevert = currentStock.sub(qty);

        // Reverse AVCO: prevAvg = (currentAvg * currentStock - qty * unitCost) / (currentStock - qty)
        let newAvgCost: Prisma.Decimal;
        if (stockAfterRevert.lte(0)) {
          newAvgCost = new Prisma.Decimal(0);
        } else {
          const numerator = currentStock.mul(currentAvgCost).sub(qty.mul(unitCost));
          newAvgCost = numerator.div(stockAfterRevert);
          if (newAvgCost.lt(0)) newAvgCost = new Prisma.Decimal(0);
        }

        await tx.product.update({
          where: { id: item.productId },
          data: { currentStock: { decrement: qty }, averageCost: newAvgCost },
        });
      }

      // Revert bill status to DRAFT
      return tx.vendorBill.update({
        where: { id },
        data: { status: "DRAFT", receivedDate: null },
        include: {
          supplier: { select: { id: true, name: true } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
    });
  }

  async voidBill(id: string) {
    return this.prisma
      .forTenant()
      .vendorBill.update({ where: { id }, data: { status: "VOID" as any } });
  }

  async findAll(
    supplierId?: string,
    status?: string,
    dateFrom?: string,
    dateTo?: string,
    search?: string,
    page = 1,
    limit = 20,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (supplierId) where.supplierId = supplierId;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.billDate = {};
      if (dateFrom) where.billDate.gte = new Date(dateFrom);
      if (dateTo) where.billDate.lte = new Date(dateTo + "T23:59:59.999Z");
    }
    if (search) {
      where.OR = [
        { billNumber: { contains: search, mode: "insensitive" } },
        { supplier: { name: { contains: search, mode: "insensitive" } } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.forTenant().vendorBill.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          payments: { orderBy: { createdAt: "desc" }, take: 1 },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.forTenant().vendorBill.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: {
        supplier: true,
        payments: { orderBy: { createdAt: "desc" } },
        items: {
          include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
        },
      },
    });
    if (!bill) throw new NotFoundException("Vendor bill not found");
    return bill;
  }

  // ─── Product Mapping Memory ───────────────────────────────────────────────────

  async saveProductMapping(supplierName: string, rawDescription: string, productId: string | null) {
    return this.prisma.forTenant().productMapping.upsert({
      where: { supplierName_rawDescription: { supplierName, rawDescription } },
      create: { supplierName, rawDescription, productId },
      update: { productId },
    });
  }

  async getProductMappings(supplierName: string) {
    return this.prisma.forTenant().productMapping.findMany({
      where: { supplierName },
      include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
    });
  }

  async scanInvoice(imageBuffer: Buffer, mimeType: string) {
    // Look up API key: DB-stored key takes precedence over env var
    const storedKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey =
      storedKey && storedKey.length > 0
        ? storedKey
        : this.configService.get<string>("ANTHROPIC_API_KEY");
    if (!apiKey || apiKey.length === 0) {
      throw new BadRequestException(
        "Anthropic API key is not configured. Please add your API key in Settings → AI & Integrations.",
      );
    }

    // ── Phase 1: AI extraction (raw text only — no product catalog in prompt) ──
    const anthropic = new Anthropic({ apiKey });
    const base64Data = imageBuffer.toString("base64");
    const isPdf = mimeType === "application/pdf";

    const fileContentBlock = isPdf
      ? ({
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: base64Data,
          },
        } as any)
      : {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: base64Data,
          },
        };

    const promptText = `Extract data from this supplier invoice and return JSON only (no markdown, no explanation).

Return exactly this structure:
{
  "supplier": string or null,
  "invoiceNumber": string or null,
  "invoiceDate": "YYYY-MM-DD" or null,
  "expenseDescription": one-line summary or null,
  "expenseCategory": one of: "Food & Beverage", "Supplies", "Utilities", "Transport", "Marketing", "Equipment", "Maintenance", "Professional Services", "Other",
  "items": [
    {
      "extractedName": "exact product name as written on invoice",
      "qty": quantity as a number (REQUIRED — read directly from invoice; default 1 only if completely absent),
      "unitCost": unit price as a number (if not shown, calculate lineTotal / qty),
      "lineTotal": line total as a number or null
    }
  ],
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "notes": any issues or null
}

IMPORTANT: Always read the actual quantity from each line item. Do not default to 1 unless the invoice truly shows no quantity. Return ONLY the JSON object.`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: [fileContentBlock, { type: "text", text: promptText }] }],
    });

    const content = message.content[0];
    if (content.type !== "text") throw new Error("Unexpected response from Claude");

    let parsed: Record<string, unknown>;
    try {
      let text = content.text.trim();
      text = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
      if (!text.startsWith("{")) {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) text = match[0];
      }
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (_e) {
      this.logger.error(`scanInvoice: failed to parse AI response. Raw output:\n${content.text}`);
      throw new Error("Failed to parse AI response as JSON");
    }

    // ── Phase 2: Server-side product matching (free, instant, no tokens) ──
    const [products, allMappings] = await Promise.all([
      this.prisma.forTenant().product.findMany({
        select: { id: true, name: true, sku: true, barcode: true },
      }),
      this.prisma.forTenant().productMapping.findMany({
        include: { product: { select: { id: true, name: true } } },
      }),
    ]);

    // Build mapping index keyed by supplierName → rawDescription (lowercase)
    const mappingIndex: Record<
      string,
      Record<string, { productId: string | null; productName: string | null }>
    > = {};
    for (const m of allMappings) {
      if (!mappingIndex[m.supplierName]) mappingIndex[m.supplierName] = {};
      mappingIndex[m.supplierName][m.rawDescription.toLowerCase()] = {
        productId: m.productId,
        productName: m.product?.name ?? null,
      };
    }

    // Normalise a string for fuzzy comparison
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    // Word-overlap score (ignores words ≤ 2 chars)
    const overlap = (a: string, b: string): number => {
      const wa = new Set(
        norm(a)
          .split(" ")
          .filter((w) => w.length > 2),
      );
      const wb = new Set(
        norm(b)
          .split(" ")
          .filter((w) => w.length > 2),
      );
      if (wa.size === 0 || wb.size === 0) return 0;
      let hits = 0;
      for (const w of wa) if (wb.has(w)) hits++;
      return hits / Math.max(wa.size, wb.size);
    };

    const supplierName = (parsed.supplier as string) ?? "";
    const supplierMappings = supplierName ? (mappingIndex[supplierName] ?? {}) : {};

    const items = ((parsed.items as any[]) ?? []).map((item: any) => {
      const raw: string = item.extractedName ?? "";
      const rawLower = raw.toLowerCase();

      // 1. Exact mapping hit (learned from previous corrections)
      if (supplierMappings[rawLower]?.productId) {
        const m = supplierMappings[rawLower];
        return {
          ...item,
          matchedProductId: m.productId,
          matchedProductName: m.productName,
          confidence: "high",
        };
      }

      // 2. Exact name match (case-insensitive)
      const exactName = products.find((p) => p.name.toLowerCase() === rawLower);
      if (exactName) {
        return {
          ...item,
          matchedProductId: exactName.id,
          matchedProductName: exactName.name,
          confidence: "high",
        };
      }

      // 3. Exact SKU / barcode match
      const exactCode = products.find(
        (p) => (p.sku && p.sku.toLowerCase() === rawLower) || (p.barcode && p.barcode === raw),
      );
      if (exactCode) {
        return {
          ...item,
          matchedProductId: exactCode.id,
          matchedProductName: exactCode.name,
          confidence: "high",
        };
      }

      // 4. Fuzzy word-overlap match
      let bestId: string | null = null;
      let bestName: string | null = null;
      let bestScore = 0;
      for (const p of products) {
        const score = overlap(raw, p.name);
        if (score > bestScore) {
          bestScore = score;
          bestId = p.id;
          bestName = p.name;
        }
      }
      if (bestScore >= 0.6) {
        return {
          ...item,
          matchedProductId: bestId,
          matchedProductName: bestName,
          confidence: bestScore >= 0.8 ? "high" : "medium",
        };
      }
      if (bestScore >= 0.35) {
        return {
          ...item,
          matchedProductId: bestId,
          matchedProductName: bestName,
          confidence: "low",
        };
      }

      return { ...item, matchedProductId: null, matchedProductName: null, confidence: "none" };
    });

    return { ...parsed, items };
  }

  async recordPayment(id: string, dto: { amount: number; method: string; reference?: string }) {
    return this.prisma.tenantTransaction(async (tx) => {
      const bill = await tx.vendorBill.findUnique({ where: { id }, include: { payments: true } });
      if (!bill) throw new NotFoundException("Bill not found");
      const alreadyPaid = bill.payments.reduce((s, p) => s + Number(p.amount), 0);
      const remaining = Number(bill.totalOwed) - alreadyPaid;
      if (remaining <= 0) throw new BadRequestException("Bill already fully paid");
      await tx.billPayment.create({
        data: {
          vendorBillId: id,
          amount: dto.amount,
          method: dto.method as any,
          reference: dto.reference,
        },
      });
      const newPaid = alreadyPaid + dto.amount;
      const newStatus = newPaid >= Number(bill.totalOwed) - 0.001 ? "PAID" : "PARTIAL";
      return tx.vendorBill.update({
        where: { id },
        data: { totalPaid: newPaid, status: newStatus as any },
        include: {
          supplier: { select: { id: true, name: true } },
          payments: { orderBy: { createdAt: "desc" } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
        },
      });
    });
  }

  async delete(id: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status === "RECEIVED" || bill.status === "PAID" || bill.status === "PARTIAL") {
      throw new BadRequestException(
        "Cannot delete a bill that has been received or paid. Void it instead.",
      );
    }
    await this.prisma.$transaction([
      this.prisma.forTenant().billPayment.deleteMany({ where: { vendorBillId: id } }),
      this.prisma.forTenant().vendorBillItem.deleteMany({ where: { vendorBillId: id } }),
      this.prisma.forTenant().vendorBill.delete({ where: { id } }),
    ]);
    return { success: true };
  }

  async bulkDelete(ids: string[]) {
    if (!ids || ids.length === 0) throw new BadRequestException("No IDs provided");
    // Only delete DRAFT or VOID bills
    const bills = await this.prisma.forTenant().vendorBill.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, billNumber: true },
    });
    const deletable = bills.filter((b) => b.status === "DRAFT" || b.status === "VOID");
    const skipped = bills.filter((b) => b.status !== "DRAFT" && b.status !== "VOID");
    if (deletable.length > 0) {
      const deletableIds = deletable.map((b) => b.id);
      await this.prisma.$transaction([
        this.prisma
          .forTenant()
          .billPayment.deleteMany({ where: { vendorBillId: { in: deletableIds } } }),
        this.prisma
          .forTenant()
          .vendorBillItem.deleteMany({ where: { vendorBillId: { in: deletableIds } } }),
        this.prisma.forTenant().vendorBill.deleteMany({ where: { id: { in: deletableIds } } }),
      ]);
    }
    return {
      deleted: deletable.length,
      skipped: skipped.map((b) => ({
        id: b.id,
        billNumber: b.billNumber,
        reason: "Cannot delete received/paid/partial bills",
      })),
    };
  }
}
