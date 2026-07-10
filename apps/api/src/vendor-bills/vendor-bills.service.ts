import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { Prisma, MovementType } from "@prisma/client";
import { costDecimal, nextAverageCost, reverseAverageCost } from "../inventory/costing";
import { roundMoney } from "../common/pricing";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

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
    const supplierId = dto.supplierId && dto.supplierId.trim() ? dto.supplierId.trim() : null;

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

  async receive(id: string, dto?: { acknowledgeUnlinked?: boolean }, performedById?: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    // RF-084: idempotency guard — prevent double-receive doubling stock
    if (bill.status === "RECEIVED") throw new ConflictException("Bill already received");

    // Cost-integrity guard: unmapped lines don't update inventory or costs.
    // Warn-and-confirm rather than hard block — bills legitimately carry
    // non-inventory lines (freight, deposits). Clients catch code
    // UNLINKED_ITEMS, show the skipped lines, and retry acknowledged.
    const unlinkedItems = bill.items.filter((i) => !i.productId);
    if (!dto?.acknowledgeUnlinked && (bill.items.length === 0 || unlinkedItems.length > 0)) {
      throw new ConflictException({
        code: "UNLINKED_ITEMS",
        message:
          bill.items.length === 0
            ? "This bill has no line items, so receiving it will not update any inventory or costs."
            : "Some line items are not linked to a product and will not update inventory or costs.",
        unlinkedItems: unlinkedItems.map((i) => ({
          id: i.id,
          description: i.description,
          qty: Number(i.qty),
          unitCost: Number(i.unitCost),
        })),
      });
    }

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

        const qty = new Prisma.Decimal(item.qty);
        const unitCost = costDecimal(item.unitCost);

        // Read fresh state inside the tx so multi-line bills of the same
        // product compound correctly instead of using the pre-tx snapshot
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { currentStock: true, averageCost: true },
        });
        if (!product) continue;

        const newAvgCost = nextAverageCost(
          product.currentStock,
          product.averageCost,
          qty,
          unitCost,
        );
        const stockAfter = product.currentStock.add(qty);

        // StockLot keeps FIFO/LIFO parity with manual purchases and PO receive
        await tx.stockLot.create({
          data: {
            productId: item.productId,
            purchaseDate: bill.billDate ?? new Date(),
            qty,
            remainingQty: qty,
            unitCost,
            reference: bill.billNumber,
          },
        });

        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: MovementType.PURCHASE,
            quantity: qty,
            unitCost,
            avgCostAfter: newAvgCost,
            stockAfter,
            supplierId: bill.supplierId,
            reference: bill.billNumber,
            notes: `Auto-synced from vendor bill ${bill.billNumber}`,
            performedById: performedById ?? null,
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
        const unitCost = costDecimal(item.unitCost);

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

        // Exact AVCO reversal; null ⇒ reversal empties stock — KEEP the
        // previous average so the product's cost basis survives the revert
        const reversedAvg =
          product.averageCost != null
            ? reverseAverageCost(product.currentStock, product.averageCost, qty, unitCost)
            : null;

        await tx.product.update({
          where: { id: item.productId },
          data: {
            currentStock: { decrement: qty },
            ...(reversedAvg !== null ? { averageCost: reversedAvg } : {}),
          },
        });
      }

      // Reverse the lots this bill created (one per received line)
      await this.reverseBillLots(tx, bill.billNumber);

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

  /**
   * Remove the StockLots a bill's receive created (reference = billNumber).
   * Untouched lots are deleted outright; partially-consumed lots can only
   * surrender what remains, so they are zeroed and annotated.
   */
  private async reverseBillLots(tx: Prisma.TransactionClient, billNumber: string) {
    const lots = await tx.stockLot.findMany({ where: { reference: billNumber } });
    for (const lot of lots) {
      const remaining = new Prisma.Decimal(lot.remainingQty);
      if (remaining.gte(new Prisma.Decimal(lot.qty))) {
        await tx.stockLot.delete({ where: { id: lot.id } });
      } else {
        const consumed = new Prisma.Decimal(lot.qty).sub(remaining);
        await tx.stockLot.update({
          where: { id: lot.id },
          data: {
            remainingQty: 0,
            notes: `${lot.notes ? `${lot.notes} ` : ""}(bill reversed; ${consumed.toString()} already consumed)`,
          },
        });
      }
    }
  }

  async voidBill(id: string, performedById?: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: { items: { include: { product: true } } },
    });
    if (!bill) throw new NotFoundException("Bill not found");

    // RF-085: reverse stock movements when voiding a RECEIVED bill
    const needsReversal =
      bill.status === "RECEIVED" || bill.status === "PARTIAL" || bill.status === "PAID";
    if (needsReversal) {
      return this.prisma.tenantTransaction(async (tx) => {
        for (const item of bill.items) {
          if (!item.productId || !item.product) continue;
          const qty = new Prisma.Decimal(item.qty);
          const unitCost = costDecimal(item.unitCost);

          const product = await tx.product.findUnique({
            where: { id: item.productId },
            select: { currentStock: true, averageCost: true },
          });
          if (!product) continue;

          // Exact AVCO reversal; null ⇒ keep the previous average (never zero
          // the cost basis just because the void drains stock)
          const reversedAvg =
            product.averageCost != null
              ? reverseAverageCost(product.currentStock, product.averageCost, qty, unitCost)
              : null;
          const stockAfter = product.currentStock.sub(qty);

          // Compensating stock movement with negative quantity
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: MovementType.ADJUSTMENT,
              quantity: qty.negated(),
              unitCost,
              avgCostAfter: reversedAvg ?? product.averageCost,
              stockAfter,
              supplierId: bill.supplierId,
              reference: bill.billNumber,
              notes: `Void reversal for vendor bill ${bill.billNumber}`,
              performedById: performedById ?? null,
            },
          });

          await tx.product.update({
            where: { id: item.productId },
            data: {
              currentStock: { decrement: qty },
              ...(reversedAvg !== null ? { averageCost: reversedAvg } : {}),
            },
          });
        }

        // Reverse the lots this bill created
        await this.reverseBillLots(tx, bill.billNumber);

        return tx.vendorBill.update({ where: { id }, data: { status: "VOID" as any } });
      });
    }

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
    needsMapping?: boolean,
  ) {
    const skip = (page - 1) * limit;
    // A DRAFT bill "needs mapping" when it has no line items at all (imported
    // bills) or any line not linked to a product — receiving it would skip
    // inventory/cost updates.
    const needsMappingOr = [{ items: { none: {} } }, { items: { some: { productId: null } } }];
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
    if (needsMapping) {
      where.status = "DRAFT";
      where.AND = [...(where.AND ?? []), { OR: needsMappingOr }];
    }
    const [data, total, needsMappingCount] = await Promise.all([
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
      this.prisma.forTenant().vendorBill.count({ where: { status: "DRAFT", OR: needsMappingOr } }),
    ]);
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit), needsMappingCount },
    };
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

  async scanInvoice(files: Array<{ buffer: Buffer; mimeType: string }>) {
    // Look up API key: DB-stored key takes precedence over env var
    const storedKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey =
      storedKey && storedKey.length > 0
        ? storedKey
        : this.configService.get<string>("ANTHROPIC_API_KEY");
    if (!apiKey || apiKey.length === 0) {
      throw new BadRequestException(
        "AI invoice scanning is not available. Please contact your system administrator to configure the ANTHROPIC_API_KEY.",
      );
    }

    // ── Phase 0: Normalise inputs ─────────────────────────────────────────────
    // Multi-page invoices arrive as N images (HEIC from iPhone, JPEG, PNG, etc.)
    // or one PDF. HEIC isn't a Claude vision media type, so convert it to JPEG
    // server-side with sharp before sending. PDFs go through as-is via the
    // `document` content block.
    const fileContentBlocks: any[] = [];
    for (const f of files) {
      const isPdf = f.mimeType === "application/pdf";
      if (isPdf) {
        fileContentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: f.buffer.toString("base64"),
          },
        });
        continue;
      }
      // HEIC / HEIF → JPEG via sharp (libvips). Strip orientation metadata via
      // .rotate() so iPhone photos show right-side up to Claude.
      const isHeic = f.mimeType === "image/heic" || f.mimeType === "image/heif";
      let buf = f.buffer;
      let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" = f.mimeType as any;
      if (isHeic) {
        try {
          buf = await sharp(f.buffer).rotate().jpeg({ quality: 85 }).toBuffer();
          mediaType = "image/jpeg";
        } catch (e) {
          this.logger.error(`scanInvoice: HEIC→JPEG conversion failed: ${(e as Error).message}`);
          throw new BadRequestException(
            "Couldn't read one of the HEIC images. Try exporting it as JPEG and re-uploading.",
          );
        }
      }
      fileContentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: buf.toString("base64"),
        },
      });
    }

    // Phase 1 uses Haiku — cheap OCR, no catalog reasoning required at this step.
    const anthropic = new Anthropic({ apiKey });

    const promptText = `Extract data from this supplier invoice and return JSON only (no markdown, no explanation).

The invoice may span MULTIPLE pages — each input image/PDF is one page of the same invoice. Combine all line items across all pages into one items[] array. Use the supplier/invoice#/date/totals from whichever page they appear on (usually page 1 for header, last page for totals).

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

    // Phase 1 uses Haiku — cheap OCR, no catalog reasoning required at this step.
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [...fileContentBlocks, { type: "text", text: promptText }],
        },
      ],
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
      const alreadyPaid = roundMoney(bill.payments.reduce((s, p) => s + Number(p.amount), 0));
      const remaining = roundMoney(Number(bill.totalOwed) - alreadyPaid);
      if (remaining <= 0) throw new BadRequestException("Bill already fully paid");
      if (Number(dto.amount) > remaining + 0.001) {
        throw new BadRequestException(
          `Payment amount exceeds the remaining balance of ${remaining.toFixed(2)}.`,
        );
      }
      await tx.billPayment.create({
        data: {
          vendorBillId: id,
          amount: dto.amount,
          method: dto.method as any,
          reference: dto.reference,
        },
      });
      const newPaid = roundMoney(alreadyPaid + Number(dto.amount));
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
