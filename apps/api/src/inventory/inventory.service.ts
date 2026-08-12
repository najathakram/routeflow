import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";
import { fetchInvoicedSaleLines, roundQty } from "../common/invoiced-sales";
import { costDecimal, nextAverageCost, planLotConsumption, reverseAverageCost } from "./costing";
import { RecordPurchaseDto } from "./dto/record-purchase.dto";
import { RecordAdjustmentDto } from "./dto/record-adjustment.dto";
import { CommitStockCountDto } from "./dto/commit-stock-count.dto";
import { ListMovementsDto } from "./dto/list-movements.dto";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { SetCostBasisDto } from "./dto/set-cost-basis.dto";
import { BulkSetCostBasisDto } from "./dto/bulk-set-cost-basis.dto";
import { RecomputeCostsDto } from "./dto/recompute-costs.dto";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stockAlerts: StockAlertService,
  ) {}

  /**
   * P5-03: fire Notify-me stock alerts for products whose stock just
   * increased. Always called AFTER the inventory transaction has committed
   * (never inside it) and NEVER throws — a slow or failed push must not roll
   * back or break the stock write. Idempotent across paths: the service only
   * transitions PENDING → NOTIFIED, so a second call fires nothing.
   *
   * Fire-and-forget: the fan-out (one push per pending subscriber) can be slow
   * for a heavily-subscribed product, so it must NOT block the operator's HTTP
   * response. We start it and return immediately; the tenant AsyncLocalStorage
   * context is retained by the detached continuations, and any error is logged
   * (fireForProducts already swallows per-alert push failures internally).
   */
  private fireStockAlerts(productIds: string[]): void {
    if (productIds.length === 0) return;
    void this.stockAlerts.fireForProducts(productIds).catch((err) => {
      this.logger.warn(`Stock-alert fire failed (non-fatal): ${(err as Error).message}`);
    });
  }

  // ─── Stock overview ──────────────────────────────────────────────────────────

  /**
   * The single effective-cost + carrying-value rule shared by getStockOverview
   * and getValuation so the two money surfaces never disagree:
   *   • STANDARD → standardCost ?? averageCost.
   *   • everything else → averageCost.
   *
   * Valuation is weighted-average for every method, because every WRITE path is:
   * `nextAverageCost` maintains `Product.averageCost` on each receipt regardless
   * of `costingMethod`. This used to value FIFO/LIFO products from open stock
   * lots instead, which was only sound while lots were drawn down on sale — and
   * `recordSale`, the sole draw-down, has had no caller since c5f579c2. Lots
   * therefore only ever grew while `currentStock` fell, so the lot branch
   * reported the cost of every unit ever received, including everything already
   * sold (measured at $12,463 over 54 products before this changed). Reading the
   * average keeps the read consistent with the write and cannot drift that way.
   */
  private effectiveValue(p: {
    costingMethod: CostingMethod;
    currentStock: Prisma.Decimal | number;
    averageCost: Prisma.Decimal | null;
    standardCost: Prisma.Decimal | null;
  }): { unitCost: number | null; value: number | null } {
    const stock = Number(p.currentStock);
    const avg = p.averageCost != null ? Number(p.averageCost) : null;
    const eff =
      p.costingMethod === CostingMethod.STANDARD
        ? p.standardCost != null
          ? Number(p.standardCost)
          : avg
        : avg;
    return eff != null
      ? { unitCost: eff, value: +(stock * eff).toFixed(4) }
      : { unitCost: null, value: null };
  }

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
        reorderPoint: true,
        reorderQty: true,
        trackedCategoryId: true,
      },
    });

    return products.map((p) => {
      const stock = Number(p.currentStock);
      const { unitCost, value } = this.effectiveValue(p);
      return {
        ...p,
        currentStock: stock,
        averageCost: unitCost,
        costingMethod: p.costingMethod,
        totalValue: value,
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
    const unitCost = costDecimal(dto.unitCost);
    const currentStock = product.currentStock;
    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();

    // New weighted average (used for AVCO; FIFO/LIFO still update for display)
    const newAvgCost = nextAverageCost(currentStock, product.averageCost, qty, unitCost);
    const stockAfter = currentStock.add(qty);
    const updatesAverage = product.costingMethod !== CostingMethod.STANDARD;
    const avgCostAfter = updatesAverage ? newAvgCost : (product.averageCost ?? null);

    const result = await this.prisma.tenantTransaction(async (tx) => {
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
          avgCostAfter,
          stockAfter,
          supplierId: dto.supplierId,
          reference: dto.reference,
          notes: dto.notes,
          performedById,
          createdAt: effectiveDate,
        },
      });

      // Update stock and cost based on costing method
      const costUpdate: any = { currentStock: { increment: qty } };
      if (updatesAverage) {
        // For FIFO/LIFO we still store the running average in averageCost for reference
        costUpdate.averageCost = newAvgCost;
      }
      // STANDARD: don't touch averageCost

      await tx.product.update({
        where: { id: dto.productId },
        data: costUpdate,
      });

      // A backdated purchase invalidates the snapshots (and possibly the
      // average) of every later movement — replay the product to repair them.
      const newer = await tx.stockMovement.count({
        where: { productId: dto.productId, createdAt: { gt: effectiveDate } },
      });
      if (newer > 0) await this.recomputeProductInTx(tx, dto.productId);

      return movement;
    });

    this.fireStockAlerts([dto.productId]);
    return result;
  }

  async recordAdjustment(dto: RecordAdjustmentDto, performedById: string) {
    const product = await this.prisma
      .forTenant()
      .product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException("Product not found");

    const qty = new Prisma.Decimal(dto.quantity);
    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();

    const result = await this.prisma.tenantTransaction(async (tx) => {
      const movement = await tx.stockMovement.create({
        data: {
          productId: dto.productId,
          type: MovementType.ADJUSTMENT,
          quantity: qty,
          // Quantity-only adjustments never move the average
          avgCostAfter: product.averageCost ?? null,
          stockAfter: product.currentStock.add(qty),
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

      // Backdated adjustment: repair later snapshots
      const newer = await tx.stockMovement.count({
        where: { productId: dto.productId, createdAt: { gt: effectiveDate } },
      });
      if (newer > 0) await this.recomputeProductInTx(tx, dto.productId);

      return movement;
    });

    if (qty.gt(0)) this.fireStockAlerts([dto.productId]);
    return result;
  }

  // ─── Stock count / audit session ─────────────────────────────────────────────

  async commitStockCount(dto: CommitStockCountDto, performedById: string) {
    const productIds = Array.from(new Set(dto.items.map((i) => i.productId)));
    const products = await this.prisma
      .forTenant()
      .product.findMany({ where: { id: { in: productIds } } });

    const productMap = new Map(products.map((p) => [p.id, p]));
    const missingProductIds = productIds.filter((id) => !productMap.has(id));
    if (missingProductIds.length > 0) {
      throw new NotFoundException({
        message: "One or more products could not be found",
        missingProductIds,
      });
    }

    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();
    const reference = `STOCK_COUNT-${dto.sessionId}`;
    const restockedProductIds: string[] = [];

    const result = await this.prisma.tenantTransaction(async (tx) => {
      // Idempotency: a client whose response was lost (timeout / 502) may re-post
      // the SAME sessionId. Without this, every ADD delta would be applied twice
      // and lots duplicated. If this session already wrote movements, return the
      // prior result instead of re-applying.
      const already = await tx.stockMovement.findMany({
        where: { reference },
        select: { id: true },
      });
      if (already.length > 0) {
        return {
          sessionId: dto.sessionId,
          reference,
          applied: already.length,
          skipped: 0,
          movementIds: already.map((m) => m.id),
          alreadyCommitted: true,
        };
      }

      const movementIds: string[] = [];
      let skipped = 0;
      // Running stock per product so repeated items in one count session
      // produce truthful stockAfter snapshots.
      const runningStock = new Map<string, Prisma.Decimal>();

      for (const item of dto.items) {
        const product = productMap.get(item.productId)!;
        const stockBefore = runningStock.get(item.productId) ?? product.currentStock;
        const counted = new Prisma.Decimal(item.quantity);
        const delta = item.mode === "REPLACE" ? counted.minus(stockBefore) : counted;

        if (delta.eq(0)) {
          skipped += 1;
          continue;
        }
        const stockAfter = stockBefore.add(delta);
        runningStock.set(item.productId, stockAfter);

        const itemNotes = dto.notes
          ? `${dto.notes} (mode=${item.mode} counted=${counted.toString()})`
          : `mode=${item.mode} counted=${counted.toString()}`;

        const movement = await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: MovementType.ADJUSTMENT,
            quantity: delta,
            avgCostAfter: product.averageCost ?? null,
            stockAfter,
            reference,
            notes: itemNotes,
            performedById,
            createdAt: effectiveDate,
          },
        });
        movementIds.push(movement.id);

        await tx.product.update({
          where: { id: item.productId },
          data: { currentStock: { increment: delta } },
        });

        if (delta.gt(0)) {
          await tx.stockLot.create({
            data: {
              productId: item.productId,
              purchaseDate: effectiveDate,
              qty: delta,
              remainingQty: delta,
              unitCost: product.averageCost ?? new Prisma.Decimal(0),
              reference,
              notes: itemNotes,
            },
          });
          restockedProductIds.push(item.productId);
        }
      }

      return {
        sessionId: dto.sessionId,
        reference,
        applied: movementIds.length,
        skipped,
        movementIds,
      };
    });

    this.fireStockAlerts(restockedProductIds);
    return result;
  }

  /**
   * Internal — the single sale-costing path, called from the orders service
   * inside an existing transaction. Writes the SALE movement WITH its unit
   * cost (COGS), stamps snapshots, decrements stock, and consumes lots per
   * the product's costing method.
   * Stock can go negative; never throws for insufficient stock.
   */
  async recordSale(
    productId: string,
    quantity: Prisma.Decimal,
    reference: string | null,
    performedById: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<{ unitCost: Prisma.Decimal; stockAfter: Prisma.Decimal }> {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { costingMethod: true, averageCost: true, standardCost: true, currentStock: true },
    });

    const avgCost = product?.averageCost ?? null;
    const fallback = costDecimal(avgCost ?? 0);
    let unitCost = fallback;
    let lotConsumptions: { id: string; take: Prisma.Decimal }[] = [];

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
      // Blend the consumed lots' costs; any uncovered remainder (negative
      // stock / pre-fix data without lots) is priced at the average cost.
      const plan = planLotConsumption(lots, quantity, fallback);
      unitCost = plan.weightedUnitCost;
      lotConsumptions = plan.consumptions;
    } else if (product?.costingMethod === CostingMethod.STANDARD) {
      unitCost = costDecimal(product.standardCost ?? avgCost ?? 0);
    } else if (product?.costingMethod === CostingMethod.LAST_COST) {
      // Last cost — cost the sale at the most recent PURCHASE's unit cost
      // (pos-cost-roles-spec §1: "most recent bill's unit cost"). Read the typed
      // PURCHASE movement, NOT the latest StockLot: positive adjustments and
      // stock-counts create lots stamped at the AVERAGE cost, which would poison
      // the last-cost source. Order by createdAt (true record time) + id so the
      // pick is deterministic when same-day bills share a date. Falls back to the
      // average cost when the product has no purchases yet. Not lot-consuming.
      const lastPurchase = await tx.stockMovement.findFirst({
        where: { productId, type: MovementType.PURCHASE },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { unitCost: true },
      });
      unitCost = costDecimal(lastPurchase?.unitCost ?? avgCost ?? 0);
    }

    const stockAfter = (product?.currentStock ?? new Prisma.Decimal(0)).sub(quantity);

    await tx.stockMovement.create({
      data: {
        productId,
        type: MovementType.SALE,
        quantity: quantity.neg(),
        unitCost,
        // Sales never move the average — snapshot carries it forward
        avgCostAfter: avgCost,
        stockAfter,
        reference,
        performedById,
      },
    });

    await tx.product.update({
      where: { id: productId },
      data: { currentStock: { decrement: quantity } },
    });

    for (const consumption of lotConsumptions) {
      await tx.stockLot.update({
        where: { id: consumption.id },
        data: { remainingQty: { decrement: consumption.take } },
      });
    }

    return { unitCost, stockAfter };
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
    const restockedProductIds: string[] = [];

    const result = await this.prisma.tenantTransaction(async (tx) => {
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
        restockedProductIds.push(item.productId);
        const newQtyReceived = Number(item.qtyReceived) + actualQty;
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { qtyReceived: newQtyReceived },
        });

        const qtyReceived = new Prisma.Decimal(actualQty);
        const itemUnitCost = costDecimal(item.unitCost);

        const prod = await tx.product.findUnique({ where: { id: item.productId } });
        const newAvgCost = prod
          ? nextAverageCost(prod.currentStock, prod.averageCost, qtyReceived, itemUnitCost)
          : itemUnitCost;
        const stockAfter = (prod?.currentStock ?? new Prisma.Decimal(0)).add(qtyReceived);

        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: "PURCHASE",
            quantity: qtyReceived,
            unitCost: itemUnitCost,
            avgCostAfter: newAvgCost,
            stockAfter,
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
            qty: qtyReceived,
            remainingQty: qtyReceived,
            unitCost: itemUnitCost,
            reference: po.poNumber,
          },
        });

        if (prod) {
          await tx.product.update({
            where: { id: item.productId },
            data: { currentStock: stockAfter, averageCost: newAvgCost },
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

    this.fireStockAlerts(restockedProductIds);
    return result;
  }

  async closePurchaseOrder(id: string) {
    return this.prisma
      .forTenant()
      .purchaseOrder.update({ where: { id }, data: { status: "CLOSED" } });
  }

  // ── Forecasting ──
  /**
   * 30-day demand per product, from invoiced sales windowed on
   * Invoice.issueDate. `StockMovement type:"SALE"` is not viable: its only
   * writer (the route-delivery recordSale call) was removed in c5f579c2, so
   * movement rows read as zero demand for every tenant. Line `qty` is the
   * same denomination order-create decrements `currentStock` by, so
   * `daysRemaining = currentStock / avgDaily` stays unit-consistent. See
   * common/invoiced-sales.ts for the through-Invoice rule.
   */
  async getForecasting() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const products = await this.prisma.forTenant().product.findMany({ where: { isActive: true } });
    const lines = await fetchInvoicedSaleLines(this.prisma.forTenant(), {
      from: thirtyDaysAgo,
      to: new Date(),
      dateBasis: "issueDate",
    });

    const usageMap = new Map<string, number>();
    for (const line of lines) {
      if (!line.productId) continue;
      usageMap.set(line.productId, (usageMap.get(line.productId) ?? 0) + line.qty);
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
        totalUsed30Days: roundQty(totalUsed30),
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

  // ─── Cost basis & valuation ─────────────────────────────────────────────────

  /** Total inventory value at effective cost, plus which products have no cost set. */
  async getValuation() {
    const products = await this.prisma.forTenant().product.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        currentStock: true,
        averageCost: true,
        standardCost: true,
        costingMethod: true,
      },
    });

    let totalValue = 0;
    const missingCostProducts: { id: string; name: string }[] = [];
    for (const p of products) {
      // Same effective-cost rule as getStockOverview so the two money surfaces reconcile.
      const { value } = this.effectiveValue(p);
      if (value == null) {
        missingCostProducts.push({ id: p.id, name: p.name });
        continue;
      }
      totalValue += value;
    }

    return {
      totalValue: roundMoney(totalValue),
      productCount: products.length,
      missingCostCount: missingCostProducts.length,
      missingCostProducts,
    };
  }

  /** Manually set a product's average cost. Audited via a COST_BASIS movement (qty 0). */
  async setCostBasis(productId: string, dto: SetCostBasisDto, performedById: string) {
    const product = await this.prisma.forTenant().product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException("Product not found");

    return this.prisma.tenantTransaction((tx) =>
      this.setCostBasisInTx(tx, product, dto, performedById),
    );
  }

  async bulkSetCostBasis(dto: BulkSetCostBasisDto, performedById: string) {
    const productIds = Array.from(new Set(dto.items.map((i) => i.productId)));
    const products = await this.prisma
      .forTenant()
      .product.findMany({ where: { id: { in: productIds } } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const missing = productIds.filter((id) => !productMap.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({
        message: "One or more products could not be found",
        missingProductIds: missing,
      });
    }

    return this.prisma.tenantTransaction(async (tx) => {
      const movementIds: string[] = [];
      for (const item of dto.items) {
        const movement = await this.setCostBasisInTx(
          tx,
          productMap.get(item.productId)!,
          { unitCost: item.unitCost, notes: dto.notes, applyToLots: dto.applyToLots },
          performedById,
        );
        movementIds.push(movement.id);
      }
      return { updated: movementIds.length, movementIds };
    });
  }

  private async setCostBasisInTx(
    tx: Prisma.TransactionClient,
    product: { id: string; currentStock: Prisma.Decimal; costingMethod: CostingMethod },
    dto: SetCostBasisDto,
    performedById: string,
  ) {
    const unitCost = costDecimal(dto.unitCost);

    const movement = await tx.stockMovement.create({
      data: {
        productId: product.id,
        type: MovementType.COST_BASIS,
        quantity: 0,
        unitCost,
        avgCostAfter: unitCost,
        stockAfter: product.currentStock,
        notes: dto.notes,
        performedById,
      },
    });

    // A STANDARD product is valued from standardCost, so also set it — otherwise
    // "Set cost" writes averageCost only and the stock table (which reads
    // standardCost for STANDARD) never clears its "No cost set" state.
    await tx.product.update({
      where: { id: product.id },
      data:
        product.costingMethod === CostingMethod.STANDARD
          ? { averageCost: unitCost, standardCost: unitCost }
          : { averageCost: unitCost },
    });

    if (dto.applyToLots) {
      await tx.stockLot.updateMany({
        where: { productId: product.id, remainingQty: { gt: 0 } },
        data: { unitCost },
      });
    }

    return movement;
  }

  // ─── Cost recompute (repair) ────────────────────────────────────────────────

  /**
   * Rebuild averageCost + movement snapshots by replaying each product's
   * movement history. Products with no costful history (no PURCHASE with a
   * unit cost, no COST_BASIS) are left untouched and reported under
   * `noHistory` so the operator can set a cost basis manually.
   */
  async recomputeCosts(dto: RecomputeCostsDto) {
    const where: Prisma.ProductWhereInput = {};
    if (dto.productIds?.length) where.id = { in: dto.productIds };
    const products = await this.prisma.forTenant().product.findMany({
      where,
      select: { id: true, name: true, currentStock: true, averageCost: true, costingMethod: true },
      orderBy: { name: "asc" },
    });

    const results: {
      productId: string;
      name: string;
      oldAvgCost: number | null;
      newAvgCost: number | null;
      stockDrift: number;
      movementsBackfilled: number;
    }[] = [];
    const noHistory: { productId: string; name: string }[] = [];

    for (const product of products) {
      // One transaction per product to bound lock time on big tenants
      const replay = dto.dryRun
        ? await this.replayProduct(product, null)
        : await this.prisma.tenantTransaction((tx) => this.replayProduct(product, tx));

      if (!replay.hasCostfulHistory) {
        noHistory.push({ productId: product.id, name: product.name });
      } else {
        results.push({
          productId: product.id,
          name: product.name,
          oldAvgCost: replay.oldAvgCost,
          newAvgCost: replay.newAvgCost,
          stockDrift: replay.stockDrift,
          movementsBackfilled: replay.movementsBackfilled,
        });
      }
    }

    return {
      dryRun: !!dto.dryRun,
      processed: products.length,
      updated: results.length,
      noHistory,
      results,
    };
  }

  /** Repair a single product's snapshots/average inside an existing transaction. */
  private async recomputeProductInTx(tx: Prisma.TransactionClient, productId: string) {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, currentStock: true, averageCost: true, costingMethod: true },
    });
    if (!product) return;
    await this.replayProduct(product, tx);
  }

  /**
   * Replay a product's movements oldest-first with a running (stock, avg):
   * - COST_BASIS ⇒ avg := unitCost
   * - PURCHASE with unitCost ⇒ weighted average update
   * - ADJUSTMENT with unitCost ⇒ weighted forward (qty>0) / exact reverse (qty<0)
   * - everything else ⇒ quantity only, average unchanged
   * With a tx, snapshots are backfilled on every movement and the product's
   * averageCost is updated when costful history exists. Never mutates stock.
   */
  private async replayProduct(
    product: {
      id: string;
      name: string;
      currentStock: Prisma.Decimal;
      averageCost: Prisma.Decimal | null;
      costingMethod: CostingMethod;
    },
    tx: Prisma.TransactionClient | null,
  ) {
    const client = tx ?? this.prisma.forTenant();
    const movements = await client.stockMovement.findMany({
      where: { productId: product.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, type: true, quantity: true, unitCost: true },
    });

    // STANDARD products keep averageCost frozen — the live recordPurchase path
    // deliberately never moves it (valuation reads standardCost). Replaying the
    // weighted average here would overwrite it and fabricate a bogus dry-run
    // "correction", so mirror that: carry the existing average forward untouched.
    const isStandard = product.costingMethod === CostingMethod.STANDARD;

    let stock = new Prisma.Decimal(0);
    let avg: Prisma.Decimal | null = isStandard
      ? product.averageCost != null
        ? costDecimal(product.averageCost)
        : null
      : null;
    let hasCostfulHistory = isStandard && avg != null;
    let movementsBackfilled = 0;

    for (const m of movements) {
      const qty = new Prisma.Decimal(m.quantity);
      const unitCost = m.unitCost != null ? new Prisma.Decimal(m.unitCost) : null;

      if (!isStandard) {
        switch (m.type) {
          case MovementType.COST_BASIS:
            if (unitCost != null) {
              avg = costDecimal(unitCost);
              hasCostfulHistory = true;
            }
            break;
          case MovementType.PURCHASE:
            if (unitCost != null) {
              avg = nextAverageCost(stock, avg, qty, unitCost);
              hasCostfulHistory = true;
            }
            break;
          case MovementType.ADJUSTMENT:
            // Costed adjustments are bill-void compensations: reverse the average
            if (unitCost != null && avg != null) {
              if (qty.gt(0)) avg = nextAverageCost(stock, avg, qty, unitCost);
              else if (qty.lt(0)) avg = reverseAverageCost(stock, avg, qty.neg(), unitCost) ?? avg;
            }
            break;
          default:
            // SALE / RETURN / WRITE_OFF: quantity only, average carries forward
            break;
        }
      }

      stock = stock.add(qty);

      if (tx) {
        await tx.stockMovement.update({
          where: { id: m.id },
          data: { avgCostAfter: avg, stockAfter: stock },
        });
        movementsBackfilled += 1;
      }
    }

    // STANDARD never rewrites averageCost (frozen); others persist the replayed avg.
    if (tx && !isStandard && hasCostfulHistory && avg != null) {
      await tx.product.update({
        where: { id: product.id },
        data: { averageCost: avg },
      });
    }

    return {
      hasCostfulHistory,
      oldAvgCost: product.averageCost != null ? Number(product.averageCost) : null,
      newAvgCost: avg != null ? Number(avg) : null,
      stockDrift: Number(new Prisma.Decimal(product.currentStock).sub(stock)),
      movementsBackfilled,
    };
  }
}
