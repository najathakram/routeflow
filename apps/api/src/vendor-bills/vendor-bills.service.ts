import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { Prisma, MovementType } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";

@Injectable()
export class VendorBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly systemConfig: SystemConfigService,
  ) {}

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
      totalOwed = dto.items.reduce(
        (sum: number, item: any) => sum + (Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0),
        0,
      );
    }

    const bill = await this.prisma.vendorBill.create({
      data: {
        billNumber: await this.nextBillNumber(),
        supplierId: dto.supplierId,
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
    const bill = await this.prisma.vendorBill.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status !== "DRAFT") {
      throw new BadRequestException("Only DRAFT bills can be edited. Revert to draft first.");
    }

    // Recalculate total if items are provided
    let totalOwed: number | undefined;
    if (dto.items && Array.isArray(dto.items)) {
      totalOwed = dto.items.reduce(
        (sum: number, item: any) => sum + (Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0),
        0,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Delete existing items and recreate if items provided
      if (dto.items !== undefined) {
        await tx.vendorBillItem.deleteMany({ where: { vendorBillId: id } });
      }

      return tx.vendorBill.update({
        where: { id },
        data: {
          ...(dto.supplierId !== undefined && { supplierId: dto.supplierId }),
          ...(dto.billDate !== undefined && { billDate: dto.billDate ? new Date(dto.billDate) : null }),
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
    const bill = await this.prisma.vendorBill.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");

    // Update bill status
    const updated = await this.prisma.$transaction(async (tx) => {
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
    const bill = await this.prisma.vendorBill.findUnique({
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

    return this.prisma.$transaction(async (tx) => {
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
    return this.prisma.vendorBill.update({ where: { id }, data: { status: "VOID" as any } });
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
      this.prisma.vendorBill.findMany({
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
      this.prisma.vendorBill.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const bill = await this.prisma.vendorBill.findUnique({
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
    return this.prisma.productMapping.upsert({
      where: { supplierName_rawDescription: { supplierName, rawDescription } },
      create: { supplierName, rawDescription, productId },
      update: { productId },
    });
  }

  async getProductMappings(supplierName: string) {
    return this.prisma.productMapping.findMany({
      where: { supplierName },
      include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
    });
  }

  async scanInvoice(imageBuffer: Buffer, mimeType: string) {
    // Look up API key: DB-stored key takes precedence over env var
    const storedKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey = (storedKey && storedKey.length > 0)
      ? storedKey
      : this.configService.get<string>("ANTHROPIC_API_KEY");
    if (!apiKey || apiKey.length === 0) {
      throw new BadRequestException(
        "Anthropic API key is not configured. Please add your API key in Settings → AI & Integrations.",
      );
    }

    // Fetch all active products for matching
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, name: true, sku: true, unit: true, averageCost: true, barcode: true },
      take: 500,
    });

    // Fetch all stored product mappings (all suppliers, we'll filter later by supplier name once known)
    const allMappings = await this.prisma.productMapping.findMany({
      include: { product: { select: { id: true, name: true } } },
    });
    const mappingIndex: Record<string, Record<string, { productId: string | null; productName: string | null }>> = {};
    for (const m of allMappings) {
      if (!mappingIndex[m.supplierName]) mappingIndex[m.supplierName] = {};
      mappingIndex[m.supplierName][m.rawDescription.toLowerCase()] = {
        productId: m.productId,
        productName: m.product?.name ?? null,
      };
    }

    const productList = products
      .map(
        (p) =>
          `ID: ${p.id} | Name: ${p.name}${p.sku ? ` | SKU: ${p.sku}` : ""}${p.barcode ? ` | Barcode: ${p.barcode}` : ""}`,
      )
      .join("\n");

    // Build a summary of known mappings for the prompt
    const mappingSummary = allMappings.length > 0
      ? `\nKnown item mappings from previous invoices (use these as high-confidence matches):\n` +
        allMappings
          .filter((m) => m.productId && m.product)
          .map((m) => `"${m.rawDescription}" (from ${m.supplierName}) → Product ID: ${m.productId} (${m.product?.name})`)
          .join("\n")
      : "";

    const anthropic = new Anthropic({ apiKey });
    const base64Data = imageBuffer.toString("base64");
    const isPdf = mimeType === "application/pdf";

    // Build the file content block — PDFs use "document" type, images use "image" type
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

    const promptText = `You are analyzing a vendor/supplier invoice${isPdf ? " (PDF document)" : " image"}. Extract all information and return valid JSON only (no markdown, no explanation).

Here are the existing products in our system:
${productList || "(no products configured yet)"}
${mappingSummary}

Return this exact JSON structure:
{
  "supplier": "supplier name or null",
  "invoiceNumber": "invoice number or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "expenseDescription": "one-line summary of what was purchased (e.g., 'Office supplies from Acme Corp') or null",
  "expenseCategory": "best-fit category: Food & Beverage, Supplies, Utilities, Transport, Marketing, Equipment, Maintenance, Professional Services, or Other",
  "items": [
    {
      "extractedName": "exact name from invoice",
      "qty": numeric quantity (required, default 1 if not shown),
      "unitCost": numeric unit price (required, calculate from line total / qty if not shown directly),
      "lineTotal": numeric line total or null,
      "matchedProductId": "product ID from list or null",
      "matchedProductName": "product name or null",
      "confidence": "high|medium|low|none"
    }
  ],
  "subtotal": numeric or null,
  "tax": numeric or null,
  "total": numeric or null,
  "notes": "any issues, ambiguities, or unreadable text"
}

Matching rules:
- If a known mapping exists for this supplier + item name, use that product ID with "high" confidence
- "high" confidence: name clearly matches (same or very similar, e.g., abbreviations, plural forms)
- "medium" confidence: likely match but name differs somewhat
- "low" confidence: possible match but unsure
- "none": no matching product found

IMPORTANT: Always extract qty and unitCost for every item. If qty is not shown, default to 1. If unitCost is not shown but lineTotal is, calculate unitCost = lineTotal / qty.

If you cannot read a value clearly, use null. Return ONLY the JSON object.`;

    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [fileContentBlock, { type: "text", text: promptText }],
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== "text") throw new Error("Unexpected response from Claude");

    let parsed: Record<string, unknown>;
    try {
      // Strip markdown code blocks if present
      const text = content.text
        .replace(/^```json\s*/m, "")
        .replace(/\s*```$/m, "")
        .trim();
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (_e) {
      throw new Error("Failed to parse AI response as JSON");
    }

    // Post-process: apply known mappings that AI might have missed
    const supplierName = (parsed.supplier as string) ?? "";
    if (supplierName && mappingIndex[supplierName]) {
      const supplierMappings = mappingIndex[supplierName];
      const items = parsed.items as any[] ?? [];
      for (const item of items) {
        const key = (item.extractedName as string ?? "").toLowerCase();
        const mapping = supplierMappings[key];
        if (mapping && mapping.productId && !item.matchedProductId) {
          item.matchedProductId = mapping.productId;
          item.matchedProductName = mapping.productName;
          item.confidence = "high";
        }
      }
    }

    return parsed;
  }

  async recordPayment(id: string, dto: { amount: number; method: string; reference?: string }) {
    return this.prisma.$transaction(async (tx) => {
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
    const bill = await this.prisma.vendorBill.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status === "RECEIVED" || bill.status === "PAID" || bill.status === "PARTIAL") {
      throw new BadRequestException("Cannot delete a bill that has been received or paid. Void it instead.");
    }
    await this.prisma.$transaction([
      this.prisma.billPayment.deleteMany({ where: { vendorBillId: id } }),
      this.prisma.vendorBillItem.deleteMany({ where: { vendorBillId: id } }),
      this.prisma.vendorBill.delete({ where: { id } }),
    ]);
    return { success: true };
  }

  async bulkDelete(ids: string[]) {
    if (!ids || ids.length === 0) throw new BadRequestException("No IDs provided");
    // Only delete DRAFT or VOID bills
    const bills = await this.prisma.vendorBill.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, billNumber: true },
    });
    const deletable = bills.filter(b => b.status === "DRAFT" || b.status === "VOID");
    const skipped = bills.filter(b => b.status !== "DRAFT" && b.status !== "VOID");
    if (deletable.length > 0) {
      const deletableIds = deletable.map(b => b.id);
      await this.prisma.$transaction([
        this.prisma.billPayment.deleteMany({ where: { vendorBillId: { in: deletableIds } } }),
        this.prisma.vendorBillItem.deleteMany({ where: { vendorBillId: { in: deletableIds } } }),
        this.prisma.vendorBill.deleteMany({ where: { id: { in: deletableIds } } }),
      ]);
    }
    return {
      deleted: deletable.length,
      skipped: skipped.map(b => ({ id: b.id, billNumber: b.billNumber, reason: "Cannot delete received/paid/partial bills" })),
    };
  }
}
