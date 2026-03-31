import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma, MovementType } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";

@Injectable()
export class VendorBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
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

  async voidBill(id: string) {
    return this.prisma.vendorBill.update({ where: { id }, data: { status: "VOID" as any } });
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

  async scanInvoice(imageBuffer: Buffer, mimeType: string) {
    const apiKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    // Fetch all active products for matching
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, name: true, sku: true, unit: true, averageCost: true, barcode: true },
      take: 500,
    });

    const productList = products
      .map(
        (p) =>
          `ID: ${p.id} | Name: ${p.name}${p.sku ? ` | SKU: ${p.sku}` : ""}${p.barcode ? ` | Barcode: ${p.barcode}` : ""}`,
      )
      .join("\n");

    const anthropic = new Anthropic({ apiKey });
    const base64Image = imageBuffer.toString("base64");

    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: base64Image,
              },
            },
            {
              type: "text",
              text: `You are analyzing a vendor/supplier invoice image. Extract all information and return valid JSON only (no markdown, no explanation).

Here are the existing products in our system:
${productList}

Return this exact JSON structure:
{
  "supplier": "supplier name or null",
  "invoiceNumber": "invoice number or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "items": [
    {
      "extractedName": "exact name from invoice",
      "qty": numeric quantity,
      "unitCost": numeric unit price,
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
- "high" confidence: name clearly matches (same or very similar, e.g., abbreviations, plural forms)
- "medium" confidence: likely match but name differs somewhat
- "low" confidence: possible match but unsure
- "none": no matching product found

If you cannot read a value clearly, use null. Return ONLY the JSON object.`,
            },
          ],
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
}
