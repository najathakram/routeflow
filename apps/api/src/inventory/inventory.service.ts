import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import * as crypto from "crypto";
import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { normalizeBoxesPieces, roundMoney } from "../common/pricing";
import { fetchInvoicedSaleLines, roundQty } from "../common/invoiced-sales";
import { costDecimal, nextAverageCost, planLotConsumption, reverseAverageCost } from "./costing";
import { RecordPurchaseDto } from "./dto/record-purchase.dto";
import { RecordAdjustmentDto } from "./dto/record-adjustment.dto";
import { CommitStockCountDto } from "./dto/commit-stock-count.dto";
import {
  CommitStockCountSessionDto,
  ListStockCountSessionsDto,
  StartStockCountDto,
  UpsertStockCountLineDto,
} from "./dto/stock-count-session.dto";
import { ListMovementsDto } from "./dto/list-movements.dto";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { SetCostBasisDto } from "./dto/set-cost-basis.dto";
import { BulkSetCostBasisDto } from "./dto/bulk-set-cost-basis.dto";
import { RecomputeCostsDto } from "./dto/recompute-costs.dto";
import { VariantAssignDto } from "./dto/variant-assign.dto";
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
  // Public: vendor-bill receive is the main restock path and must fire the
  // same alerts as a manual purchase (it never did — a G7 gap).
  fireStockAlerts(productIds: string[]): void {
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

  // ─── Variant assignment (PR-D) ───────────────────────────────────────────────
  //
  // Moves stock atomically from a generic parent product to its variants.
  // "Unassigned stock" is not new state — it is simply the parent's own
  // currentStock. This is a TRANSFER (paired ADJUSTMENT movements sharing one
  // reference), not a receipt: it must never invent stock, and lots drawn from
  // the parent must exactly match the lots opened on the variants.

  /**
   * A 3-letter-prefix + 4-hex-digit SKU, identical to the auto-generation
   * `ProductsService.create()` uses when the caller omits one
   * (products.service.ts ~393-403) — kept in sync so a hand-rolled variant row
   * (see {@link createVariantRowInTx}) looks the same as one created through
   * the normal product form.
   */
  private generateVariantSku(name: string): string {
    const prefix = name
      .replace(/[^a-zA-Z]/g, "")
      .slice(0, 3)
      .toUpperCase()
      .padEnd(3, "X");
    const suffix = Math.floor(Math.random() * 0xffff)
      .toString(16)
      .toUpperCase()
      .padStart(4, "0");
    return `${prefix}-${suffix}`;
  }

  /**
   * Create a new variant row directly inside the transaction, WITHOUT calling
   * `ProductsService.create()`. That would be the preferred path (it is the
   * one documented inheritance implementation), but wiring `ProductsModule`
   * into `InventoryModule` is outside this package's file list — see the
   * deviation noted for this package. Every field `ProductsService.create()`
   * would have inherited from the parent when the DTO leaves it unset is
   * copied here explicitly instead (products.service.ts ~439-545): price
   * tiers, category, isTobacco, costingMethod, standardCost, unitsPerBox, and
   * the regulated set. `currentStock`/`averageCost` are deliberately NOT set
   * here — same as `create()`, a new variant starts at 0 stock / null cost,
   * and the caller applies this transfer's qty/cost the same way it would for
   * an existing variant.
   */
  private async createVariantRowInTx(
    tx: Prisma.TransactionClient,
    parent: {
      id: string;
      name: string;
      unit: string;
      pricePerUnit: Prisma.Decimal;
      priceTier2: Prisma.Decimal;
      priceTier3: Prisma.Decimal;
      priceTier4: Prisma.Decimal;
      priceTier5: Prisma.Decimal;
      category: string | null;
      isTobacco: boolean;
      costingMethod: CostingMethod;
      standardCost: Prisma.Decimal | null;
      unitsPerBox: number | null;
      trackedCategoryId: string | null;
      trackedSubcategoryId: string | null;
      regItemType: string | null;
      regUomCase: string | null;
      regUomUnit: string | null;
    },
    variantName: string,
  ) {
    return tx.product.create({
      data: {
        name: `${parent.name} - ${variantName}`,
        variantName,
        parentProductId: parent.id,
        sku: this.generateVariantSku(variantName),
        unit: parent.unit,
        pricePerUnit: parent.pricePerUnit,
        priceTier2: parent.priceTier2,
        priceTier3: parent.priceTier3,
        priceTier4: parent.priceTier4,
        priceTier5: parent.priceTier5,
        category: parent.category ?? undefined,
        isTobacco: parent.isTobacco ?? false,
        costingMethod: parent.costingMethod,
        standardCost: parent.standardCost ?? undefined,
        unitsPerBox: parent.unitsPerBox ?? undefined,
        trackedCategoryId: parent.trackedCategoryId ?? null,
        trackedSubcategoryId: parent.trackedSubcategoryId ?? null,
        regItemType: parent.regItemType ?? null,
        regUomCase: parent.regUomCase ?? null,
        regUomUnit: parent.regUomUnit ?? null,
      },
    });
  }

  async assignToVariants(dto: VariantAssignDto, performedById: string) {
    const restockedProductIds: string[] = [];

    const result = await this.prisma.tenantTransaction(
      async (tx) => {
        const parent = await tx.product.findUnique({ where: { id: dto.parentProductId } });
        if (!parent) throw new NotFoundException("Product not found");
        // One level only: a variant of a variant is impossible in this model
        // (mirrors products.service.ts bulkAssignParent's same rejection).
        if (parent.parentProductId != null) {
          throw new BadRequestException("A variant cannot itself be split");
        }

        // Resolve each assignment's qty. Boxes/pieces win over a raw qty —
        // recomputed via normalizeBoxesPieces against the PARENT's
        // unitsPerBox — so a boxed generic can never be assigned as loose
        // pieces. Assignments resolving to 0 (or left blank) are dropped.
        const resolved = dto.assignments
          .map((a) => {
            if (a.boxes != null || a.pieces != null) {
              // A parent with no box packaging has no cases to convert:
              // normalizeBoxesPieces takes its non-boxed branch and reads the
              // (absent) `qty`, so the row would resolve to 0 and be dropped
              // silently. Reject instead of losing the operator's units.
              if (Number(parent.unitsPerBox ?? 0) <= 1) {
                throw new BadRequestException(
                  `"${parent.name}" is not sold in boxes — send qty in base units, not boxes/pieces`,
                );
              }
              return {
                input: a,
                qty: normalizeBoxesPieces({
                  boxes: a.boxes,
                  pieces: a.pieces,
                  unitsPerBox: parent.unitsPerBox,
                }).qty,
              };
            }
            return { input: a, qty: a.qty ?? 0 };
          })
          .filter((r) => r.qty > 0);

        const totalQty = resolved.reduce((s, r) => s + r.qty, 0);

        // Validate the pool INSIDE the transaction, against a freshly-read
        // currentStock — re-validating here is what makes two concurrent
        // assignments of the same generic safe. Never hoist this check out.
        if (totalQty > Number(parent.currentStock)) {
          throw new BadRequestException({
            code: "INSUFFICIENT_UNASSIGNED",
            message: `Only ${parent.currentStock} unassigned in stock; tried to assign ${totalQty}`,
          });
        }
        if (resolved.length === 0) {
          throw new BadRequestException("No assignment resolved to a positive quantity");
        }

        // Resolve every target BEFORE any write: an existing productId must
        // be a child of THIS parent, and a new-variant name must not collide
        // with a sibling — so a later assignment failing can never leave an
        // earlier one's variant half-created (this only matters for the
        // mocked unit tests; a real transaction rolls back regardless).
        const targets: {
          qty: number;
          unitCostOverride?: number;
          existing: {
            id: string;
            variantName: string | null;
            currentStock: Prisma.Decimal;
            averageCost: Prisma.Decimal | null;
            costingMethod: CostingMethod;
          } | null;
          newVariantName: string | null;
        }[] = [];

        // Every target is written from the snapshot read here, so the same
        // target twice would compute both its average cost and its stockAfter
        // from the same pre-write stock — a corrupted average and a movement
        // ledger that no longer reconciles with the product row. Reject the
        // duplicate instead (no UI can produce one: both key rows by id).
        const seenProductIds = new Set<string>();
        const seenNewVariantNames = new Set<string>();

        for (const r of resolved) {
          const { input } = r;
          if (input.productId) {
            if (seenProductIds.has(input.productId)) {
              throw new BadRequestException(
                `Variant ${input.productId} appears more than once — combine those rows into one assignment`,
              );
            }
            seenProductIds.add(input.productId);
            // Stock can only ever move into an ACTIVE child of THIS parent —
            // never into an unrelated product, and never onto a deactivated
            // variant (which is filtered out of every sellable surface, so the
            // units would read as gone).
            const existing = await tx.product.findFirst({
              where: { id: input.productId, parentProductId: parent.id, isActive: true },
            });
            if (!existing) {
              throw new BadRequestException(
                `Product ${input.productId} is not an active variant of this parent`,
              );
            }
            targets.push({
              qty: r.qty,
              unitCostOverride: input.unitCostOverride,
              existing,
              newVariantName: null,
            });
          } else if (input.newVariant) {
            // Two rows asking for the same new name would both clear the
            // collision check (nothing is created yet at check time) and land
            // two identically-named siblings.
            const nameKey = input.newVariant.name.trim().toLowerCase();
            if (seenNewVariantNames.has(nameKey)) {
              throw new BadRequestException(
                `A new variant named "${input.newVariant.name}" appears more than once`,
              );
            }
            seenNewVariantNames.add(nameKey);
            const composedName = `${parent.name} - ${input.newVariant.name}`;
            const nameTaken = await tx.product.findFirst({
              where: {
                parentProductId: parent.id,
                name: { equals: composedName, mode: "insensitive" },
              },
              select: { id: true },
            });
            if (nameTaken) {
              throw new BadRequestException(
                `A variant named "${input.newVariant.name}" already exists for this product`,
              );
            }
            targets.push({
              qty: r.qty,
              unitCostOverride: input.unitCostOverride,
              existing: null,
              newVariantName: input.newVariant.name,
            });
          } else {
            throw new BadRequestException(
              "Each assignment must specify either productId or newVariant",
            );
          }
        }

        // The parent's effective unit cost, resolved by the SAME rule as
        // effectiveValue() (getStockOverview / getValuation): STANDARD reads
        // standardCost first, because recordPurchase deliberately never writes
        // averageCost for a STANDARD product — its averageCost column is
        // normally null forever. Reading the raw column alone would move a
        // STANDARD generic's stock at $0 and silently destroy that value.
        // Null when no cost is known anywhere (see the per-variant guard).
        const parentEffectiveCost =
          parent.costingMethod === CostingMethod.STANDARD
            ? (parent.standardCost ?? parent.averageCost)
            : parent.averageCost;

        // Lots are conserved, not invented: this is a transfer, not a
        // receipt. Draw the parent's lots down for the TOTAL qty being moved,
        // mirroring recordSale's planLotConsumption usage exactly (same
        // helper, same query shape, same post-consumption update). Unlike
        // recordSale this always runs, never gated on costingMethod — a
        // transfer must conserve lots for every costing label, not only the
        // FIFO/LIFO methods recordSale itself draws down for.
        const totalQtyDecimal = new Prisma.Decimal(totalQty);
        const parentLots = await tx.stockLot.findMany({
          where: { productId: parent.id, remainingQty: { gt: 0 } },
          orderBy: { purchaseDate: "asc" },
        });
        const parentFallbackCost = costDecimal(parentEffectiveCost ?? 0);
        const lotPlan = planLotConsumption(parentLots, totalQtyDecimal, parentFallbackCost);
        for (const consumption of lotPlan.consumptions) {
          await tx.stockLot.update({
            where: { id: consumption.id },
            data: { remainingQty: { decrement: consumption.take } },
          });
        }
        // Only the quantity the parent's lots actually covered may be re-lotted
        // on the variant side. `uncovered` is real: a catalog imported with
        // opening stock writes currentStock with no StockLot at all, and
        // opening variant lots for that share would invent lot quantity the
        // parent never gave up. The uncovered remainder simply stays un-lotted,
        // exactly as it was on the parent.
        let lotCredit = totalQtyDecimal.sub(lotPlan.uncovered);

        // One negative ADJUSTMENT on the parent for the TOTAL. The parent's
        // average is NEVER changed by this transfer — removing units at the
        // average cost does not move the average — so the snapshot simply
        // carries the existing average forward.
        const parentStockAfter = parent.currentStock.sub(totalQtyDecimal);
        const reference = `VARIANT_ASSIGN-${crypto.randomUUID()}`;
        const parentNotes = dto.notes
          ? `${dto.notes} — Split into variants`
          : "Split into variants";

        const movementIds: string[] = [];
        const parentMovement = await tx.stockMovement.create({
          data: {
            productId: parent.id,
            type: MovementType.ADJUSTMENT,
            quantity: totalQtyDecimal.neg(),
            avgCostAfter: parent.averageCost ?? null,
            stockAfter: parentStockAfter,
            reference,
            notes: parentNotes,
            performedById,
          },
        });
        movementIds.push(parentMovement.id);

        const assignmentResults: {
          productId: string;
          variantName: string | null;
          qty: number;
          unitCost: number;
          created: boolean;
        }[] = [];

        for (const target of targets) {
          const qtyDecimal = new Prisma.Decimal(target.qty);
          const variant = target.existing
            ? target.existing
            : await this.createVariantRowInTx(tx, parent, target.newVariantName!);

          // Cost: unitCostOverride ?? the parent's EFFECTIVE cost. STANDARD-
          // costed variants are valued from their own operator-set cost, so a
          // transfer must never overwrite it — mirrors recordPurchase and the
          // vendor-bill receive path's identical guard. When no cost is known
          // anywhere the average is left alone too: stamping a fabricated 0
          // would read as a real "$0 cost" in getValuation and drop the
          // variant off the "no cost set" report.
          const resolvedCost = target.unitCostOverride ?? parentEffectiveCost ?? null;
          const unitCost = costDecimal(resolvedCost ?? 0);
          const updatesAverage =
            variant.costingMethod !== CostingMethod.STANDARD && resolvedCost != null;
          const newAvgCost = nextAverageCost(
            variant.currentStock,
            variant.averageCost,
            qtyDecimal,
            unitCost,
          );
          const variantStockAfter = variant.currentStock.add(qtyDecimal);
          const variantNotes = dto.notes
            ? `${dto.notes} — Assigned from ${parent.name}`
            : `Assigned from ${parent.name}`;

          const lotQty = lotCredit.gt(qtyDecimal) ? qtyDecimal : lotCredit;
          if (lotQty.gt(0)) {
            await tx.stockLot.create({
              data: {
                productId: variant.id,
                purchaseDate: new Date(),
                qty: lotQty,
                remainingQty: lotQty,
                unitCost,
                reference,
                notes: variantNotes,
              },
            });
            lotCredit = lotCredit.sub(lotQty);
          }

          const variantMovement = await tx.stockMovement.create({
            data: {
              productId: variant.id,
              type: MovementType.ADJUSTMENT,
              quantity: qtyDecimal,
              unitCost,
              avgCostAfter: updatesAverage ? newAvgCost : (variant.averageCost ?? null),
              stockAfter: variantStockAfter,
              reference,
              notes: variantNotes,
              performedById,
            },
          });
          movementIds.push(variantMovement.id);

          await tx.product.update({
            where: { id: variant.id },
            data: {
              currentStock: { increment: qtyDecimal },
              ...(updatesAverage ? { averageCost: newAvgCost } : {}),
            },
          });

          restockedProductIds.push(variant.id);
          assignmentResults.push({
            productId: variant.id,
            variantName: variant.variantName ?? null,
            qty: target.qty,
            unitCost: Number(unitCost),
            created: !target.existing,
          });
        }

        await tx.product.update({
          where: { id: parent.id },
          data: { currentStock: { decrement: totalQtyDecimal } },
        });

        return {
          reference,
          parentProductId: parent.id,
          parentRemaining: Number(parentStockAfter),
          assignments: assignmentResults,
          movementIds,
        };
      },
      // Serializable, not the Postgres default READ COMMITTED: the pool check
      // is a read-then-write invariant, and at READ COMMITTED two operators
      // splitting the same generic at once would both read the same
      // `currentStock`, both pass, and both decrement — driving the parent
      // negative. Same pattern as credit-notes/invoices/orders.
      { isolationLevel: "Serializable", timeout: 60_000 },
    );

    // Never inside the transaction — the same fire-and-forget rule as every
    // other restocking writer in this service.
    this.fireStockAlerts(restockedProductIds);
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

      const { movementIds, skipped } = await this.applyStockCountItemsInTx(tx, {
        items: dto.items,
        productMap,
        reference,
        effectiveDate,
        notes: dto.notes,
        performedById,
        restockedProductIds,
      });

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
   * The shared body of a stock-count commit: one ADJUSTMENT movement per
   * non-zero delta, the product's stock incremented, and a lot opened for a
   * positive delta. Extracted so the legacy client-session endpoint and the
   * durable-session commit (PR-C) apply IDENTICAL stock semantics — there must
   * never be two commit formulas that can drift apart.
   *
   * `restockedProductIds` is appended in place; the caller fires stock alerts
   * AFTER the transaction commits (never inside it).
   */
  private async applyStockCountItemsInTx(
    tx: Prisma.TransactionClient,
    args: {
      items: Array<{ productId: string; quantity: number; mode: "REPLACE" | "ADD" }>;
      productMap: Map<
        string,
        { id: string; currentStock: Prisma.Decimal; averageCost: Prisma.Decimal | null }
      >;
      reference: string;
      effectiveDate: Date;
      notes?: string;
      performedById: string;
      restockedProductIds: string[];
      /**
       * Costs corrected earlier in THIS transaction (session commits apply
       * `unitCostOverride` first). Passed in rather than re-reading each
       * product: a large count would otherwise add one query per line inside
       * the interactive transaction, pushing a big session toward its timeout.
       */
      correctedCosts?: Map<string, Prisma.Decimal>;
    },
  ): Promise<{ movementIds: string[]; skipped: number }> {
    const { items, productMap, reference, effectiveDate, notes, performedById } = args;
    const movementIds: string[] = [];
    let skipped = 0;
    // Running stock per product so repeated items in one count session
    // produce truthful stockAfter snapshots.
    const runningStock = new Map<string, Prisma.Decimal>();

    for (const item of items) {
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

      const itemNotes = notes
        ? `${notes} (mode=${item.mode} counted=${counted.toString()})`
        : `mode=${item.mode} counted=${counted.toString()}`;

      // A cost corrected earlier in this transaction must be what the movement
      // and any new lot are valued at — otherwise the correction is stamped
      // stale on the very rows it was meant to fix.
      const avgCost = args.correctedCosts?.get(item.productId) ?? product.averageCost ?? null;

      const movement = await tx.stockMovement.create({
        data: {
          productId: item.productId,
          type: MovementType.ADJUSTMENT,
          quantity: delta,
          avgCostAfter: avgCost,
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
            unitCost: avgCost ?? new Prisma.Decimal(0),
            reference,
            notes: itemNotes,
          },
        });
        args.restockedProductIds.push(item.productId);
      }
    }

    return { movementIds, skipped };
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
        // STANDARD products are valued from their operator-set cost, so a receipt
        // must not move averageCost. Mirrors recordPurchase and the vendor-bill
        // receive path, which already guard this (the bill path was fixed for this
        // exact bug class; PO receive was missed).
        const updatesAverage = prod ? prod.costingMethod !== CostingMethod.STANDARD : true;

        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: "PURCHASE",
            quantity: qtyReceived,
            unitCost: itemUnitCost,
            avgCostAfter: updatesAverage ? newAvgCost : (prod?.averageCost ?? null),
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
            data: {
              currentStock: stockAfter,
              ...(updatesAverage ? { averageCost: newAvgCost } : {}),
            },
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

  // ─── Durable stock-count sessions (PR-C) ────────────────────────────────────
  //
  // Before this, a count lived only in the counter's browser/app storage: it
  // could not be resumed on another device, had no attribution, and left no
  // history. These make the session a first-class server object. The pre-existing
  // one-shot `commitStockCount` above is untouched and still works.

  /** Shape returned for one line, with everything the review screen needs. */
  private stockCountLineSelect() {
    return {
      id: true,
      productId: true,
      mode: true,
      countedQty: true,
      boxes: true,
      pieces: true,
      expectedQty: true,
      unitCostOverride: true,
      countedById: true,
      updatedAt: true,
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          unitsPerBox: true,
          currentStock: true,
          averageCost: true,
        },
      },
    } as const;
  }

  async startStockCountSession(dto: StartStockCountDto, user: { sub: string }) {
    // A pre-existing OPEN session is a WARNING, never a lock: two people
    // counting different aisles must not block each other. The client shows
    // "you already have a count open — open it instead?" and decides.
    const openSessions = await this.prisma.forTenant().stockCountSession.findMany({
      where: { status: { in: ["OPEN", "REVIEW"] } },
      select: { id: true, name: true, startedAt: true, startedById: true },
      orderBy: { startedAt: "desc" },
      take: 5,
    });

    let seedLines: Array<{
      productId: string;
      countedQty: Prisma.Decimal;
      boxes: number | null;
      pieces: number | null;
      mode: "REPLACE" | "ADD";
    }> = [];
    if (dto.amendsSessionId) {
      const source = await this.prisma.forTenant().stockCountSession.findUnique({
        where: { id: dto.amendsSessionId },
        include: { lines: true },
      });
      if (!source) throw new NotFoundException("Stock count session not found");
      if (source.status !== "COMMITTED") {
        throw new BadRequestException("Only a committed count can be amended");
      }
      seedLines = source.lines.map((l) => ({
        productId: l.productId,
        countedQty: l.countedQty,
        boxes: l.boxes,
        pieces: l.pieces,
        mode: l.mode as "REPLACE" | "ADD",
      }));
    }

    const session = await this.prisma.tenantTransaction(async (tx) => {
      const created = await tx.stockCountSession.create({
        data: {
          name: dto.name ?? null,
          startedById: user.sub,
          amendsSessionId: dto.amendsSessionId ?? null,
        },
      });
      if (seedLines.length > 0) {
        // Re-snapshot `expectedQty` from CURRENT stock: an amendment corrects
        // today's on-hand, so comparing against the original session's stale
        // expectation would reproduce the old variance instead of the real one.
        const products = await tx.product.findMany({
          where: { id: { in: seedLines.map((l) => l.productId) } },
          select: { id: true, currentStock: true },
        });
        const stockById = new Map(products.map((p) => [p.id, p.currentStock]));
        for (const line of seedLines) {
          // Written one-by-one, NOT nested under the session create: a nested
          // write bypasses the tenant extension's tenantId injection and the
          // row would land with tenantId = null, invisible to forTenant().
          await tx.stockCountLine.create({
            data: {
              sessionId: created.id,
              productId: line.productId,
              mode: line.mode,
              countedQty: line.countedQty,
              boxes: line.boxes,
              pieces: line.pieces,
              expectedQty: stockById.get(line.productId) ?? new Prisma.Decimal(0),
              countedById: user.sub,
            },
          });
        }
      }
      return created;
    });

    return { ...session, otherOpenSessions: openSessions };
  }

  async listStockCountSessions(dto: ListStockCountSessionsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const where: Prisma.StockCountSessionWhereInput = {};
    if (dto.status) where.status = dto.status;

    const [rows, total] = await Promise.all([
      this.prisma.forTenant().stockCountSession.findMany({
        where,
        include: {
          startedBy: { select: { id: true, username: true } },
          committedBy: { select: { id: true, username: true } },
          _count: { select: { lines: true } },
          // Net variance $ is a headline column of the history list, so it is
          // computed HERE rather than left to the client — a list of sessions
          // would otherwise need one detail fetch per row (N+1) to show it.
          // Only the four fields the sum needs are selected, and the lines
          // themselves are dropped from the response below.
          lines: {
            select: {
              mode: true,
              countedQty: true,
              expectedQty: true,
              product: { select: { averageCost: true } },
            },
          },
        },
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.forTenant().stockCountSession.count({ where }),
    ]);

    const data = rows.map(({ lines, ...session }) => {
      // Same delta rule the commit applies: REPLACE = counted − expected,
      // ADD = counted. Valued at the product's CURRENT average cost, never a
      // line's unitCostOverride (that sets the basis going forward; it does
      // not change what today's variance is worth).
      const netVarianceMoney = roundMoney(
        lines.reduce((sum, l) => {
          const counted = Number(l.countedQty);
          const delta = l.mode === "ADD" ? counted : counted - Number(l.expectedQty);
          return sum + delta * Number(l.product?.averageCost ?? 0);
        }, 0),
      );
      return { ...session, netVarianceMoney };
    });

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getStockCountSession(id: string) {
    const session = await this.prisma.forTenant().stockCountSession.findUnique({
      where: { id },
      include: {
        startedBy: { select: { id: true, username: true } },
        committedBy: { select: { id: true, username: true } },
        lines: { select: this.stockCountLineSelect(), orderBy: { updatedAt: "desc" } },
      },
    });
    if (!session) throw new NotFoundException("Stock count session not found");
    return session;
  }

  /** Guard: a count can only be edited while it is still OPEN or in REVIEW. */
  private async loadEditableSession(id: string) {
    const session = await this.prisma.forTenant().stockCountSession.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!session) throw new NotFoundException("Stock count session not found");
    if (session.status === "COMMITTED") {
      throw new BadRequestException(
        "This count is already committed — amend it to make a correction",
      );
    }
    if (session.status === "DISCARDED") {
      throw new BadRequestException("This count was discarded");
    }
    return session;
  }

  /**
   * Autosave one counted line (the scan path calls this per scan, debounced).
   * Idempotent by `@@unique([sessionId, productId])`, so a retry after a dropped
   * connection can never create a duplicate line — but note `increment: true`
   * is by definition NOT idempotent, which is why the client sends the running
   * total for edits and only uses increment for a live scan.
   */
  async upsertStockCountLine(
    sessionId: string,
    dto: UpsertStockCountLineDto,
    user: { sub: string },
  ) {
    await this.loadEditableSession(sessionId);

    const product = await this.prisma.forTenant().product.findUnique({
      where: { id: dto.productId },
      select: { id: true, currentStock: true, unitsPerBox: true },
    });
    if (!product) throw new NotFoundException("Product not found");

    // Boxes/pieces win when present — the server recomputes qty from the split
    // exactly like the order builders, so a boxed product is never miscounted
    // as loose pieces.
    const upb = Number(product.unitsPerBox ?? 0);
    const fromSplit =
      dto.boxes != null || dto.pieces != null
        ? normalizeBoxesPieces({ boxes: dto.boxes, pieces: dto.pieces, unitsPerBox: upb })
        : null;
    const incoming = fromSplit ? fromSplit.qty : (dto.countedQty ?? 0);

    return this.prisma.tenantTransaction(async (tx) => {
      const existing = await tx.stockCountLine.findUnique({
        where: { sessionId_productId: { sessionId, productId: dto.productId } },
      });

      const countedQty = dto.increment
        ? new Prisma.Decimal(existing?.countedQty ?? 0).add(incoming)
        : new Prisma.Decimal(incoming);

      const data = {
        mode: dto.mode ?? existing?.mode ?? "REPLACE",
        countedQty,
        boxes: fromSplit ? fromSplit.boxes : (dto.boxes ?? existing?.boxes ?? null),
        pieces: fromSplit ? fromSplit.pieces : (dto.pieces ?? existing?.pieces ?? null),
        countedById: user.sub,
        ...(dto.unitCostOverride !== undefined
          ? {
              unitCostOverride:
                dto.unitCostOverride === null ? null : costDecimal(dto.unitCostOverride),
            }
          : {}),
      };

      if (existing) {
        return tx.stockCountLine.update({
          where: { id: existing.id },
          data,
          select: this.stockCountLineSelect(),
        });
      }
      return tx.stockCountLine.create({
        data: {
          sessionId,
          productId: dto.productId,
          // Snapshot on FIRST count only: the variance must mean "what changed
          // since you started counting", not silently track stock moving under
          // the counter mid-session.
          expectedQty: product.currentStock,
          ...data,
        },
        select: this.stockCountLineSelect(),
      });
    });
  }

  async removeStockCountLine(sessionId: string, productId: string) {
    await this.loadEditableSession(sessionId);
    await this.prisma.forTenant().stockCountLine.deleteMany({ where: { sessionId, productId } });
    return { removed: true };
  }

  async discardStockCountSession(id: string) {
    await this.loadEditableSession(id);
    return this.prisma.forTenant().stockCountSession.update({
      where: { id },
      data: { status: "DISCARDED", discardedAt: new Date() },
    });
  }

  /**
   * Commit a durable session. Uncounted products are NEVER touched — a count
   * only asserts what it actually saw.
   *
   * Ordering is deliberate: a line's `unitCostOverride` is applied BEFORE its
   * quantity adjustment, so the ADJUSTMENT movement's `avgCostAfter` and any
   * lot opened for a positive delta are valued at the CORRECTED cost. Applying
   * it after would stamp the stale cost onto both.
   */
  async commitStockCountSession(
    id: string,
    dto: CommitStockCountSessionDto,
    user: { sub: string },
  ) {
    const session = await this.prisma.forTenant().stockCountSession.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!session) throw new NotFoundException("Stock count session not found");
    if (session.status === "DISCARDED") {
      throw new BadRequestException("This count was discarded");
    }
    if (session.status === "COMMITTED") {
      // Idempotent: a client whose response was lost must not double-apply.
      return {
        sessionId: id,
        reference: session.movementReference,
        applied: 0,
        skipped: session.lines.length,
        movementIds: [],
        alreadyCommitted: true,
      };
    }
    if (session.lines.length === 0) {
      throw new BadRequestException("Nothing counted yet");
    }

    const productIds = Array.from(new Set(session.lines.map((l) => l.productId)));
    const products = await this.prisma
      .forTenant()
      .product.findMany({ where: { id: { in: productIds } } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const missingProductIds = productIds.filter((pid) => !productMap.has(pid));
    if (missingProductIds.length > 0) {
      throw new NotFoundException({
        message: "One or more products could not be found",
        missingProductIds,
      });
    }

    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();
    const reference = `STOCK_COUNT-${id}`;
    const restockedProductIds: string[] = [];

    const result = await this.prisma.tenantTransaction(
      async (tx) => {
        // Same guard as the legacy path: if movements already carry this
        // reference, the commit landed and only the response was lost.
        const already = await tx.stockMovement.findMany({
          where: { reference },
          select: { id: true },
        });
        if (already.length > 0) {
          return {
            sessionId: id,
            reference,
            applied: already.length,
            skipped: 0,
            movementIds: already.map((m) => m.id),
            costMovementIds: [] as string[],
            alreadyCommitted: true,
          };
        }

        // 1) Cost corrections first — see the ordering note above.
        const costMovementIds: string[] = [];
        const correctedCosts = new Map<string, Prisma.Decimal>();
        for (const line of session.lines) {
          if (line.unitCostOverride == null) continue;
          const unitCost = costDecimal(Number(line.unitCostOverride));
          const movement = await this.setCostBasisInTx(
            tx,
            productMap.get(line.productId)!,
            {
              unitCost: Number(line.unitCostOverride),
              notes: `Stock count ${reference}`,
            } as SetCostBasisDto,
            user.sub,
          );
          costMovementIds.push(movement.id);
          correctedCosts.set(line.productId, unitCost);
        }

        // 2) Then the quantity adjustments, through the SHARED routine so the
        //    durable path can never drift from the legacy one.
        const { movementIds, skipped } = await this.applyStockCountItemsInTx(tx, {
          items: session.lines.map((l) => ({
            productId: l.productId,
            quantity: Number(l.countedQty),
            mode: l.mode as "REPLACE" | "ADD",
          })),
          productMap,
          reference,
          effectiveDate,
          notes: dto.notes,
          performedById: user.sub,
          restockedProductIds,
          correctedCosts,
        });

        await tx.stockCountSession.update({
          where: { id },
          data: {
            status: "COMMITTED",
            committedAt: new Date(),
            committedById: user.sub,
            movementReference: reference,
            ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          },
        });

        return {
          sessionId: id,
          reference,
          applied: movementIds.length,
          skipped,
          movementIds,
          costMovementIds,
        };
      },
      // A warehouse-wide count is hundreds of lines, each doing a movement
      // create + product update (+ a lot on a positive delta). Prisma's 5s
      // default would abort a real audit part-way; the whole commit must be
      // all-or-nothing.
      { timeout: 120_000 },
    );

    this.fireStockAlerts(restockedProductIds);
    return result;
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
  // Public: the backdated-movement repair primitive. Every stock writer that
  // supports an effective date in the past (manual purchase, adjustment, and
  // now vendor-bill receive stamping at billDate) must replay the product so
  // later snapshots stay true.
  async recomputeProductInTx(tx: Prisma.TransactionClient, productId: string) {
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
