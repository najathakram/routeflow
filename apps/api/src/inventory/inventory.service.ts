import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RecordPurchaseDto } from "./dto/record-purchase.dto";
import { RecordAdjustmentDto } from "./dto/record-adjustment.dto";
import { ListMovementsDto } from "./dto/list-movements.dto";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Stock overview ──────────────────────────────────────────────────────────

  async getStockOverview() {
    const products = await this.prisma.forTenant().product.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        sku: true,
        category: true,
        unit: true,
        currentStock: true,
        averageCost: true,
        costingMethod: true,
        standardCost: true,
        isActive: true,
        unitsPerBox: true,
      },
    });

    return products.map((p) => {
      const stock = Number(p.currentStock);
      let effectiveCost: number | null = null;
      if (p.costingMethod === CostingMethod.STANDARD) {
        effectiveCost = p.standardCost ? Number(p.standardCost) : null;
      } else {
        effectiveCost = p.averageCost ? Number(p.averageCost) : null;
      }
      return {
        ...p,
        currentStock: stock,
        averageCost: effectiveCost,
        costingMethod: p.costingMethod,
        totalValue: effectiveCost !== null ? +(stock * effectiveCost).toFixed(4) : null,
      };
    });
  }

  // ─── Movements ───────────────────────────────────────────────────────────────

  async listMovements(query: ListMovementsDto) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 50);
    const skip = (page - 1) * limit;

    const where: Prisma.StockMovementWhereInput = {};
    if (query.productId) where.productId = query.productId;
    if (query.type) where.type = query.type;
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) {
        const toDate = new Date(query.to);
        toDate.setUTCHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.forTenant().stockMovement.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          product: { select: { id: true, name: true, sku: true, unit: true } },
          supplier: { select: { id: true, name: true } },
          performedBy: { select: { id: true, username: true } },
        },
      }),
      this.prisma.forTenant().stockMovement.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async recordPurchase(dto: RecordPurchaseDto, performedById: string) {
    const product = await this.prisma
      .forTenant()
      .product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException("Product not found");

    if (dto.supplierId) {
      const supplier = await this.prisma
        .forTenant()
        .supplier.findUnique({ where: { id: dto.supplierId } });
      if (!supplier) throw new NotFoundException("Supplier not found");
    }

    const qty = new Prisma.Decimal(dto.quantity);
    const unitCost = new Prisma.Decimal(dto.unitCost);
    const currentStock = product.currentStock;
    const currentAvgCost = product.averageCost ?? new Prisma.Decimal(0);
    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();

    // Calculate new average cost (used for AVCO; FIFO/LIFO still update for display)
    let newAvgCost: Prisma.Decimal;
    if (currentStock.lte(0)) {
      newAvgCost = unitCost;
    } else {
      newAvgCost = currentStock
        .mul(currentAvgCost)
        .add(qty.mul(unitCost))
        .div(currentStock.add(qty));
    }

    return this.prisma.tenantTransaction(async (tx) => {
      // Always create a StockLot for lot-tracking (used by FIFO/LIFO)
      await tx.stockLot.create({
        data: {
          productId: dto.productId,
          purchaseDate: effectiveDate,
          qty,
          remainingQty: qty,
          unitCost,
          reference: dto.reference,
          notes: dto.notes,
        },
      });

      const movement = await tx.stockMovement.create({
        data: {
          productId: dto.productId,
          type: MovementType.PURCHASE,
          quantity: qty,
          unitCost,
          supplierId: dto.supplierId,
          reference: dto.reference,
          notes: dto.notes,
          performedById,
          createdAt: effectiveDate,
        },
      });

      // Update stock and cost based on costing method
      const costUpdate: any = { currentStock: { increment: qty } };
      if (
        product.costingMethod === CostingMethod.AVCO ||
        product.costingMethod === CostingMethod.FIFO ||
        product.costingMethod === CostingMethod.LIFO
      ) {
        // For FIFO/LIFO we still store the running average in averageCost for reference
        costUpdate.averageCost = newAvgCost;
      }
      // STANDARD: don't touch averageCost

      await tx.product.update({
        where: { id: dto.productId },
        data: costUpdate,
      });

      return movement;
    });
  }

  async recordAdjustment(dto: RecordAdjustmentDto, performedById: string) {
    const product = await this.prisma
      .forTenant()
      .product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException("Product not found");

    const qty = new Prisma.Decimal(dto.quantity);
    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();

    return this.prisma.tenantTransaction(async (tx) => {
      const movement = await tx.stockMovement.create({
        data: {
          productId: dto.productId,
          type: MovementType.ADJUSTMENT,
          quantity: qty,
          reference: dto.reference,
          notes: dto.notes,
          performedById,
          createdAt: effectiveDate,
        },
      });

      await tx.product.update({
        where: { id: dto.productId },
        data: { currentStock: { increment: qty } },
      });

      // If positive adjustment, add to lots
      if (qty.gt(0)) {
        await tx.stockLot.create({
          data: {
            productId: dto.productId,
            purchaseDate: effectiveDate,
            qty,
            remainingQty: qty,
            unitCost: product.averageCost ?? new Prisma.Decimal(0),
            reference: dto.reference ?? "ADJUSTMENT",
            notes: dto.notes,
          },
        });
      }

      return movement;
    });
  }

  /**
   * Internal — called from orders service inside an existing transaction.
   * Consumes stock lots per the product's costing method.
   * Stock can go negative; never throws for insufficient stock.
   */
  async recordSale(
    productId: string,
    quantity: Prisma.Decimal,
    reference: string | null,
    performedById: string | null,
    tx: Prisma.TransactionClient,
  ) {
    const negativeQty = quantity.neg();

    await tx.stockMovement.create({
      data: {
        productId,
        type: MovementType.SALE,
        quantity: negativeQty,
        reference,
        performedById,
      },
    });

    await tx.product.update({
      where: { id: productId },
      data: { currentStock: { decrement: quantity } },
    });

    // Consume lots for FIFO/LIFO costing
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { costingMethod: true },
    });

    if (
      product?.costingMethod === CostingMethod.FIFO ||
      product?.costingMethod === CostingMethod.LIFO
    ) {
      const orderBy =
        product.costingMethod === CostingMethod.FIFO
          ? { purchaseDate: "asc" as const }
          : { purchaseDate: "desc" as const };

      const lots = await tx.stockLot.findMany({
        where: { productId, remainingQty: { gt: 0 } },
        orderBy,
      });

      let remaining = quantity;
      for (const lot of lots) {
        if (remaining.lte(0)) break;
        const lotRemaining = new Prisma.Decimal(lot.remainingQty);
        const consume = remaining.lte(lotRemaining) ? remaining : lotRemaining;
        await tx.stockLot.update({
          where: { id: lot.id },
          data: { remainingQty: { decrement: consume } },
        });
        remaining = remaining.sub(consume);
      }
    }
  }

  // ─── Suppliers ───────────────────────────────────────────────────────────────

  async listSuppliers() {
    return this.prisma.forTenant().supplier.findMany({ orderBy: { name: "asc" } });
  }

  async createSupplier(dto: CreateSupplierDto) {
    return this.prisma.forTenant().supplier.create({ data: dto });
  }

  async updateSupplier(id: string, dto: UpdateSupplierDto) {
    const supplier = await this.prisma.forTenant().supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException("Supplier not found");
    return this.prisma.forTenant().supplier.update({ where: { id }, data: dto });
  }

  // ── Purchase Orders ──
  private async nextPoNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `PO-${year}-`;
    const last = await this.prisma.forTenant().purchaseOrder.findFirst({
      where: { poNumber: { startsWith: prefix } },
      orderBy: { poNumber: "desc" },
    });
    const seq = last ? parseInt(last.poNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  async createPurchaseOrder(dto: any, userId: string) {
    if (!dto.supplierId) throw new BadRequestException("supplierId is required");
    if (!dto.items || dto.items.length === 0)
      throw new BadRequestException("At least one item is required");
    const supplier = await this.prisma
      .forTenant()
      .supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw new NotFoundException("Supplier not found");
    const products = await this.prisma.forTenant().product.findMany({
      where: { id: { in: dto.items.map((i: any) => i.productId) } },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));
    let totalAmount = 0;
    const itemsData = dto.items.map((item: any) => {
      const prod = productMap.get(item.productId);
      if (!prod) throw new NotFoundException(`Product ${item.productId} not found`);
      const qtyOrdered = item.qty ?? item.qtyOrdered;
      if (!qtyOrdered || qtyOrdered <= 0)
        throw new BadRequestException("Item quantity must be positive");
      const totalCost = qtyOrdered * item.unitCost;
      totalAmount += totalCost;
      return {
        productId: item.productId,
        qtyOrdered,
        qtyReceived: 0,
        unitCost: item.unitCost,
        totalCost,
      };
    });
    return this.prisma.forTenant().purchaseOrder.create({
      data: {
        poNumber: await this.nextPoNumber(),
        supplierId: dto.supplierId,
        status: "DRAFT",
        expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
        notes: dto.notes,
        totalAmount,
        items: { create: itemsData },
      },
      include: {
        supplier: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      },
    });
  }

  async listPurchaseOrders(query: any) {
    const { supplierId, status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (supplierId) where.supplierId = supplierId;
    if (status) where.status = status;
    const [data, total] = await Promise.all([
      this.prisma.forTenant().purchaseOrder.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } }, items: true },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().purchaseOrder.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getPurchaseOrder(id: string) {
    const po = await this.prisma.forTenant().purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    return po;
  }

  async sendPurchaseOrder(id: string) {
    const po = await this.prisma.forTenant().purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new NotFoundException("PO not found");
    if (po.status !== "DRAFT")
      throw new BadRequestException("Only DRAFT purchase orders can be sent");
    return this.prisma
      .forTenant()
      .purchaseOrder.update({ where: { id }, data: { status: "SENT" } });
  }

  async receivePurchaseOrder(id: string, dto: any, userId: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
      if (!po) throw new NotFoundException("PO not found");
      if (po.status === "CLOSED")
        throw new BadRequestException("Cannot receive against a closed PO");
      if (po.status === "RECEIVED") throw new BadRequestException("PO is already fully received");

      for (const recv of dto.items) {
        const itemId = recv.id ?? recv.itemId;
        const receivedQty = recv.receivedQty ?? recv.qtyReceived ?? 0;
        // Match by item id first, fall back to productId
        const item = po.items.find(
          (i) => i.id === itemId || (recv.productId && i.productId === recv.productId),
        );
        if (!item) continue;
        const maxReceivable = Number(item.qtyOrdered) - Number(item.qtyReceived);
        const actualQty = Math.min(receivedQty, maxReceivable);
        if (actualQty <= 0) continue;
        const newQtyReceived = Number(item.qtyReceived) + actualQty;
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { qtyReceived: newQtyReceived },
        });

        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: "PURCHASE",
            quantity: actualQty,
            unitCost: item.unitCost,
            supplierId: po.supplierId,
            reference: po.poNumber,
            performedById: userId,
          },
        });

        // Create StockLot for FIFO/LIFO tracking
        await tx.stockLot.create({
          data: {
            productId: item.productId,
            purchaseDate: new Date(),
            qty: new Prisma.Decimal(actualQty),
            remainingQty: new Prisma.Decimal(actualQty),
            unitCost: item.unitCost,
            reference: po.poNumber,
          },
        });

        const prod = await tx.product.findUnique({ where: { id: item.productId } });
        if (prod) {
          const curStock = Number(prod.currentStock);
          const curCost = Number(prod.averageCost ?? item.unitCost);
          const newStock = curStock + actualQty;
          const newCost =
            newStock > 0
              ? (curStock * curCost + actualQty * Number(item.unitCost)) / newStock
              : Number(item.unitCost);
          await tx.product.update({
            where: { id: item.productId },
            data: { currentStock: newStock, averageCost: newCost },
          });
        }
      }

      const updatedPo = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      });
      const allReceived = updatedPo!.items.every(
        (i) => Number(i.qtyReceived) >= Number(i.qtyOrdered),
      );
      const anyReceived = updatedPo!.items.some((i) => Number(i.qtyReceived) > 0);
      const newStatus = allReceived ? "RECEIVED" : anyReceived ? "PARTIAL" : po.status;
      return tx.purchaseOrder.update({
        where: { id },
        data: { status: newStatus },
        include: {
          supplier: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, name: true, unit: true } } } },
        },
      });
    });
  }

  async closePurchaseOrder(id: string) {
    return this.prisma
      .forTenant()
      .purchaseOrder.update({ where: { id }, data: { status: "CLOSED" } });
  }

  // ── Forecasting ──
  async getForecasting() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const products = await this.prisma.forTenant().product.findMany({ where: { isActive: true } });
    const movements = await this.prisma.forTenant().stockMovement.findMany({
      where: { type: "SALE", createdAt: { gte: thirtyDaysAgo } },
      select: { productId: true, quantity: true },
    });

    const usageMap = new Map<string, number>();
    for (const m of movements) {
      usageMap.set(m.productId, (usageMap.get(m.productId) ?? 0) + Math.abs(Number(m.quantity)));
    }

    return products.map((p) => {
      const totalUsed30 = usageMap.get(p.id) ?? 0;
      const avgDailyUsage = totalUsed30 / 30;
      const currentStock = Number(p.currentStock);
      const daysRemaining = avgDailyUsage > 0 ? Math.floor(currentStock / avgDailyUsage) : null;
      return {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        currentStock,
        avgDailySales: Math.round(avgDailyUsage * 100) / 100,
        totalUsed30Days: totalUsed30,
        daysRemaining,
        reorderPoint: p.reorderPoint,
        reorderQty: p.reorderQty,
        needsReorder: p.reorderPoint != null && currentStock < p.reorderPoint,
      };
    });
  }

  async setReorderPoint(productId: string, reorderPoint: number, reorderQty: number) {
    return this.prisma.forTenant().product.update({
      where: { id: productId },
      data: { reorderPoint, reorderQty },
    });
  }
}
