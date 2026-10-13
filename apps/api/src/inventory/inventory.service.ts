import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockProductsForStock } from "../common/product-locks";
import { productNameViolation } from "../common/text-cell-guards";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { assertSellableLines } from "../products/sellable-lines";
import { syncCategoryLabel } from "../product-categories/label-writer";
import {
  assertParentUsable,
  parentInvalid,
  PRODUCT_PARENT_REASONS,
} from "../products/product-parent";
import type { PurchaseOrderReceipt } from "@routeflow/types";
import * as crypto from "crypto";
import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import {
  familyPricesForNewVariant,
  lockFamilyRow,
  readFamilyPriceMode,
} from "../products/family-price";
import { linePack, normalizeBoxesPieces, roundMoney } from "@routeflow/pricing";
import { fetchInvoicedSaleLines, roundQty } from "../common/invoiced-sales";
import { poLineFromInput } from "./po-line-input";
import { costDecimal, nextAverageCost, planLotConsumption, reverseAverageCost } from "./costing";
import { recordSaleMovement, resolveSaleCost } from "./sale-movement";
import { RecordPurchaseDto } from "./dto/record-purchase.dto";
import { RecordAdjustmentDto } from "./dto/record-adjustment.dto";
import { CommitStockCountDto } from "./dto/commit-stock-count.dto";
import {
  CommitStockCountSessionDto,
  ListStockCountSessionsDto,
  StartStockCountDto,
  UpsertStockCountLineDto,
} from "./dto/stock-count-session.dto";
import { buildMovementsWhere } from "./movements-where";
import { ListMovementsDto } from "./dto/list-movements.dto";
import { ListPurchaseOrdersDto } from "./dto/list-purchase-orders.dto";
import { UpdatePurchaseOrderDto } from "./dto/update-purchase-order.dto";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { SetCostBasisDto } from "./dto/set-cost-basis.dto";
import { BulkSetCostBasisDto } from "./dto/bulk-set-cost-basis.dto";
import { RecomputeCostsDto } from "./dto/recompute-costs.dto";
import { VariantAssignDto } from "./dto/variant-assign.dto";
import { retryStockTx, stockTxRetryState } from "../common/tx-retry";
import {
  advisoryXactLock,
  LockUnavailableError,
  tryAdvisoryXactLockShared,
  withAdvisoryLock,
  type LockResult,
} from "../common/db-locks";
import {
  absoluteCountChanged,
  COUNT_COMMIT_BATCH,
  COUNT_LOCK_ATTEMPTS,
  COUNT_LOCK_RETRY_MS,
  computeCommitProgress,
  OPEN_COUNT_STATUSES,
  productInOpenCount,
  roundCountQty,
  STOCK_COUNT_LOCK_FAMILY,
  STOCK_COUNT_PRODUCT_LOCK_FAMILY,
  stockCountCommitting,
  stockCountReference,
  stockCountSkipNote,
  type OpenCountConflict,
  type StockCountCommitOutcome,
  type StockCountCommitProgress,
  type StockCountSkippedProduct,
  type StockCountSkipReason,
} from "./stock-count-commit";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { AuditService } from "../audit/audit.service";

/**
 * Interactive-tx options of a count add / amend (SA-767 r-note 5 SA-3). The product-lock helper bounds its
 * wait with `lock_timeout` 5 s (STOCK_LOCK_TIMEOUT); Prisma's default tx timeout is also 5 s, so a stuck
 * holder would surface as an unmapped P2028 500. 15 s lets the 5 s lock timeout fire first (55P03 -> 503).
 */
const COUNT_ADD_TX_OPTIONS = { timeout: 15_000 } as const;

/** B562 PR-3 (SA-136 §4): the reference prefix of a replay's own COST_BASIS correction. */
export const REPLAY_CORRECTION_PREFIX = "RECOMPUTE:";
/**
 * A replay correction is the fold's OUTPUT, never an input (see replayProduct). SA-372: all three
 * marks are required — a COST_BASIS row, quantity 0, and the `RECOMPUTE:` reference — so a manual
 * or `B562:REPAIR:` cost-basis row (or any other movement) can never be skipped as one.
 */
export const isReplayCorrection = (m: {
  type: string;
  quantity: Prisma.Decimal | number | string;
  reference: string | null | undefined;
}) =>
  m.type === MovementType.COST_BASIS &&
  new Prisma.Decimal(m.quantity).isZero() &&
  (m.reference?.startsWith(REPLAY_CORRECTION_PREFIX) ?? false);
/** Clock-skew allowance for a client-sent "now" effective date. */
const EFFECTIVE_DATE_SKEW_MS = 5 * 60 * 1000;
/**
 * B562 PR-3: a stock write's accounting date — the given `effectiveDate` or now. A FUTURE date is
 * refused: it would sort after every real row still to come, so each later write would count it as
 * "newer" and replay against a movement that has not happened yet.
 */
export function effectiveDateOf(raw: string | undefined, now = new Date()): Date {
  if (!raw) return now;
  const date = new Date(raw);
  if (date.getTime() > now.getTime() + EFFECTIVE_DATE_SKEW_MS) {
    throw new BadRequestException("The effective date can't be in the future.");
  }
  return date;
}
/** Averages closer than this are the same cost (costDecimal keeps 4dp). */
const AVG_CORRECTION_EPSILON = new Prisma.Decimal("0.0001");

/** The slice of a StockCountLine a batch commit reads. */
interface StockCountBatchLine {
  id: string;
  productId: string;
  mode: string;
  countedQty: Prisma.Decimal;
  expectedQty: Prisma.Decimal;
  unitCostOverride: Prisma.Decimal | null;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stockAlerts: StockAlertService,
    // B562 PR-3: the recompute-costs apply path writes its own audit row (global AuditModule).
    @Optional() private readonly audit?: AuditService,
    // #2717 M2 (SA-574 Q2): the `mixed_packs` mode read; absent = "off" (today's behavior).
    @Optional() private readonly featureConfig?: FeatureConfigService,
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

    const where = buildMovementsWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.forTenant().stockMovement.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
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
    assertSellableLines([product]); // WS8: a FAMILY is never stocked (no StockLot / StockMovement)

    if (dto.supplierId) {
      const supplier = await this.prisma
        .forTenant()
        .supplier.findUnique({ where: { id: dto.supplierId } });
      if (!supplier) throw new NotFoundException("Supplier not found");
    }

    // Boxed payloads convert to pieces up front; a bare `quantity` KEEPS
    // meaning pieces (existing callers must be untouched). Mirrors
    // vendor-bills' lineInventoryDelta contract: everything below this line
    // is PIECES.
    const explicitBoxed = dto.boxes != null || dto.pieces != null;
    const qtyPieces = explicitBoxed
      ? normalizeBoxesPieces({
          boxes: dto.boxes,
          pieces: dto.pieces,
          unitsPerBox: product.unitsPerBox,
        }).qty
      : (dto.quantity ?? 0);
    if (!(qtyPieces > 0)) {
      throw new BadRequestException("Purchase quantity must be greater than zero");
    }

    // dto.unitCost is quoted per SELLING UNIT — a box when the payload is
    // explicitly boxed (mirrors the box-priced selling convention in
    // @routeflow/pricing), a piece otherwise. Convert to per-piece before AVCO
    // math, since Product.averageCost is contractually per piece.
    const rawUnitCost = costDecimal(dto.unitCost);
    const unitsPerBox = Number(product.unitsPerBox ?? 0);
    const unitCost =
      explicitBoxed && unitsPerBox > 1 ? costDecimal(rawUnitCost.div(unitsPerBox)) : rawUnitCost;

    const qty = new Prisma.Decimal(qtyPieces);
    const effectiveDate = effectiveDateOf(dto.effectiveDate);

    // SA-767 L-2 (B286 / #2840): lock the product, THEN read the stock and average the blend comes
    // from, inside the tx. The read above only validates (existence, sellable, pack size): a purchase
    // committing in between would have its blend overwritten by an absolute value computed from it.
    // The whole tx re-runs on a 40P01 / 40001 / P2034 (nothing is captured across attempts); the
    // alert fires after the commit.
    const result = await retryStockTx("inventory.recordPurchase", () =>
      this.prisma.tenantTransaction(async (tx) => {
        await this.lockProducts(tx, [dto.productId]);
        const locked = await tx.product.findUnique({
          where: { id: dto.productId },
          select: { currentStock: true, averageCost: true, costingMethod: true },
        });
        if (!locked) throw new NotFoundException("Product not found");

        // New weighted average (used for AVCO; FIFO/LIFO still update for display)
        const newAvgCost = nextAverageCost(locked.currentStock, locked.averageCost, qty, unitCost);
        const updatesAverage = locked.costingMethod !== CostingMethod.STANDARD;
        const avgCostAfter = updatesAverage ? newAvgCost : (locked.averageCost ?? null);

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

        // Update stock and cost based on costing method
        const costUpdate: any = { currentStock: { increment: qty } };
        if (updatesAverage) {
          // For FIFO/LIFO we still store the running average in averageCost for reference
          costUpdate.averageCost = newAvgCost;
        }
        // STANDARD: don't touch averageCost

        // B562 PR-3: snapshots are write-once now (SA-136 §4), so `stockAfter` is the counter this
        // update RETURNED (SA-136 §1), never a read made before it — the row is written after it.
        const updated = await tx.product.update({
          where: { id: dto.productId },
          data: costUpdate,
          select: { currentStock: true },
        });

        const movement = await tx.stockMovement.create({
          data: {
            productId: dto.productId,
            type: MovementType.PURCHASE,
            quantity: qty,
            unitCost,
            avgCostAfter,
            stockAfter: updated.currentStock,
            supplierId: dto.supplierId,
            reference: dto.reference,
            notes: dto.notes,
            performedById,
            // B562: the effective date is the accounting date; createdAt stays write-once.
            effectiveAt: effectiveDate,
          },
        });

        // A backdated purchase can change the average every later row implies. Later snapshots stay
        // as written (SA-136 §4); the replay appends one dated COST_BASIS correction if needed.
        const newer = await tx.stockMovement.count({
          where: { productId: dto.productId, effectiveAt: { gt: effectiveDate } },
        });
        if (newer > 0) {
          await this.recomputeProductInTx(tx, dto.productId, {
            trigger: `PURCHASE:${movement.id}`,
            performedById,
          });
        }

        return movement;
      }),
    );

    this.fireStockAlerts([dto.productId]);
    return result;
  }

  async recordAdjustment(dto: RecordAdjustmentDto, performedById: string) {
    const product = await this.prisma
      .forTenant()
      .product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException("Product not found");
    assertSellableLines([product]); // WS8: a FAMILY is never stocked (no StockLot / StockMovement)

    const qty = new Prisma.Decimal(dto.quantity);
    const effectiveDate = effectiveDateOf(dto.effectiveDate);

    // SA-767 L-2: lock the product, then read the average the movement and the new lot are stamped
    // with INSIDE the tx (a purchase committing since the read above has moved it). The whole tx
    // re-runs on a 40P01 / 40001 / P2034; nothing is captured across attempts.
    const result = await retryStockTx("inventory.recordAdjustment", () =>
      this.prisma.tenantTransaction(async (tx) => {
        await this.lockProducts(tx, [dto.productId]);
        const locked = await tx.product.findUnique({
          where: { id: dto.productId },
          select: { averageCost: true },
        });
        if (!locked) throw new NotFoundException("Product not found");

        // B562 PR-3: `stockAfter` from the update's own returned row (SA-136 §1) — write-once now.
        const updated = await tx.product.update({
          where: { id: dto.productId },
          data: { currentStock: { increment: qty } },
          select: { currentStock: true },
        });

        const movement = await tx.stockMovement.create({
          data: {
            productId: dto.productId,
            type: MovementType.ADJUSTMENT,
            quantity: qty,
            // Quantity-only adjustments never move the average
            avgCostAfter: locked.averageCost ?? null,
            stockAfter: updated.currentStock,
            reference: dto.reference,
            notes: dto.notes,
            performedById,
            // B562: the effective date is the accounting date; createdAt stays write-once.
            effectiveAt: effectiveDate,
          },
        });

        // If positive adjustment, add to lots
        if (qty.gt(0)) {
          await tx.stockLot.create({
            data: {
              productId: dto.productId,
              purchaseDate: effectiveDate,
              qty,
              remainingQty: qty,
              unitCost: locked.averageCost ?? new Prisma.Decimal(0),
              reference: dto.reference ?? "ADJUSTMENT",
              notes: dto.notes,
            },
          });
        }

        // Backdated adjustment: the replay appends a dated correction if the average moved (§4)
        const newer = await tx.stockMovement.count({
          where: { productId: dto.productId, effectiveAt: { gt: effectiveDate } },
        });
        if (newer > 0) {
          await this.recomputeProductInTx(tx, dto.productId, {
            trigger: `ADJUSTMENT:${movement.id}`,
            performedById,
          });
        }

        return movement;
      }),
    );

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
    familyMode: "on" | "off" = "off",
  ) {
    // #2717 M2: mode on -> the family's five columns, re-read under its row lock (the `parent` this
    // tx read earlier may predate a family edit); off -> the parent row exactly as before.
    const tenantId = this.prisma.getTenantId();
    const priceColumns =
      familyMode === "on" && tenantId
        ? await familyPricesForNewVariant(tx, { tenantId, familyId: parent.id, dto: {} })
        : {
            pricePerUnit: parent.pricePerUnit,
            priceTier2: parent.priceTier2,
            priceTier3: parent.priceTier3,
            priceTier4: parent.priceTier4,
            priceTier5: parent.priceTier5,
          };
    const created = await tx.product.create({
      data: {
        name: `${parent.name} - ${variantName}`,
        variantName,
        parentProductId: parent.id,
        sku: this.generateVariantSku(variantName),
        unit: parent.unit,
        ...priceColumns,
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
    // The variant copied its parent's category text: add-only label sync, same tx.
    await syncCategoryLabel(tx, { tenantId, productId: created.id, text: created.category });
    return created;
  }

  async assignToVariants(dto: VariantAssignDto, performedById: string) {
    // B964-2: a NEW variant's name becomes Product.name / variantName: refuse a formula-led one with a coded 400 that names the
    // row, before any lock, transaction or write.
    dto.assignments.forEach((a, index) => {
      const violation = a.newVariant
        ? productNameViolation({ variantName: a.newVariant.name })
        : null;
      if (violation) {
        throw new BadRequestException({
          statusCode: 400,
          code: API_ERROR_CODES.TEXT_CELL_FORMULA_LEAD,
          field: "variantName",
          index,
          message: violation,
          error: "Bad Request",
        });
      }
    });
    const restockedProductIds: string[] = [];
    const familyMode = await readFamilyPriceMode(this.featureConfig, this.prisma.getTenantId());

    // SA-587e: the family-first lock order removes the deadlock, not a plain 40001/P2034 on the
    // Serializable tx, so the WHOLE attempt is retried (SA-767 L-2: through retryStockTx, so the
    // exhausted attempts are a coded 503 LOCK_UNAVAILABLE). The array is cleared at the start of each
    // attempt (a rolled-back attempt must not leak ids); alerts fire once, after the commit.
    const result = await retryStockTx("inventory.assignToVariants", () =>
      this.prisma.tenantTransaction(
        async (tx) => {
          restockedProductIds.length = 0;
          // #2717 M2 (SA-584 B1, house lock order: family -> recipe product -> variant rows): with the
          // family price authority on, take the FAMILY row before anything else. The target loop writes
          // existing variants (row lock V) and a NEW variant reads the family under FOR UPDATE
          // (`familyPricesForNewVariant`); a family price edit holds F and then writes V, so V -> F here
          // against F -> V there is a 40P01. Taken before the parent read too (lock first, read after).
          const lockTenantId = this.prisma.getTenantId();
          if (familyMode === "on" && lockTenantId) {
            await lockFamilyRow(tx, lockTenantId, dto.parentProductId);
          }
          // SA-767 L-2: then the parent and every EXISTING target variant through the one stock lock
          // (house order: family role -> rest), before any Product value is read. New variants are
          // created below and need no lock.
          await this.lockProducts(tx, [
            dto.parentProductId,
            ...dto.assignments.flatMap((a) => (a.productId ? [a.productId] : [])),
          ]);
          const parent = await tx.product.findUnique({ where: { id: dto.parentProductId } });
          if (!parent) {
            throw parentInvalid(PRODUCT_PARENT_REASONS.NOT_FOUND, "Parent product not found");
          }
          // B1211: the same parent rule create() / update() / bulkAssignParent() apply, on the row just read under the
          // lock above (tenant-scoped by the transaction): an inactive product or a variant (one level only: a variant
          // of a variant is impossible in this model, so a variant cannot itself be split) is not a usable parent.
          assertParentUsable(parent);

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
              code: API_ERROR_CODES.INSUFFICIENT_UNASSIGNED,
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
              : await this.createVariantRowInTx(tx, parent, target.newVariantName!, familyMode);

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
      ),
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
    assertSellableLines(products); // WS8: a counted FAMILY would drain phantom stock into its variants

    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();
    const reference = `STOCK_COUNT-${dto.sessionId}`;
    const restockedProductIds: string[] = [];

    // SA-767 L-2: every counted product is locked in one statement, THEN read inside the tx, so the
    // REPLACE delta is `counted - the locked stock` (not the stock read above, which a sale may have
    // moved). The whole tx re-runs on a 40P01 / 40001 / P2034: the id list is cleared per attempt and
    // the alerts fire once, after the commit.
    const result = await retryStockTx("inventory.commitStockCount", () =>
      this.prisma.tenantTransaction(async (tx) => {
        restockedProductIds.length = 0;
        await this.lockProducts(tx, productIds);
        const lockedMap = await this.readLockedStockRows(tx, productIds);

        // Idempotency: a client whose response was lost (timeout / 502) may re-post
        // the SAME sessionId. Without this, every ADD delta would be applied twice
        // and lots duplicated. If this session already wrote movements, return the
        // prior result instead of re-applying. Read AFTER the lock, so a duplicate that
        // waited behind the first commit sees its movements.
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
          lockedMap,
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
      }),
    );

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
   * SA-767 L-2: the caller has LOCKED every counted product and read `lockedMap` in its own tx
   * (`lockProducts` then `readLockedStockRows`), so a REPLACE delta is `counted - the locked stock`.
   * The counter moves by that delta as an increment and each movement's `stockAfter` is the counter
   * the update RETURNED (SA-136 §1), never the value the delta was computed from.
   *
   * `restockedProductIds` is appended in place; the caller fires stock alerts
   * AFTER the transaction commits (never inside it).
   */
  private async applyStockCountItemsInTx(
    tx: Prisma.TransactionClient,
    args: {
      items: Array<{
        productId: string;
        quantity: number;
        mode: "REPLACE" | "ADD";
        /**
         * A durable-session line's snapshot of the stock when it was counted. Set ⇒ REPLACE is
         * `counted - expectedQty` (a sale that landed after the count survives); unset (the legacy
         * client-session path has no snapshot) ⇒ `counted - the locked stock`.
         */
        expectedQty?: Prisma.Decimal;
      }>;
      lockedMap: Map<
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
    const { items, lockedMap, reference, effectiveDate, notes, performedById } = args;
    const movementIds: string[] = [];
    let skipped = 0;
    // Running stock per product so repeated items in one count session
    // produce truthful deltas against the stock left by the previous item.
    const runningStock = new Map<string, Prisma.Decimal>();

    for (const item of items) {
      const product = lockedMap.get(item.productId);
      if (!product) throw new NotFoundException("Product not found");
      const stockBefore =
        item.expectedQty ?? runningStock.get(item.productId) ?? product.currentStock;
      const counted = new Prisma.Decimal(item.quantity);
      const delta = item.mode === "REPLACE" ? counted.minus(stockBefore) : counted;

      if (delta.eq(0)) {
        skipped += 1;
        continue;
      }

      const itemNotes = notes
        ? `${notes} (mode=${item.mode} counted=${counted.toString()})`
        : `mode=${item.mode} counted=${counted.toString()}`;

      // A cost corrected earlier in this transaction must be what the movement
      // and any new lot are valued at — otherwise the correction is stamped
      // stale on the very rows it was meant to fix.
      const avgCost = args.correctedCosts?.get(item.productId) ?? product.averageCost ?? null;

      const updated = await tx.product.update({
        where: { id: item.productId },
        data: { currentStock: { increment: delta } },
        select: { currentStock: true },
      });
      const stockAfter = updated.currentStock;
      runningStock.set(item.productId, stockAfter);

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
          // B562: the count's effective date is the accounting date; createdAt stays write-once.
          effectiveAt: effectiveDate,
        },
      });
      movementIds.push(movement.id);

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
    // SA-767 L-2: a no-op when the caller already holds the row (the live order paths lock first); it keeps
    // this writer safe if it is ever called on its own.
    await this.lockProducts(tx, [productId]);
    // B562 PR-2: the cost resolver and the SALE row writer live in sale-movement.ts, shared with
    // the order stock paths (orders/order-stock.ts) so a sale is costed one way everywhere.
    // SA-136b: the row is written AFTER the counter moves, with `stockAfter` read off the update's
    // own returned row — never a pre-read (a concurrent writer between the two would falsify it).
    const cost = await resolveSaleCost(tx, productId, quantity);
    const { unitCost, lotConsumptions } = cost;

    const updated = await tx.product.update({
      where: { id: productId },
      data: { currentStock: { decrement: quantity } },
      select: { currentStock: true },
    });
    const stockAfter = updated.currentStock;

    await recordSaleMovement(tx, {
      productId,
      quantity: quantity.neg(),
      stockAfter,
      reference,
      performedById,
      cost,
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
  private async nextPoNumber(
    client: Pick<Prisma.TransactionClient, "purchaseOrder"> = this.prisma.forTenant() as never,
  ): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `PO-${year}-`;
    const last = await client.purchaseOrder.findFirst({
      where: { poNumber: { startsWith: prefix } },
      orderBy: { poNumber: "desc" },
    });
    const seq = last ? parseInt(last.poNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  /**
   * Create a DRAFT purchase order inside a caller's tenant transaction — the
   * "raise a PO from a scanned bill" path (units/PO step 7). Two documents, ruled:
   * the PO is what moves stock (send → receive, unchanged); the bill linked to it
   * is money only. Lines arrive in the PO's denomination — PIECES and a per-PIECE
   * cost — with the supplier's own SKU / pack size carried through for display.
   * Running in the caller's transaction means the bill and its PO are created, or
   * not created, together.
   */
  async createDraftPurchaseOrderInTx(
    tx: Prisma.TransactionClient,
    input: {
      supplierId: string;
      notes?: string | null;
      lines: {
        productId: string;
        qtyOrdered: Prisma.Decimal;
        unitCost: Prisma.Decimal;
        /**
         * INTERNAL CALLERS ONLY, never a DTO field (a client must never name a stored total).
         * The bill line's EXACT total (invoice denomination): a bill entered per case must not be re-derived as
         * pieces x the 4 dp per-piece cost (the same drift as a case-entered PO). Falls back to the product.
         */
        totalCost?: number;
        sku?: string | null;
        packSize?: number | null;
      }[];
    },
  ) {
    if (input.lines.length === 0) throw new BadRequestException("At least one item is required");

    // The same checks createPurchaseOrder makes — this path is reachable from a bill
    // whose lines are deliberately loose (a bill legitimately carries negative
    // discount/deposit lines), and a PO line must be a real, positive purchase.
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier) throw new NotFoundException("Supplier not found");
    for (const l of input.lines) {
      if (!(Number(l.qtyOrdered) > 0) || Number(l.unitCost) < 0) {
        throw new BadRequestException(
          "A purchase order can't carry a zero or negative quantity or a negative price — " +
            "take discount and deposit lines off the bill before raising a purchase order from it.",
        );
      }
    }
    const products = await tx.product.findMany({
      where: { id: { in: [...new Set(input.lines.map((l) => l.productId))] } },
      select: { id: true, name: true, kind: true },
    });
    assertSellableLines(products); // WS8
    const known = new Set(products.map((p) => p.id));
    for (const l of input.lines) {
      if (!known.has(l.productId)) throw new NotFoundException(`Product ${l.productId} not found`);
    }

    // B571: explicit tenantId on the nested lines — the tenant proxy only stamps the top-level create.
    const tenantId = this.prisma.getTenantId();
    const items = input.lines.map((l) => ({
      tenantId,
      productId: l.productId,
      qtyOrdered: l.qtyOrdered,
      qtyReceived: 0,
      unitCost: l.unitCost,
      totalCost:
        l.totalCost !== undefined
          ? roundMoney(l.totalCost)
          : roundMoney(Number(l.qtyOrdered) * Number(l.unitCost)),
      sku: l.sku ?? null,
      packSize: l.packSize ?? null,
    }));
    return tx.purchaseOrder.create({
      data: {
        poNumber: await this.nextPoNumber(tx),
        supplierId: input.supplierId,
        status: "DRAFT",
        notes: input.notes ?? null,
        totalAmount: roundMoney(items.reduce((sum, i) => sum + i.totalCost, 0)),
        items: { create: items },
      },
      select: { id: true, poNumber: true, status: true },
    });
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
    assertSellableLines(products); // WS8
    let totalAmount = 0;
    const itemsData = dto.items.map((item: any) => {
      const prod = productMap.get(item.productId);
      if (!prod) throw new NotFoundException(`Product ${item.productId} not found`);
      // Server-side line money through the one pricing builder: a line entered per case (caseCost) totals
      // roundMoney(caseCost x cases) from the ENTERED figures; a per-piece line totals roundMoney(qty x unitCost).
      const line = poLineFromInput(item);
      if (!(line.qtyOrdered > 0)) throw new BadRequestException("Item quantity must be positive");
      totalAmount = roundMoney(totalAmount + line.totalCost);
      return {
        productId: item.productId,
        qtyOrdered: line.qtyOrdered,
        qtyReceived: 0,
        unitCost: line.unitCost,
        totalCost: line.totalCost,
        // packSize is the denomination: stored only when the cost was entered per case
        ...(line.packSize !== null ? { packSize: line.packSize } : {}),
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
        // B571: explicit tenantId on the nested lines - the tenant proxy only stamps the
        // top-level create, and a tenant-less PurchaseOrderItem is invisible to the
        // tenant-scoped item update receivePurchaseOrder performs.
        items: {
          create: itemsData.map((i: Record<string, unknown>) => ({
            ...i,
            tenantId: this.prisma.getTenantId(),
          })),
        },
      },
      include: {
        supplier: { select: { id: true, name: true } },
        items: {
          include: { product: { select: { id: true, name: true, unit: true, unitsPerBox: true } } },
        },
      },
    });
  }

  async listPurchaseOrders(query: ListPurchaseOrdersDto) {
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
        items: {
          include: { product: { select: { id: true, name: true, unit: true, unitsPerBox: true } } },
        },
        vendorBill: { select: { id: true, billNumber: true, status: true } },
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");

    // The PO's receipts history. There is no movement -> PO foreign key, only `reference = poNumber`
    // (operator-editable on manual purchases), so the join is narrowed to what can only be this PO's:
    // tenant-scoped (forTenant), the PO's own products, nothing written before the PO existed, and
    // for receipts the PO's own supplier. A reversal is a re-apply's compensating ADJUSTMENT
    // ("PO edit reversal — reverses <movementId>"), flagged and pointed at the receipt it undoes.
    const prefix = InventoryService.PO_REVERSAL_NOTE;
    const names = new Map(po.items.map((i) => [i.productId, i.product?.name ?? null]));
    const movements = await this.prisma.forTenant().stockMovement.findMany({
      where: {
        reference: po.poNumber,
        type: { in: [MovementType.PURCHASE, MovementType.ADJUSTMENT] },
        productId: { in: [...names.keys()] },
        createdAt: { gte: po.createdAt },
      },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    // A receipt is this PO's when it carries the PO's supplier. A supplier-only edit of a received
    // PO changes the header but leaves the receipts on the OLD supplier, so for a product whose net
    // posted quantity (own-supplier receipts + corrections) does not match what the line says was
    // received, widen to any supplier for that product rather than show "nothing received" while
    // stock was posted.
    const qtyReceivedByProduct = new Map<string, number>();
    for (const i of po.items) {
      qtyReceivedByProduct.set(
        i.productId,
        (qtyReceivedByProduct.get(i.productId) ?? 0) + Number(i.qtyReceived),
      );
    }
    const purchases = movements.filter((m) => m.type === MovementType.PURCHASE);
    // Receipts a re-apply has already compensated no longer count towards what is on hand.
    const reversedIds = new Set(
      movements
        .filter((m) => m.type === MovementType.ADJUSTMENT && m.notes?.startsWith(prefix))
        .map((m) => (m.notes as string).slice(prefix.length).trim()),
    );
    const ownSupplier = purchases.filter(
      (m) => m.supplierId === po.supplierId && !reversedIds.has(m.id),
    );
    const widened = new Set<string>();
    for (const [productId, want] of qtyReceivedByProduct) {
      const net = ownSupplier
        .filter((m) => m.productId === productId)
        .reduce((t, m) => t + Number(m.quantity), 0);
      if (want > 0 && Math.abs(net - want) > 0.0005) widened.add(productId);
    }
    const receiptRows = purchases.filter(
      (m) => m.supplierId === po.supplierId || widened.has(m.productId),
    );
    const receiptIds = new Set(receiptRows.map((m) => m.id));
    const receipts: PurchaseOrderReceipt[] = [];
    for (const m of movements) {
      if (m.type === MovementType.PURCHASE && receiptIds.has(m.id)) {
        receipts.push({
          id: m.id,
          kind: "RECEIPT",
          productId: m.productId,
          productName: names.get(m.productId) ?? null,
          quantity: Number(m.quantity),
          unitCost: m.unitCost == null ? null : Number(m.unitCost),
          at: m.createdAt.toISOString(),
        });
      } else if (m.type === MovementType.ADJUSTMENT && m.notes?.startsWith(prefix)) {
        // Free text is not trusted on its own (B608): a correction shows only when it points at one
        // of this PO's own receipts.
        const reversesId = m.notes.slice(prefix.length).trim();
        if (!receiptIds.has(reversesId)) continue;
        receipts.push({
          id: m.id,
          kind: "REVERSAL",
          productId: m.productId,
          productName: names.get(m.productId) ?? null,
          quantity: Number(m.quantity),
          unitCost: m.unitCost == null ? null : Number(m.unitCost),
          at: m.createdAt.toISOString(),
          reversesId,
        });
      }
    }
    return { ...po, receipts };
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

    // SA-767 L-1: the whole tx re-runs on a 40P01 / 40001 / P2034 (the lock order removes the
    // deadlock, this is the backstop). The body is idempotent (a rolled-back attempt wrote nothing)
    // and has no effect outside the tx; the id list is cleared per attempt, alerts fire after commit.
    const runBody = async (tx: any) => {
      restockedProductIds.length = 0;
      // Serialize against a concurrent receive / edit-and-re-apply of the SAME
      // PO: without the row lock both read the same qtyReceived and post twice.
      await this.lockPurchaseOrder(tx, id);
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
      if (!po) throw new NotFoundException("PO not found");
      if (po.status === "CLOSED")
        throw new BadRequestException("Cannot receive against a closed PO");
      if (po.status === "RECEIVED") throw new BadRequestException("PO is already fully received");
      await this.lockProducts(
        tx,
        po.items.map((i) => i.productId),
      );

      for (const recv of dto.items) {
        const itemId = recv.id ?? recv.itemId;
        // Match by item id first, fall back to productId
        const item = po.items.find(
          (i) => i.id === itemId || (recv.productId && i.productId === recv.productId),
        );
        if (!item) continue;

        const prod = await tx.product.findUnique({ where: { id: item.productId } });

        // Boxed payloads convert to pieces up front; a bare receivedQty/
        // qtyReceived KEEPS meaning pieces (existing callers must be
        // untouched) — mirrors recordPurchase's contract above: everything
        // below this line is PIECES, and item.unitCost is per PIECE.
        const explicitBoxed = recv.boxes != null || recv.pieces != null;
        const receivedQty = explicitBoxed
          ? normalizeBoxesPieces({
              boxes: recv.boxes,
              pieces: recv.pieces,
              // #2734: the line's stored pack wins; the live product pack is only the fallback.
              unitsPerBox: linePack(item, Number(prod?.unitsPerBox ?? 0)),
            }).qty
          : (recv.receivedQty ?? recv.qtyReceived ?? 0);

        // Never silently clamp an over-receipt down to what remains: a PO raised
        // in BOXES (mobile, or anything created before the box→piece cutover)
        // has a box-denominated qtyOrdered, so clamping a piece-denominated
        // receipt against it under-receives by unitsPerBox, writes a per-box
        // unitCost as if per piece, and flips the PO to RECEIVED — after which
        // the missing pieces can never be received. Fail loudly instead.
        // Compare in Decimal — qtyOrdered/qtyReceived are Decimal(10,3) and
        // decimal-unit lines are real (both qty inputs step by 0.001), so a
        // float subtraction (1.2 − 0.4 = 0.7999999999999999) would reject the
        // exact remaining quantity now that this guard throws instead of clamping.
        const outstanding = item.qtyOrdered.minus(item.qtyReceived);
        const actualQty = receivedQty;
        if (actualQty <= 0) continue;
        if (outstanding.lt(actualQty)) {
          throw new BadRequestException(
            `Cannot receive ${actualQty} of "${prod?.name ?? item.productId}" — only ${outstanding} ` +
              `outstanding on ${po.poNumber} (ordered ${Number(item.qtyOrdered)}, already received ` +
              `${Number(item.qtyReceived)}). If the PO was raised in boxes, close it and record the ` +
              `receipt against a new one — quantities are stored in pieces.`,
          );
        }
        restockedProductIds.push(item.productId);
        const newQtyReceived = Number(item.qtyReceived) + actualQty;
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { qtyReceived: newQtyReceived },
        });

        await this.postPoReceipt(tx, po, item, prod, actualQty, userId);
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
          items: {
            include: {
              product: { select: { id: true, name: true, unit: true, unitsPerBox: true } },
            },
          },
        },
      });
    };
    const result = await retryStockTx("inventory.receivePurchaseOrder", () =>
      this.prisma.tenantTransaction(runBody),
    );

    this.fireStockAlerts(restockedProductIds);
    return result;
  }

  /**
   * Post ONE receipt line of a purchase order: the PURCHASE movement, the
   * StockLot and the product's stock/average. The single writer shared by
   * {@link receivePurchaseOrder} and the re-apply leg of
   * {@link updatePurchaseOrder}, so a re-applied PO is valued exactly like a
   * fresh receive of the same lines. `qty` is PIECES.
   *
   * `currentStock` is written as an `increment`, never as a value derived from
   * the earlier read: a concurrent order's stock decrement between that read and
   * this write would otherwise be silently overwritten.
   */
  /**
   * Row-lock a purchase order for the rest of the transaction. Scoped to the
   * caller's tenant so a foreign id can't hold a lock before the tenant-scoped
   * read 404s, and taken BEFORE that read so a concurrent receive/edit can't
   * interleave on stale quantities.
   */
  private async lockPurchaseOrder(tx: Prisma.TransactionClient, id: string) {
    const tenantId = this.prisma.getTenantId();
    await tx.$executeRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  }

  /**
   * Row-lock the products a PO write is about to read-modify-write (stock +
   * average cost), in sorted id order so two transactions can't deadlock.
   * currentStock is written as an increment, but the average is derived from
   * the read - the lock is what keeps that read consistent with the write.
   */
  async lockProducts(tx: Prisma.TransactionClient, productIds: Iterable<string>) {
    // SA-767 L-1: a thin delegate of the one stock lock (house order: family -> recipe product -> rest).
    await lockProductsForStock(tx, this.prisma.getTenantId(), productIds);
  }

  /**
   * SA-767 L-2: the stock / cost values a writer decides from, read INSIDE its tx and AFTER
   * {@link lockProducts} - the locked rows, one query for all ids. Calling it before the lock reads
   * a value another writer can still change (the structural pin refuses that order).
   */
  private async readLockedStockRows(tx: Prisma.TransactionClient, productIds: Iterable<string>) {
    const rows = await tx.product.findMany({
      where: { id: { in: [...new Set(productIds)] } },
      // `kind` and `name`: a batch re-checks the product is still countable UNDER the lock (SA-767 n2).
      select: {
        id: true,
        name: true,
        kind: true,
        currentStock: true,
        averageCost: true,
        costingMethod: true,
      },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async postPoReceipt(
    tx: Prisma.TransactionClient,
    po: { poNumber: string; supplierId: string },
    item: { productId: string; unitCost: Prisma.Decimal | number | string },
    prod: {
      currentStock: Prisma.Decimal;
      averageCost: Prisma.Decimal | null;
      costingMethod: CostingMethod;
    } | null,
    qty: number | Prisma.Decimal,
    userId: string,
    /**
     * The purchase date of the LOT — a re-apply passes the original lot's date so
     * the re-created lot keeps its place in FIFO/LIFO order. The movement itself is
     * always dated now: the original PURCHASE stays in its own period (the reversal
     * compensates it rather than deleting it), and the correction lands today.
     * Defaults to now (a fresh receive).
     */
    lotPurchaseDate?: Date,
    /**
     * Explicit timestamp for the movement. A re-apply passes strictly increasing ones
     * (compensation, then re-post) because the cost replay orders by effectiveAt, then
     * createdAt, then a RANDOM id — two rows of one transaction share `now()`, so without
     * this their replay order (and the average it yields) would be a coin flip. B562: it
     * stamps BOTH columns (it is today's date, not a backdate).
     */
    movementAt?: Date,
  ) {
    const qtyReceived = new Prisma.Decimal(qty);
    // The PO line's cost basis is a property of the STORED row, never of the
    // receive payload: `item.unitCost` is written once at PO creation and is
    // always per PIECE (createPurchaseOrder stores it raw, and the Create-PO
    // form converts a Cost-per-Box entry to per-piece before posting — see
    // PurchaseOrderItemDto). So boxes/pieces here convert the QUANTITY only;
    // dividing the cost again would value the same goods at 1/unitsPerBox.
    const itemUnitCost = costDecimal(item.unitCost);

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
        ...(movementAt ? { createdAt: movementAt, effectiveAt: movementAt } : {}),
      },
    });

    // Create StockLot for FIFO/LIFO tracking
    await tx.stockLot.create({
      data: {
        productId: item.productId,
        purchaseDate: lotPurchaseDate ?? new Date(),
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
          currentStock: { increment: qtyReceived },
          ...(updatesAverage ? { averageCost: newAvgCost } : {}),
        },
      });
    }
  }

  /**
   * Notes prefix on the compensating movement a re-apply writes for each receipt it
   * reverses — the rest of the note is the id of the PURCHASE movement it reverses,
   * which is how a LATER re-apply tells reversed receipts from live ones.
   */
  private static readonly PO_REVERSAL_NOTE = "PO edit reversal — reverses ";

  /**
   * Undo every stock effect of a purchase order's receipts — the whole-document
   * reverse the re-apply leg of {@link updatePurchaseOrder} starts from.
   *
   * The ledger is never edited: each live PURCHASE movement (`reference = poNumber`)
   * is compensated by a costed NEGATIVE ADJUSTMENT — the same shape
   * `VendorBillsService.voidBill` writes, which the cost-recompute replay already
   * understands as the exact inverse of a purchase — so the original receipt stays
   * in its own period and there is an audit trail of the correction. The average is
   * reversed newest-first through {@link reverseAverageCost}.
   *
   * REFUSES, before anything is written, when:
   *  - a product is regulated (`trackedCategoryId`) — regulated purchase reports sum
   *    PURCHASE movements, so a compensated-and-reposted receipt would be counted
   *    twice; edit it document-only;
   *  - any of the PO's lots is partly consumed (FIFO/LIFO) — B583: surrendering only
   *    what remains and then re-creating a full-size lot would INFLATE the lot pool
   *    by what was already sold; the consumed part can't be un-sold, so the caller
   *    gets a 409 and the document-only edit;
   *  - the live movements don't add up to the lines' `qtyReceived` per product — a
   *    legacy or hand-edited PO whose stock effect cannot be reconstructed must not
   *    be re-applied on top of an unknown baseline.
   *
   * Accepted approximation (plan risk 1): if sales happened since the receipt the
   * restated average is approximate and stock may pass through a lower value inside
   * the transaction — exactly what a bill's revertToDraft does today.
   *
   * LEGACY LOTS (POs re-applied under #966, before B583) are NOT special-cased. That
   * release surrendered a partly-consumed lot by zeroing it and writing "(PO edited; N
   * already consumed)" into its free-text `notes`; a later version parsed that text to
   * credit N back. It was removed (B608): `receiveStock` writes BOTH `reference` and
   * `notes` from operator input onto a StockLot, and this method finds lots by
   * `reference`, so anyone able to receive stock could mint a lot naming a real PO with
   * that text and have N credited as free stock once it drained. A PO from that window
   * now refuses re-apply like any other partly-consumed lot (409 PO_LOT_PARTIALLY_CONSUMED)
   * and stays document-only editable; there is no migration.
   *
   * Returns the original purchase date of each product's lot, so the re-posted lot
   * keeps its place in FIFO/LIFO order.
   */
  private async reversePoReceipts(
    tx: Prisma.TransactionClient,
    po: {
      poNumber: string;
      items: { productId: string; qtyReceived: Prisma.Decimal }[];
    },
    userId: string,
    /** Strictly increasing timestamps for the compensating movements (see postPoReceipt). */
    nextAt: () => Date,
  ): Promise<{ lotDates: Map<string, Date> }> {
    const productIds = [...new Set(po.items.map((i) => i.productId))];

    // ── Refuse first: nothing below runs unless every check passes ──
    const regulated = await tx.product.findFirst({
      where: { id: { in: productIds }, trackedCategoryId: { not: null } },
      select: { name: true },
    });
    if (regulated) {
      throw new BadRequestException(
        `"${regulated.name}" is a regulated product, so ${po.poNumber}'s inventory can't be re-applied — ` +
          "regulated purchase reports read the original receipt. Save the edit as document-only instead.",
      );
    }

    const lots = await tx.stockLot.findMany({
      where: { reference: po.poNumber, productId: { in: productIds } },
    });
    const consumedLots = lots.filter((l) => new Prisma.Decimal(l.remainingQty).lt(l.qty));
    if (consumedLots.length > 0) {
      throw new ConflictException({
        code: API_ERROR_CODES.PO_LOT_PARTIALLY_CONSUMED,
        message:
          `Part of what was received on ${po.poNumber} has already been sold or used (FIFO/LIFO lot ` +
          "partially consumed), so its inventory can't be re-applied — that would invent stock. " +
          "Save the edit as document-only (keep stock as is), or record a return.",
        lotIds: consumedLots.map((l) => l.id),
      });
    }

    const movements = await tx.stockMovement.findMany({
      where: {
        reference: po.poNumber,
        type: { in: [MovementType.PURCHASE, MovementType.ADJUSTMENT] },
        productId: { in: productIds },
      },
      // id as the tiebreak: two movements of one receive share a transaction-time
      // createdAt, and reverseAverageCost's empties-stock short-circuit is
      // order-sensitive. B562: accounting order first (effectiveAt).
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    const prefix = InventoryService.PO_REVERSAL_NOTE;
    const reversedIds = new Set<string>();
    for (const m of movements) {
      if (m.type === MovementType.ADJUSTMENT && m.notes?.startsWith(prefix)) {
        reversedIds.add(m.notes.slice(prefix.length).trim());
      }
    }
    // Live receipts: PURCHASE movements a previous re-apply hasn't already compensated.
    const live = movements.filter(
      (m) => m.type === MovementType.PURCHASE && !reversedIds.has(m.id),
    );

    const posted = new Map<string, Prisma.Decimal>();
    for (const m of live) {
      posted.set(m.productId, (posted.get(m.productId) ?? new Prisma.Decimal(0)).add(m.quantity));
    }
    const lineTotals = new Map<string, Prisma.Decimal>();
    for (const i of po.items) {
      lineTotals.set(
        i.productId,
        (lineTotals.get(i.productId) ?? new Prisma.Decimal(0)).add(i.qtyReceived),
      );
    }
    for (const [productId, lineQty] of lineTotals) {
      const postedQty = posted.get(productId) ?? new Prisma.Decimal(0);
      if (!postedQty.eq(lineQty)) {
        throw new BadRequestException(
          `${po.poNumber}: the stock movements on record (${postedQty.toString()}) do not match what its lines ` +
            `say was received (${lineQty.toString()}), so its inventory cannot be re-applied safely. ` +
            `Save the edit as document-only (keep stock as is) instead.`,
        );
      }
    }

    // ── Compensate, newest receipt first ──
    const byProduct = new Map<string, typeof live>();
    for (const m of live) {
      const list = byProduct.get(m.productId) ?? [];
      list.push(m);
      byProduct.set(m.productId, list);
    }
    for (const [productId, list] of byProduct) {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { currentStock: true, averageCost: true, costingMethod: true },
      });
      if (!product) continue;
      // STANDARD products never had their average moved by the receipt, so the
      // reversal must not move it either.
      const tracksAverage = product.costingMethod !== CostingMethod.STANDARD;
      let stock = product.currentStock;
      let avg = product.averageCost;
      let totalQty = new Prisma.Decimal(0);
      for (const m of list) {
        if (tracksAverage && avg != null && m.unitCost != null) {
          // null ⇒ the reversal empties stock: KEEP the previous average so the
          // product's cost basis survives (same contract as revertToDraft).
          const before = reverseAverageCost(stock, avg, m.quantity, m.unitCost);
          if (before !== null) avg = before;
        }
        stock = stock.sub(m.quantity);
        totalQty = totalQty.add(m.quantity);
        const at = nextAt();
        await tx.stockMovement.create({
          data: {
            productId,
            type: MovementType.ADJUSTMENT,
            quantity: new Prisma.Decimal(m.quantity).negated(),
            unitCost: m.unitCost,
            avgCostAfter: tracksAverage ? avg : (product.averageCost ?? null),
            stockAfter: stock,
            supplierId: m.supplierId,
            reference: po.poNumber,
            notes: `${prefix}${m.id}`,
            performedById: userId,
            // B562: one stamp for both columns — the replay orders by effectiveAt first.
            createdAt: at,
            effectiveAt: at,
          },
        });
      }
      // Write the average only when the reversal actually moved it — writing the
      // unchanged value back would clobber a concurrent cost update for nothing.
      const avgMoved =
        tracksAverage && avg != null && product.averageCost != null && !avg.eq(product.averageCost);
      await tx.product.update({
        where: { id: productId },
        data: {
          currentStock: { decrement: totalQty },
          ...(avgMoved ? { averageCost: avg! } : {}),
        },
      });
    }

    // ── Lots: every one is untouched (checked above), so each is reversed by its
    // full original qty — deleted — and re-created by the re-post. ──
    if (lots.length > 0) {
      await tx.stockLot.deleteMany({ where: { id: { in: lots.map((l) => l.id) } } });
    }
    const lotDates = new Map<string, Date>();
    for (const l of lots) {
      const seen = lotDates.get(l.productId);
      if (!seen || l.purchaseDate < seen) lotDates.set(l.productId, l.purchaseDate);
    }
    return { lotDates };
  }

  /**
   * Edit a purchase order — `PATCH /inventory/purchase-orders/:id`.
   *
   *  - DRAFT / SENT: nothing was received, so lines and header edit freely.
   *  - PARTIAL / RECEIVED, header only (notes, expected date): always allowed.
   *  - PARTIAL / RECEIVED with `items` (or a supplier change) — the caller MUST
   *    say what happens to stock via `reapplyInventory`:
   *      • `true`  — ONE transaction: reverse every stock effect of this PO
   *        ({@link reversePoReceipts}), apply the edit, and re-post EXACTLY the
   *        quantities that were previously received, at the edited cost and
   *        original receipt date, through {@link postPoReceipt}.
   *      • `false` — document-only: stock and cost are untouched (the PO cost
   *        may then diverge from valuation — by the operator's explicit choice).
   *    Either way (owner/lead ruling, three-document rule): a received line can't
   *    drop below what was received, change product or be removed — a received
   *    quantity only comes back out through a recorded return — and a raised
   *    `qtyOrdered` or an added line is OUTSTANDING, received later through the
   *    normal receive and its over-receipt gate. A RECEIVED PO with outstanding
   *    quantity therefore becomes PARTIAL.
   *  - CLOSED: rejected.
   *
   * The PO row (and the products it touches) are locked for the transaction, and
   * so is every receive, so an edit can't interleave with a receipt of the same PO.
   *
   * Accepted by the plan (risks 1 and 5), stated here so nobody rediscovers them:
   *  - The reversal COMPENSATES rather than deletes: each live PURCHASE movement gets
   *    a costed negative ADJUSTMENT (as a bill void does), so the ledger keeps the
   *    audit trail and the original receipt stays in its own period; the re-post is
   *    dated now, and the re-created lot keeps its original purchase date.
   *  - REFUSED (nothing written): a regulated product, a partly-consumed FIFO/LIFO
   *    lot (409 PO_LOT_PARTIALLY_CONSUMED — re-applying would invent the stock that
   *    was already sold, B583), or movements that don't add up to the lines.
   *  - `items` is a full replacement: a line left out of the payload is removed.
   */
  async updatePurchaseOrder(id: string, dto: UpdatePurchaseOrderDto, userId: string) {
    const restockedProductIds: string[] = [];

    // SA-767 Nit 5 / Nit 6: a stock writer (the re-apply leg reverses and re-posts the receipts), so
    // the whole tx re-runs on a 40P01 / 40001 / P2034 and exhausting the attempts is a coded 503. The
    // body is idempotent (a rolled-back attempt wrote nothing) and has no effect outside the tx; the
    // id list is cleared per attempt and the alerts fire after commit.
    const runBody = async (tx: Prisma.TransactionClient) => {
      restockedProductIds.length = 0;
      await this.lockPurchaseOrder(tx, id);
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
      if (!po) throw new NotFoundException("Purchase order not found");
      if (po.status === "CLOSED")
        throw new BadRequestException("Cannot edit a closed purchase order");

      const wasReceived = po.status === "PARTIAL" || po.status === "RECEIVED";
      const editsLines = dto.items !== undefined;
      if (editsLines && dto.items!.length === 0)
        throw new BadRequestException("At least one item is required");
      const supplierChanged = dto.supplierId !== undefined && dto.supplierId !== po.supplierId;

      // A PO with a LIVE linked bill can't change what it authorised: the bill was gated
      // against these lines and this supplier, and letting either move would let the two
      // documents drift apart (an over-billed PO, a bill for another supplier's order).
      // Header edits (notes, expected date) stay open. Void the bill to release the PO.
      if (editsLines || supplierChanged) {
        const liveBill = await tx.vendorBill.findFirst({
          where: { purchaseOrderId: id, status: { not: "VOID" as never } },
          select: { billNumber: true },
        });
        if (liveBill) {
          throw new ConflictException({
            code: API_ERROR_CODES.PO_HAS_LINKED_BILL,
            message:
              `${po.poNumber} has already been billed (${liveBill.billNumber}), so its lines and supplier ` +
              "are locked — the bill was checked against them. Void the bill to change them, or edit " +
              "only the notes or expected date.",
            billNumber: liveBill.billNumber,
          });
        }
      }
      const touchesStock = wasReceived && (editsLines || supplierChanged);
      if (touchesStock && dto.reapplyInventory === undefined) {
        throw new BadRequestException(
          "This purchase order has already been received — say whether to re-apply the edit to " +
            "inventory (reapplyInventory: true) or keep stock as is (reapplyInventory: false).",
        );
      }
      if (wasReceived && supplierChanged && dto.reapplyInventory === false) {
        throw new BadRequestException(
          "The supplier of a received purchase order can only change together with re-applying inventory.",
        );
      }
      const reapply = touchesStock && dto.reapplyInventory === true;

      const header: Prisma.PurchaseOrderUncheckedUpdateInput = {};
      if (supplierChanged) {
        const supplier = await tx.supplier.findUnique({ where: { id: dto.supplierId! } });
        if (!supplier) throw new NotFoundException("Supplier not found");
        header.supplierId = dto.supplierId!;
      }
      if (dto.expectedDate !== undefined)
        header.expectedDate = dto.expectedDate ? new Date(dto.expectedDate) : null;
      if (dto.notes !== undefined) header.notes = dto.notes;

      if (!editsLines) {
        if (Object.keys(header).length === 0) return this.loadPoForResponse(tx, id);
        await tx.purchaseOrder.update({ where: { id }, data: header });
        return this.loadPoForResponse(tx, id);
      }

      // ── Resolve the edited line set ──
      // Every line through the one pricing builder: a case line (caseCost) totals from the ENTERED figures and
      // stores its pack; a per-piece line keeps qtyOrdered/unitCost (and whatever packSize it sent, as before).
      const items = dto.items!.map((l) => {
        const amounts = poLineFromInput(l);
        // A case line's `cases` may be 0 (@Min(0)) with no loose pieces, so the DTO's per-piece @Min(0.001) no
        // longer covers it: the same positive-quantity gate createPurchaseOrder has.
        if (!(amounts.qtyOrdered > 0))
          throw new BadRequestException("Item quantity must be positive");
        return {
          id: l.id,
          productId: l.productId,
          sku: l.sku,
          qtyOrdered: amounts.qtyOrdered,
          unitCost: amounts.unitCost,
          totalCost: amounts.totalCost,
          packSize: amounts.packSize !== null ? amounts.packSize : l.packSize,
        };
      });
      const existingById = new Map<string, (typeof po.items)[number]>(
        po.items.map((i) => [i.id, i] as const),
      );
      const keptIds = new Set<string>();
      for (const line of items) {
        if (line.id === undefined) continue;
        if (!existingById.has(line.id))
          throw new BadRequestException(`Line ${line.id} does not belong to ${po.poNumber}`);
        if (keptIds.has(line.id))
          throw new BadRequestException(`Line ${line.id} appears more than once`);
        keptIds.add(line.id);
      }
      const products = await tx.product.findMany({
        where: { id: { in: [...new Set(items.map((l) => l.productId))] } },
      });
      assertSellableLines(products); // WS8
      const productIds = new Set(products.map((p) => p.id));
      for (const line of items) {
        if (!productIds.has(line.productId))
          throw new NotFoundException(`Product ${line.productId} not found`);
      }
      const removed = po.items.filter((i) => !keptIds.has(i.id));

      // ── Guards on a received PO (re-apply AND document-only) ──
      // What the old movements prove arrived can never be edited away here: a
      // received quantity only comes back out through a recorded return, and a
      // re-apply may not invent stock the movements don't prove. So a received
      // line can't drop below what was received, change product, or be removed.
      if (wasReceived) {
        const nameOf = (productId: string) =>
          products.find((p) => p.id === productId)?.name ?? productId;
        for (const line of items) {
          const ex = line.id ? existingById.get(line.id) : undefined;
          if (!ex) continue;
          if (new Prisma.Decimal(line.qtyOrdered).lt(ex.qtyReceived)) {
            throw new BadRequestException(
              `Cannot lower "${nameOf(line.productId)}" to ${line.qtyOrdered} — ${Number(ex.qtyReceived)} ` +
                `already received on ${po.poNumber}. A received quantity can only come back out by ` +
                `recording a return.`,
            );
          }
          if (ex.qtyReceived.gt(0) && line.productId !== ex.productId) {
            throw new BadRequestException(
              "A line that has been received can't change product — record a return and add a new line.",
            );
          }
        }
        for (const r of removed) {
          if (r.qtyReceived.gt(0)) {
            throw new BadRequestException(
              "A line that has been received can't be removed — record a return instead.",
            );
          }
        }
      }

      // ── Reverse (re-apply only) ──
      let lotDates = new Map<string, Date>();
      // Strictly increasing movement timestamps: compensation(s) first, then the re-post.
      const clockBase = Date.now();
      let tick = 0;
      const nextAt = () => new Date(clockBase + tick++);
      if (reapply) {
        await this.lockProducts(tx, [
          ...po.items.map((i) => i.productId),
          ...items.map((l) => l.productId),
        ]);
        ({ lotDates } = await this.reversePoReceipts(tx, po, userId, nextAt));
      }
      const tenantId = this.prisma.getTenantId();

      // ── Received quantity per line ──
      // Exactly what was received before — re-apply restates its COST (and
      // supplier), never its quantity. A raised qtyOrdered or an added line is
      // OUTSTANDING: it arrives later through the normal receive (and its
      // over-receipt gate), which is why a RECEIVED PO can become PARTIAL here.
      const targetReceived = (line: (typeof items)[number]): Prisma.Decimal => {
        const ex = line.id ? existingById.get(line.id) : undefined;
        return wasReceived && ex ? ex.qtyReceived : new Prisma.Decimal(0);
      };

      const lineData = items.map((line) => {
        return {
          line,
          totalCost: line.totalCost,
          qtyReceived: targetReceived(line),
        };
      });
      const totalAmount = roundMoney(lineData.reduce((s, l) => s + l.totalCost, 0));

      const nextStatus = (() => {
        if (!wasReceived) return po.status;
        const all = lineData.every((l) => l.qtyReceived.gte(l.line.qtyOrdered));
        const any = lineData.some((l) => l.qtyReceived.gt(0));
        return all ? "RECEIVED" : any ? "PARTIAL" : "SENT";
      })();

      await tx.purchaseOrder.update({
        where: { id },
        data: {
          ...header,
          totalAmount,
          status: nextStatus,
          items: {
            ...(removed.length > 0 ? { deleteMany: { id: { in: removed.map((r) => r.id) } } } : {}),
            update: lineData
              .filter((l) => l.line.id !== undefined)
              .map((l) => ({
                where: { id: l.line.id! },
                data: {
                  productId: l.line.productId,
                  qtyOrdered: l.line.qtyOrdered,
                  qtyReceived: l.qtyReceived,
                  unitCost: l.line.unitCost,
                  totalCost: l.totalCost,
                  ...(l.line.sku !== undefined ? { sku: l.line.sku } : {}),
                  ...(l.line.packSize !== undefined ? { packSize: l.line.packSize } : {}),
                },
              })),
            create: lineData
              .filter((l) => l.line.id === undefined)
              .map((l) => ({
                // B571: explicit tenantId - nested creates get none from the tenant proxy,
                // and a tenant-less line is invisible to tenant-scoped item writes.
                tenantId,
                productId: l.line.productId,
                qtyOrdered: l.line.qtyOrdered,
                qtyReceived: l.qtyReceived,
                unitCost: l.line.unitCost,
                totalCost: l.totalCost,
                sku: l.line.sku ?? null,
                packSize: l.line.packSize ?? null,
              })),
          },
        },
      });

      // ── Re-post (re-apply only) ──
      if (reapply) {
        const supplierId = supplierChanged ? dto.supplierId! : po.supplierId;
        for (const l of lineData) {
          if (l.qtyReceived.lte(0)) continue;
          const prod = await tx.product.findUnique({ where: { id: l.line.productId } });
          await this.postPoReceipt(
            tx,
            { poNumber: po.poNumber, supplierId },
            { productId: l.line.productId, unitCost: l.line.unitCost },
            prod,
            l.qtyReceived,
            userId,
            lotDates.get(l.line.productId),
            nextAt(),
          );
          restockedProductIds.push(l.line.productId);
        }
      }

      return this.loadPoForResponse(tx, id);
    };
    const result = await retryStockTx("inventory.updatePurchaseOrder", () =>
      this.prisma.tenantTransaction(runBody),
    );

    this.fireStockAlerts([...new Set(restockedProductIds)]);
    return result;
  }

  private loadPoForResponse(tx: Prisma.TransactionClient, id: string) {
    return tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true } },
        items: {
          include: { product: { select: { id: true, name: true, unit: true, unitsPerBox: true } } },
        },
      },
    });
  }

  async closePurchaseOrder(id: string) {
    return this.prisma
      .forTenant()
      .purchaseOrder.update({ where: { id }, data: { status: "CLOSED" } });
  }

  // ── Forecasting ──
  /**
   * 30-day demand per product, from invoiced sales windowed on
   * Invoice.issueDate. `StockMovement type:"SALE"` is not viable: SALE rows
   * only exist since B562 PR-2 (order stock events), so history before it reads
   * as zero demand, and they move at order time, not sale. Line `qty` is the
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
    assertSellableLines([product]); // WS8: a FAMILY has no cost basis (no stock)

    // SA-767 L-2: lock, then stamp the movement from the LOCKED stock (a sale committing since the
    // read above has moved it). The whole tx re-runs on a 40P01 / 40001 / P2034.
    return retryStockTx("inventory.setCostBasis", () =>
      this.prisma.tenantTransaction(async (tx) => {
        await this.lockProducts(tx, [productId]);
        const locked = (await this.readLockedStockRows(tx, [productId])).get(productId);
        if (!locked) throw new NotFoundException("Product not found");
        return this.setCostBasisInTx(tx, locked, dto, performedById);
      }),
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
    assertSellableLines(products); // WS8

    // SA-767 L-2: ONE lock statement over every product (sorted by the helper), then one locked read.
    return retryStockTx("inventory.bulkSetCostBasis", () =>
      this.prisma.tenantTransaction(async (tx) => {
        await this.lockProducts(tx, productIds);
        const lockedMap = await this.readLockedStockRows(tx, productIds);
        const movementIds: string[] = [];
        for (const item of dto.items) {
          const locked = lockedMap.get(item.productId);
          if (!locked) throw new NotFoundException("Product not found");
          const movement = await this.setCostBasisInTx(
            tx,
            locked,
            { unitCost: item.unitCost, notes: dto.notes, applyToLots: dto.applyToLots },
            performedById,
          );
          movementIds.push(movement.id);
        }
        return { updated: movementIds.length, movementIds };
      }),
    );
  }

  /** `product` is the row the caller read INSIDE its tx, after `lockProducts` (SA-767 L-2). */
  private async setCostBasisInTx(
    tx: Prisma.TransactionClient,
    product: { id: string; costingMethod: CostingMethod },
    dto: SetCostBasisDto,
    performedById: string,
    reference?: string,
  ) {
    const unitCost = costDecimal(dto.unitCost);

    // A STANDARD product is valued from standardCost, so also set it — otherwise
    // "Set cost" writes averageCost only and the stock table (which reads
    // standardCost for STANDARD) never clears its "No cost set" state.
    const updated = await tx.product.update({
      where: { id: product.id },
      data:
        product.costingMethod === CostingMethod.STANDARD
          ? { averageCost: unitCost, standardCost: unitCost }
          : { averageCost: unitCost },
      select: { currentStock: true },
    });

    // The snapshot is the counter this update RETURNED, never a read made before it.
    const movement = await tx.stockMovement.create({
      data: {
        productId: product.id,
        type: MovementType.COST_BASIS,
        quantity: 0,
        unitCost,
        avgCostAfter: unitCost,
        stockAfter: updated.currentStock,
        notes: dto.notes,
        performedById,
        // A count's cost correction carries the session reference: it is what makes the batch resumable.
        ...(reference ? { reference } : {}),
      },
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
        countedQty: roundCountQty(l.countedQty), // the one rounding helper (legacy rows may be unrounded)
        boxes: l.boxes,
        pieces: l.pieces,
        mode: l.mode as "REPLACE" | "ADD",
      }));
    }

    const session = await this.prisma.tenantTransaction(async (tx) => {
      // An amendment seeds lines too: the same one-open-count-per-product rule as an add (SA-767 r-note 5
      // SA-3). The seeded products are locked in SORTED order (two amenders cannot deadlock), then checked once.
      const seedIds = [...new Set(seedLines.map((l) => l.productId))].sort();
      for (const productId of seedIds) {
        // eslint-disable-next-line no-await-in-loop
        await advisoryXactLock(
          tx,
          STOCK_COUNT_PRODUCT_LOCK_FAMILY,
          `${this.prisma.getTenantId() ?? ""}:${productId}`,
        );
      }
      const taken = await this.findOpenCountConflicts(tx, seedIds);
      if (taken.length > 0) throw productInOpenCount(taken);
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
    }, COUNT_ADD_TX_OPTIONS); // N sorted product locks + N creates: the same budget as a single add

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
    return { ...session, commit: await this.commitProgressOf(session) };
  }

  /**
   * `{ committedLines, totalLines }` while a commit is UNFINISHED - some movement exists for the
   * session and it is not COMMITTED / DISCARDED - else null (SA-767 L-2.4 D). The same movement query
   * the edit paths' committing check makes, bounded by `startedAt`. A session that is not OPEN /
   * REVIEW is not looked up at all.
   */
  private async commitProgressOf(session: {
    id: string;
    status: string;
    startedAt: Date;
    lines: Parameters<typeof computeCommitProgress>[0];
  }): Promise<StockCountCommitProgress | null> {
    if (session.status !== "OPEN" && session.status !== "REVIEW") return null;
    const moves = await this.prisma.forTenant().stockMovement.findMany({
      where: { reference: stockCountReference(session.id), createdAt: { gte: session.startedAt } },
      select: { productId: true, type: true },
    });
    if (moves.length === 0) return null;
    return computeCommitProgress(session.lines, moves);
  }

  /**
   * The one entry of every line edit (upsert / remove) and of discard, run INSIDE the caller's own tx
   * (SA-767 L-2.4 B, r-note 4 B). It takes the SHARED `stock-count:<sessionId>` advisory lock for the
   * tx - the committer holds the same key pair exclusively across all of its batches - so an edit and a
   * commit never interleave: if the committer has it the edit is 409 STOCK_COUNT_COMMITTING at once.
   * Everything that decides whether the edit may happen is read AFTER the lock: the session's status
   * (a commit that just finished made it COMMITTED, which the lock-free check of the old code could
   * miss) and the movements check. The lock is what protects a commit whose lines are all zero-delta
   * (it writes no movement, so the movements check alone can never see it); the movements check
   * stays for a commit that was interrupted (the committer is gone, its movements remain).
   * `startedAt` bounds the movement lookup to the count's own lifetime (`reference` has no index).
   */
  private async enterSessionEdit(tx: Prisma.TransactionClient, sessionId: string) {
    if (!(await tryAdvisoryXactLockShared(tx, STOCK_COUNT_LOCK_FAMILY, sessionId))) {
      throw stockCountCommitting();
    }
    const session = await tx.stockCountSession.findFirst({
      where: { id: sessionId },
      select: { id: true, status: true, startedAt: true },
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
    const started = await tx.stockMovement.findFirst({
      where: {
        reference: stockCountReference(session.id),
        ...(session.startedAt ? { createdAt: { gte: session.startedAt } } : {}),
      },
      select: { id: true },
    });
    if (started) throw stockCountCommitting();
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
    return this.prisma.tenantTransaction(async (tx) => {
      // The shared `stock-count` lock, then the status / movements checks (SA-767 L-2.4 B).
      await this.enterSessionEdit(tx, sessionId);

      // The product AND its live stock, read in THIS tx (SA-767 L-2.4 A): the stock is the baseline
      // stamp below, not a stock write, so a plain read is enough (no Product lock).
      const live = await tx.product.findFirst({
        where: { id: dto.productId },
        select: { id: true, name: true, kind: true, currentStock: true, unitsPerBox: true },
      });
      if (!live) throw new NotFoundException("Product not found");
      assertSellableLines([live]); // WS8: a counted FAMILY must not reach assignToVariants

      // Boxes/pieces win when present — the server recomputes qty from the split
      // exactly like the order builders, so a boxed product is never miscounted
      // as loose pieces.
      const upb = Number(live.unitsPerBox ?? 0);
      const fromSplit =
        dto.boxes != null || dto.pieces != null
          ? normalizeBoxesPieces({ boxes: dto.boxes, pieces: dto.pieces, unitsPerBox: upb })
          : null;
      // Rounded to the column's 3 dp ONCE, here: the compare below and the write both see what Postgres
      // will store (SA-767 r-note 5 MF3), so a client float never reads as a changed count.
      const incoming = roundCountQty(fromSplit ? fromSplit.qty : (dto.countedQty ?? 0));

      const existing = await tx.stockCountLine.findUnique({
        where: { sessionId_productId: { sessionId, productId: dto.productId } },
      });

      const countedQty = dto.increment
        ? roundCountQty(new Prisma.Decimal(existing?.countedQty ?? 0).add(incoming))
        : incoming;

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
        // The baseline is the stock when this line's counting BEGAN: its create, or its last ABSOLUTE write
        // THAT CHANGED THE COUNT (a typed / set total or a recount whose quantity or boxes / pieces split
        // differs from the stored line). That write re-stamps it, otherwise a sale between two counts would
        // be subtracted twice (the REPLACE delta is `countedQty - expectedQty`). Everything else keeps it:
        // an increment scan is one physical count accumulating, and a cost-only edit, a mode toggle or a
        // same-value resend (both clients resend the full countedQty on every edit) is not a recount - a
        // re-stamp there would erase a sale made since the count (SA-767 r-note 5 SA-1). ADD-mode lines
        // never read it.
        const recount = !dto.increment && absoluteCountChanged(existing, data);
        return tx.stockCountLine.update({
          where: { id: existing.id },
          data: recount ? { ...data, expectedQty: live.currentStock } : data,
          select: this.stockCountLineSelect(),
        });
      }
      // ADDING the product to this count (SA-767 r-note 5 SA-3, one open count per product): serialise
      // every adder of this product, THEN look for another open count that already has it.
      await advisoryXactLock(
        tx,
        STOCK_COUNT_PRODUCT_LOCK_FAMILY,
        `${this.prisma.getTenantId() ?? ""}:${dto.productId}`,
      );
      const taken = await this.findOpenCountConflicts(tx, [dto.productId], sessionId);
      if (taken.length > 0) throw productInOpenCount(taken);
      return tx.stockCountLine.create({
        data: {
          sessionId,
          productId: dto.productId,
          // The create stamps the live stock (rule 1); see the update branch for the absolute writes.
          expectedQty: live.currentStock,
          ...data,
        },
        select: this.stockCountLineSelect(),
      });
      // 15 s, not Prisma's 5 s default: the product-lock helper bounds its wait with a 5 s lock_timeout, and a
      // tx budget equal to it would expire first as an unmapped P2028 500 instead of 55P03 -> the 503.
    }, COUNT_ADD_TX_OPTIONS);
  }

  /**
   * SA-767 r-note 5 SA-3: the products among `productIds` that already have a line on ANOTHER open
   * (OPEN / REVIEW) count of the tenant, one row per (product, session). `excludeSessionId` is the count
   * being added to / committed. Read it AFTER the product lock when deciding an add.
   */
  private async findOpenCountConflicts(
    db: {
      stockCountLine: { findMany(args: Prisma.StockCountLineFindManyArgs): Promise<unknown[]> };
    },
    productIds: string[],
    excludeSessionId?: string,
  ): Promise<OpenCountConflict[]> {
    if (productIds.length === 0) return [];
    const rows = (await db.stockCountLine.findMany({
      where: {
        productId: { in: productIds },
        ...(excludeSessionId ? { sessionId: { not: excludeSessionId } } : {}),
        session: { status: { in: [...OPEN_COUNT_STATUSES] } },
      },
      select: {
        productId: true,
        product: { select: { name: true } },
        session: { select: { id: true, name: true } },
      },
      orderBy: [{ productId: "asc" }, { sessionId: "asc" }],
    })) as Array<{
      productId: string;
      product?: { name?: string | null } | null;
      session: { id: string; name: string | null };
    }>;
    const seen = new Set<string>();
    const out: OpenCountConflict[] = [];
    for (const r of rows ?? []) {
      const key = `${r.productId}:${r.session.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        productId: r.productId,
        productName: r.product?.name ?? null,
        sessionId: r.session.id,
        sessionName: r.session.name ?? null,
      });
    }
    // Deterministic whatever order the rows came in: by product, then by the other count.
    return out.sort(
      (x, y) => x.productId.localeCompare(y.productId) || x.sessionId.localeCompare(y.sessionId),
    );
  }

  async removeStockCountLine(sessionId: string, productId: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      await this.enterSessionEdit(tx, sessionId);
      await tx.stockCountLine.deleteMany({ where: { sessionId, productId } });
      return { removed: true };
    });
  }

  /**
   * Discard a count. Under the shared `stock-count` lock (a commit in flight is 409), and a CAS:
   * only an OPEN / REVIEW session flips, so a discard can never overwrite a status a commit set - and a
   * commit that finds DISCARDED under its own lock stops before its first batch, so stock is never
   * adjusted under a DISCARDED session (SA-767 L-2.4 B). A CAS that matches no row is a 409.
   */
  async discardStockCountSession(id: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      await this.enterSessionEdit(tx, id);
      const flipped = await tx.stockCountSession.updateMany({
        where: { id, status: { in: ["OPEN", "REVIEW"] } },
        data: { status: "DISCARDED", discardedAt: new Date() },
      });
      if (flipped.count === 0) throw stockCountCommitting();
      return tx.stockCountSession.findUnique({ where: { id } });
    });
  }

  /**
   * Commit a durable session. Uncounted products are NEVER touched — a count
   * only asserts what it actually saw.
   *
   * SA-767 L-2.2 (r-note 2 (b)): the commit is BATCHED. One committer holds the session-scoped
   * `stock-count` advisory lock (try mode, EXCLUSIVE) across all batches; the lines are applied
   * COUNT_COMMIT_BATCH at a time, ordered by productId, each batch its own short tx (see
   * {@link commitStockCountBatch}), so a sale of a counted product waits behind at most one batch.
   * The session stays OPEN / REVIEW (no new enum value) until a CAS after the LAST batch flips it to
   * COMMITTED. A second committer gets 409 STOCK_COUNT_COMMITTING; a crashed commit resumes, because
   * a line whose movement already exists is skipped.
   *
   * SA-767 L-2.4 B (r-note 4 B): the cheap refusals below (not found, discarded, committed, empty) run
   * BEFORE the lock, but nothing is decided from lines read there: the committer takes the lock FIRST
   * and re-reads the session (status and lines) under it, so an edit that was in flight finishes before
   * batch 1 and nothing it saved is dropped. Line edits and discard hold the SHARED form of the lock
   * for their own tx, so none of them runs beside a commit.
   *
   * Ordering inside a batch is deliberate: a line's `unitCostOverride` is applied BEFORE its
   * quantity adjustment, so the ADJUSTMENT movement's `avgCostAfter` and any
   * lot opened for a positive delta are valued at the CORRECTED cost. Applying
   * it after would stamp the stale cost onto both.
   */
  async commitStockCountSession(
    id: string,
    dto: CommitStockCountSessionDto,
    user: { sub: string },
  ): Promise<StockCountCommitOutcome> {
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
      return this.alreadyCommittedOutcome(
        id,
        session.movementReference ?? stockCountReference(id),
        session.lines.length,
      );
    }
    if (session.lines.length === 0) {
      throw new BadRequestException("Nothing counted yet");
    }
    // A product that can never be counted (gone, or a FAMILY: WS8) is refused HERE, before a lock
    // connection is spent. The same check runs again on the lines re-read under the lock. "Finish with skips" decides this
    // under the lock instead.
    if (dto.finishWithSkips !== true) {
      this.refuseUncountableProducts(await this.readCountProducts(session.lines));
    }

    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : new Date();
    const reference = stockCountReference(id);

    let held;
    try {
      held = await this.runUnderCountLock(id, () =>
        this.commitStockCountBatches({
          id,
          reference,
          effectiveDate,
          notes: dto.notes,
          finishWithSkips: dto.finishWithSkips === true,
          user,
        }),
      );
    } catch (e) {
      // Every "busy" answer the committer can raise - no lock connection, retries exhausted in a batch
      // (retryStockTx's 503), a raw lock timeout / deadlock outside a batch - becomes ONE 503 that also
      // says how far the commit got. Anything else propagates untouched.
      const busy =
        e instanceof LockUnavailableError ||
        (e instanceof ServiceUnavailableException &&
          (e.getResponse() as { code?: string })?.code === API_ERROR_CODES.LOCK_UNAVAILABLE) ||
        stockTxRetryState(e) !== null;
      if (busy) throw await this.lockUnavailableWithProgress(id);
      throw e;
    }
    if (!held.acquired) throw stockCountCommitting();
    return held.value;
  }

  /**
   * The 503 LOCK_UNAVAILABLE of a count commit, with `committedLines` / `totalLines` (SA-767 L-2.4 D)
   * so the client can say "Partly saved - commit again to finish" or "Nothing was saved". The code
   * stays LOCK_UNAVAILABLE (clients that retry on it are unchanged); `retryStockTx` is not touched,
   * only the count committer adds the fields. A failure to read the progress degrades to the plain 503.
   */
  private async lockUnavailableWithProgress(id: string): Promise<ServiceUnavailableException> {
    let progress: StockCountCommitProgress | null = null;
    try {
      const s = await this.prisma.forTenant().stockCountSession.findUnique({
        where: { id },
        select: {
          startedAt: true,
          lines: { select: { productId: true, mode: true, countedQty: true, expectedQty: true } },
        },
      });
      if (s) {
        const moves = await this.prisma.forTenant().stockMovement.findMany({
          where: { reference: stockCountReference(id), createdAt: { gte: s.startedAt } },
          select: { productId: true, type: true },
        });
        progress = computeCommitProgress(s.lines, moves);
      }
    } catch (err) {
      this.logger.warn(`count commit progress unavailable for ${id}: ${(err as Error)?.message}`);
    }
    return new ServiceUnavailableException({
      code: API_ERROR_CODES.LOCK_UNAVAILABLE,
      message:
        progress && progress.committedLines > 0
          ? "Part of this count was saved. Commit again to finish."
          : "Nothing was saved. Please try again in a moment.",
      ...(progress ?? {}),
    });
  }

  /**
   * Take the session's EXCLUSIVE `stock-count` lock in try mode and run `fn` under it. A busy lock is
   * retried COUNT_LOCK_ATTEMPTS times (an edit mid-flight holds the shared form for milliseconds), then
   * reported as `{ acquired: false }` - the caller answers 409 STOCK_COUNT_COMMITTING.
   */
  private async runUnderCountLock(
    id: string,
    fn: () => Promise<StockCountCommitOutcome>,
  ): Promise<LockResult<StockCountCommitOutcome>> {
    let held: LockResult<StockCountCommitOutcome> = { acquired: false };
    for (let attempt = 1; attempt <= COUNT_LOCK_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, COUNT_LOCK_RETRY_MS));
      }
      // eslint-disable-next-line no-await-in-loop
      held = await withAdvisoryLock({ family: "stock-count", key: id, mode: "try" }, fn);
      if (held.acquired) break;
    }
    return held;
  }

  /** The body of the committer: runs only while the caller holds the session's `stock-count` lock. */
  private async commitStockCountBatches(args: {
    id: string;
    reference: string;
    effectiveDate: Date;
    notes?: string;
    finishWithSkips: boolean;
    user: { sub: string };
  }): Promise<StockCountCommitOutcome> {
    const { id, reference, effectiveDate, notes, finishWithSkips, user } = args;

    // Under the lock: no edit is in flight and none can start. Re-read the session AND its lines - a
    // committer that waited out an edit sees the finished edit; one that waited out another committer
    // (or whose predecessor finished and lost its response) must not start over; one that waited out a
    // discard must not move stock under a DISCARDED session.
    const fresh = await this.prisma.forTenant().stockCountSession.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!fresh) throw new NotFoundException("Stock count session not found");
    if (fresh.status === "DISCARDED") throw new BadRequestException("This count was discarded");
    if (fresh.status === "COMMITTED") {
      return this.alreadyCommittedOutcome(id, reference, fresh.lines.length);
    }
    if (fresh.lines.length === 0) throw new BadRequestException("Nothing counted yet");

    // The batch order: productId, then line id (stable across a resume).
    const byProductThenId = (a: { productId: string; id: string }, b: typeof a) =>
      a.productId === b.productId ? (a.id < b.id ? -1 : 1) : a.productId < b.productId ? -1 : 1;
    const lines = [...fresh.lines].sort(byProductThenId);

    // One open count per product (SA-767 r-note 5 SA-3): an overlap left by legacy sessions refuses the
    // commit before anything is written, "finish with skips" included. The operator removes the
    // products from one of the counts.
    const overlaps = await this.findOpenCountConflicts(
      this.prisma.forTenant(),
      [...new Set(lines.map((l) => l.productId))],
      id,
    );
    if (overlaps.length > 0) throw productInOpenCount(overlaps);

    const countProducts = await this.readCountProducts(lines);
    const { productMap } = countProducts;

    // Which lines go to the batches. Normally all of them, after the pre-check: a missing product is a
    // 404 naming the ids, a FAMILY is the WS8 400 - the commit stops and writes nothing new.
    // "Finish with skips" (SA-767 L-2.4 C, r-note 4 C) instead SKIPS and RECORDS every line whose
    // product is permanently uncountable (a FAMILY now, or gone) and commits the rest. A line whose
    // movement already exists is done and is never a skip. Only a partly saved count may use it.
    // Transient errors (lock timeouts, deadlocks) are not classified here at all: they come out of the
    // batches as the retry / 503 they always were.
    let batchLines = lines;
    const skippedProducts: StockCountSkippedProduct[] = [];
    if (finishWithSkips) {
      const started = await this.prisma.forTenant().stockMovement.findMany({
        where: { reference, ...(fresh.startedAt ? { createdAt: { gte: fresh.startedAt } } : {}) },
        select: { productId: true },
      });
      if (started.length === 0) {
        throw new BadRequestException(
          "Finish with skips is only for a count that was partly saved. Fix or remove the line instead.",
        );
      }
      const done = new Set(started.map((m) => m.productId));
      batchLines = lines.filter((l) => {
        if (done.has(l.productId)) return true;
        const product = productMap.get(l.productId);
        const reason: StockCountSkipReason | null = !product
          ? "PRODUCT_DELETED"
          : product.kind === "FAMILY"
            ? "PRODUCT_IS_FAMILY"
            : null;
        if (!reason) return true;
        skippedProducts.push({
          productId: l.productId,
          ...(product ? { name: product.name } : {}),
          reason,
        });
        return false;
      });
    } else {
      this.refuseUncountableProducts(countProducts);
    }

    const movementIds: string[] = [];
    const costMovementIds: string[] = [];
    let skipped = 0;
    for (let i = 0; i < batchLines.length; i += COUNT_COMMIT_BATCH) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await this.commitStockCountBatch(batchLines.slice(i, i + COUNT_COMMIT_BATCH), {
        reference,
        effectiveDate,
        notes,
        userId: user.sub,
        finishWithSkips,
      });
      // A product that became a FAMILY after the pre-checks, found under the batch lock (SA-767 n2).
      skippedProducts.push(...batch.skippedFamilies);
      movementIds.push(...batch.movementIds);
      costMovementIds.push(...batch.costMovementIds);
      skipped += batch.skipped;
      // Never inside the transaction: after THIS batch committed.
      if (batch.restockedProductIds.length > 0) this.fireStockAlerts(batch.restockedProductIds);
    }

    // Each skip is a line in the session's notes (appended after the committer's own note), written
    // by the same CAS that commits the session: the record cannot be lost between the two.
    const skipNotes = skippedProducts.map(stockCountSkipNote);
    const finalNotes =
      skipNotes.length > 0
        ? [notes ?? fresh.notes, ...skipNotes].filter((n) => !!n).join("\n")
        : notes;

    // The CAS: only the committer that still finds the session OPEN / REVIEW flips it.
    const flipped = await this.prisma.forTenant().stockCountSession.updateMany({
      where: { id, status: { in: ["OPEN", "REVIEW"] } },
      data: {
        status: "COMMITTED",
        committedAt: new Date(),
        committedById: user.sub,
        movementReference: reference,
        ...(finalNotes !== undefined ? { notes: finalNotes } : {}),
      },
    });
    if (flipped.count === 0) {
      const now = await this.prisma.forTenant().stockCountSession.findUnique({
        where: { id },
        select: { status: true },
      });
      if (now?.status === "DISCARDED") throw new BadRequestException("This count was discarded");
      return this.alreadyCommittedOutcome(id, reference, lines.length);
    }

    // One audit row per skipped line, only by the committer whose CAS landed (a lost CAS recorded
    // nothing above, so nothing is audited twice). AuditService.log never throws.
    for (const skip of skippedProducts) {
      // eslint-disable-next-line no-await-in-loop
      await this.audit?.log({
        tenantId: this.prisma.getTenantId() ?? null,
        userId: user.sub,
        action: "stock-count.line-skipped",
        entityType: "stock-count",
        entityId: id,
        meta: { sessionId: id, productId: skip.productId, reason: skip.reason },
      });
    }

    return {
      sessionId: id,
      reference,
      applied: movementIds.length,
      skipped,
      movementIds,
      costMovementIds,
      skippedProducts,
    };
  }

  private alreadyCommittedOutcome(
    id: string,
    reference: string,
    lineCount: number,
  ): StockCountCommitOutcome {
    return {
      sessionId: id,
      reference,
      applied: 0,
      skipped: lineCount,
      movementIds: [],
      alreadyCommitted: true,
    };
  }

  /** The products behind a count's lines, as they are now (tenant-scoped). */
  private async readCountProducts(lines: ReadonlyArray<{ productId: string }>) {
    const productIds = Array.from(new Set(lines.map((l) => l.productId)));
    const products = await this.prisma
      .forTenant()
      .product.findMany({ where: { id: { in: productIds } } });
    return { productIds, products, productMap: new Map(products.map((p) => [p.id, p])) };
  }

  /** The plain commit's refusals: a missing product is a 404 naming the ids, a FAMILY the WS8 400. */
  private refuseUncountableProducts(counted: {
    productIds: string[];
    products: Array<{ id: string; name?: string | null; kind?: string | null }>;
    productMap: Map<string, unknown>;
  }) {
    const missingProductIds = counted.productIds.filter((pid) => !counted.productMap.has(pid));
    if (missingProductIds.length > 0) {
      throw new NotFoundException({
        message: "One or more products could not be found",
        missingProductIds,
      });
    }
    assertSellableLines(counted.products); // WS8
  }

  /**
   * ONE batch of a count commit, its own short tx (SA-767 L-2.2): lock the batch's products (role
   * rank, one statement), read them locked, then per line: SKIP when a movement with this session's
   * reference already exists for the product (an earlier, interrupted run applied it - checked under
   * the product lock, so a resume never applies a line twice), else apply the cost correction and then
   * the adjustment. REPLACE is `counted - the line's expectedQty`, ADD is `counted`, written as an
   * increment with `stockAfter` from the UPDATE's returned row. The whole tx re-runs on
   * 40P01 / 40001 / P2034 / 55P03 / P2028 and every attempt starts from clean state.
   */
  private async commitStockCountBatch(
    batch: StockCountBatchLine[],
    ctx: {
      reference: string;
      effectiveDate: Date;
      notes?: string;
      userId: string;
      finishWithSkips: boolean;
    },
  ) {
    const { reference } = ctx;
    const productIds = batch.map((l) => l.productId);
    return retryStockTx("inventory.commitStockCountSession", () =>
      this.prisma.tenantTransaction(
        async (tx) => {
          await this.lockProducts(tx, productIds);
          const lockedMap = await this.readLockedStockRows(tx, productIds);

          // Idempotent resume: a movement of this reference for the product means the line is done.
          const done = await tx.stockMovement.findMany({
            where: { reference, productId: { in: productIds } },
            select: { id: true, productId: true, type: true },
          });
          const doneProducts = new Set(done.map((m) => m.productId));
          const movementIds = done
            .filter((m) => m.type === MovementType.ADJUSTMENT)
            .map((m) => m.id);
          const costMovementIds = done
            .filter((m) => m.type === MovementType.COST_BASIS)
            .map((m) => m.id);
          let pending = batch.filter((l) => !doneProducts.has(l.productId));

          // The pre-checks read these products BEFORE the lock; one can have been variant-assigned (become
          // a FAMILY) since. Re-check `kind` on the locked rows (SA-767 n2): it is permanent, so without
          // the flag it is the same coded 400 the pre-check throws (nothing of this batch is written), and
          // with "finish with skips" the line is skipped here and recorded by the caller.
          const skippedFamilies: StockCountSkippedProduct[] = [];
          const familyLines = pending.filter((l) => lockedMap.get(l.productId)?.kind === "FAMILY");
          if (familyLines.length > 0) {
            if (!ctx.finishWithSkips) {
              assertSellableLines(familyLines.map((l) => lockedMap.get(l.productId)!)); // WS8
            }
            for (const l of familyLines) {
              skippedFamilies.push({
                productId: l.productId,
                name: lockedMap.get(l.productId)!.name,
                reason: "PRODUCT_IS_FAMILY",
              });
            }
            pending = pending.filter((l) => !familyLines.includes(l));
          }

          // 1) Cost corrections first — see the ordering note on commitStockCountSession.
          const correctedCosts = new Map<string, Prisma.Decimal>();
          for (const line of pending) {
            if (line.unitCostOverride == null) continue;
            const unitCost = costDecimal(Number(line.unitCostOverride));
            // Present at the pre-tx validation read, gone under the lock: a 404, not a TypeError.
            const locked = lockedMap.get(line.productId);
            if (!locked) throw new NotFoundException("Product not found");
            const movement = await this.setCostBasisInTx(
              tx,
              locked,
              {
                unitCost: Number(line.unitCostOverride),
                notes: `Stock count ${reference}`,
              } as SetCostBasisDto,
              ctx.userId,
              reference,
            );
            costMovementIds.push(movement.id);
            correctedCosts.set(line.productId, unitCost);
          }

          // 2) Then the quantity adjustments, through the SHARED routine so the durable path can never
          //    drift from the legacy one.
          const restockedProductIds: string[] = [];
          const applied = await this.applyStockCountItemsInTx(tx, {
            items: pending.map((l) => ({
              productId: l.productId,
              quantity: Number(l.countedQty),
              mode: l.mode as "REPLACE" | "ADD",
              expectedQty: l.expectedQty,
            })),
            lockedMap,
            reference,
            effectiveDate: ctx.effectiveDate,
            notes: ctx.notes,
            performedById: ctx.userId,
            restockedProductIds,
            correctedCosts,
          });
          movementIds.push(...applied.movementIds);

          return {
            movementIds,
            costMovementIds,
            skipped: applied.skipped,
            restockedProductIds,
            skippedFamilies,
          };
        },
        // One batch is at most COUNT_COMMIT_BATCH lines (a movement create + product update, + a lot on a
        // positive delta, each): well inside this budget, and a stuck batch fails instead of hanging.
        { timeout: 60_000 },
      ),
    );
  }

  // ─── Cost recompute (history-preserving) ────────────────────────────────────

  /**
   * B562 PR-3 (SA-136 §4): check — and on apply, correct — each product's average cost by replaying
   * its movement ledger. **Dry run is the default** (`dryRun` omitted ⇒ true). The apply path writes
   * ONLY the §4 correction: one appended `COST_BASIS` row + `Product.averageCost`, per product whose
   * replayed average differs — no existing movement is ever rewritten. Products whose ledger can't
   * account for their `currentStock` are reported under `gapsDetected` and never written; products
   * with no costful history (no PURCHASE with a unit cost, no manual COST_BASIS) under `noHistory`.
   * Every apply writes an audit row naming the corrections.
   */
  async recomputeCosts(dto: RecomputeCostsDto, performedById: string | null = null) {
    const dryRun = dto.dryRun !== false;
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
      gap: number;
      oldAvgCost: number | null;
      newAvgCost: number | null;
      correctionId: string | null;
    }[] = [];
    const noHistory: { productId: string; name: string }[] = [];
    const gapsDetected: { productId: string; name: string; stockDrift: number }[] = [];

    for (const product of products) {
      // One transaction per product to bound lock time on big tenants.
      const replay = dryRun
        ? await this.replayProduct(product, null)
        : await this.prisma.tenantTransaction((tx) =>
            this.replayProduct(product, tx, { trigger: "ENDPOINT", performedById }),
          );

      if (replay.gapDetected) {
        gapsDetected.push({
          productId: product.id,
          name: product.name,
          stockDrift: replay.stockDrift,
        });
      } else if (!replay.hasCostfulHistory) {
        noHistory.push({ productId: product.id, name: product.name });
      } else {
        results.push({
          productId: product.id,
          name: product.name,
          gap: replay.stockDrift,
          oldAvgCost: replay.oldAvgCost,
          newAvgCost: replay.newAvgCost,
          correctionId: replay.correctionId,
        });
      }
    }

    const corrected = results.filter((r) => r.correctionId != null);
    if (!dryRun) {
      await this.audit?.log({
        tenantId: this.prisma.getTenantId() ?? null,
        userId: performedById,
        action: "INVENTORY_RECOMPUTE_COSTS_APPLY",
        entityType: "inventory",
        meta: {
          reason: dto.reason ?? null,
          processed: products.length,
          corrections: corrected.map(({ productId, oldAvgCost, newAvgCost, correctionId }) => ({
            productId,
            oldAvgCost,
            newAvgCost,
            correctionId,
          })),
          gapsDetected: gapsDetected.map((g) => g.productId),
        },
      });
    }

    return {
      dryRun,
      processed: products.length,
      // Products whose average this call corrected (0 on a dry run). Kept as `updated` for the
      // shared RecomputeCostsResult contract.
      updated: corrected.length,
      noHistory,
      gapsDetected,
      results,
    };
  }

  /** Replay a single product inside an existing transaction (the backdated-write check). */
  // Public: every stock writer that supports an effective date in the past (manual purchase,
  // adjustment, vendor-bill receive at billDate) calls this after its own write, so a backdated row
  // that changes the average gets its dated COST_BASIS correction (SA-136 §4).
  //
  // throwOnGap defaults to true because this call sits mid-transaction inside a live write
  // (recordPurchase/recordAdjustment): if the ledger can't account for currentStock, the whole
  // backdated write must fail loudly and roll back rather than correct the average off a replay that
  // can't be trusted. Vendor-bill receive passes `{ throwOnGap: false }` and flags the one gapped line
  // instead of aborting the bill (vendor-bills.service.ts `receive()`).
  async recomputeProductInTx(
    tx: Prisma.TransactionClient,
    productId: string,
    opts: { throwOnGap?: boolean; trigger?: string; performedById?: string | null } = {},
  ) {
    const product = await tx.product.findFirst({
      where: { id: productId },
      select: { id: true, name: true, currentStock: true, averageCost: true, costingMethod: true },
    });
    if (!product) return null;
    return this.replayProduct(product, tx, { ...opts, throwOnGap: opts.throwOnGap ?? true });
  }

  /**
   * B562 PR-3 (SA-136 §4): a PURE computation over the ledger — movements in accounting order
   * (effectiveAt, createdAt, id) folded with a running (stock, avg):
   * - COST_BASIS (a manual/owner cost basis) ⇒ avg := unitCost
   * - PURCHASE with unitCost ⇒ weighted average update
   * - ADJUSTMENT with unitCost ⇒ weighted forward (qty>0) / exact reverse (qty<0)
   * - everything else (SALE / RETURN / WRITE_OFF / quantity-only) ⇒ quantity only
   *
   * Snapshots are WRITE-ONCE: this never updates an existing row's `avgCostAfter`/`stockAfter` — a
   * row keeps the state after ITS insertion. `gap = currentStock − Σquantity`:
   * - gap ≠ 0 ⇒ the ledger can't explain the counter, the fold ran on a wrong stock balance, and
   *   nothing is written (throw when `throwOnGap`, else report) — the L-207 guard.
   * - gap = 0 and |impliedAvg − averageCost| ≥ 0.0001 — or |impliedAvg − the last row's
   *   avgCostAfter| ≥ 0.0001, the as-of-now snapshot the cost index reads — (with a tx) ⇒ APPEND one COST_BASIS row
   *   (quantity 0, unitCost = avgCostAfter = impliedAvg, stockAfter = the counter, effectiveAt = now,
   *   reference `RECOMPUTE:<trigger>`, notes `old → new`) and set `Product.averageCost`. The
   *   correction is dated when it is made, so prior-period COGS reports do not move.
   *
   * A `RECOMPUTE:` row is this fold's own OUTPUT, never an input: folding it would pin the average
   * at the moment it was written, so any row later inserted with an earlier effectiveAt (the next
   * backdated purchase) would be erased by it and the replay would "correct" the average back to a
   * stale figure. Manual cost-basis rows remain inputs.
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
    opts: { throwOnGap?: boolean; trigger?: string; performedById?: string | null } = {},
  ) {
    const client = tx ?? this.prisma.forTenant();
    // B562 (SA-136 §3): accounting order — effectiveAt, then insertion time, then id.
    const movements = await client.stockMovement.findMany({
      where: { productId: product.id },
      orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        type: true,
        quantity: true,
        unitCost: true,
        reference: true,
        avgCostAfter: true,
      },
    });
    // The as-of-now snapshot the point-in-time cost index reads (the last row in accounting order).
    const tailAvg = movements.length ? movements[movements.length - 1].avgCostAfter : null;

    // STANDARD products keep averageCost frozen — the live recordPurchase path
    // deliberately never moves it (valuation reads standardCost). Replaying the
    // weighted average here would fabricate a bogus correction, so mirror that:
    // carry the existing average forward untouched and never correct it.
    const isStandard = product.costingMethod === CostingMethod.STANDARD;

    let stock = new Prisma.Decimal(0);
    let avg: Prisma.Decimal | null = isStandard
      ? product.averageCost != null
        ? costDecimal(product.averageCost)
        : null
      : null;
    let hasCostfulHistory = isStandard && avg != null;

    for (const m of movements) {
      const qty = new Prisma.Decimal(m.quantity);
      const unitCost = m.unitCost != null ? new Prisma.Decimal(m.unitCost) : null;

      if (!isStandard) {
        switch (m.type) {
          case MovementType.COST_BASIS:
            if (unitCost != null && !isReplayCorrection(m)) {
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
    }

    const stockDrift = new Prisma.Decimal(product.currentStock).sub(stock);
    const gapDetected = !stockDrift.isZero();
    const oldAvgCost = product.averageCost != null ? Number(product.averageCost) : null;

    if (gapDetected) {
      if (opts.throwOnGap) {
        // Operator-readable message (no internals — bug id, table names, file
        // paths); `code` carries the machine/log-readable detail, matching the
        // UNLINKED_ITEMS/DUPLICATE_VENDOR_BILL structured-conflict shape used
        // elsewhere in this codebase.
        throw new ConflictException({
          code: API_ERROR_CODES.INVENTORY_LEDGER_GAP,
          message:
            `"${product.name}" can't be updated right now — its stock records don't fully ` +
            "explain the quantity currently on hand (this usually happens after past sales). " +
            "Ask an admin to look into this product before backdating a purchase or adjustment " +
            "for it.",
          productId: product.id,
          name: product.name,
          stockDrift: Number(stockDrift),
        });
      }
      return {
        hasCostfulHistory,
        oldAvgCost,
        newAvgCost: null,
        stockDrift: Number(stockDrift),
        gapDetected: true,
        correctionId: null,
      };
    }

    // The ledger explains the counter: the fold is trustworthy. Append the dated correction when the
    // average differs (STANDARD never — its average is frozen by contract) — from
    // `Product.averageCost`, OR from the as-of-now snapshot: a backdated row sorts before rows that
    // were written earlier, so the LAST row in accounting order can hold a stale average even when
    // `averageCost` is right (always, for a purchase-only ledger), and the cost index would read it
    // for the current period. The correction, dated now, is then the row the index reads.
    const differs = (x: Prisma.Decimal | null | undefined) =>
      avg != null && (x == null || avg.sub(x).abs().gte(AVG_CORRECTION_EPSILON));
    const productDrifted = differs(product.averageCost);
    const drifted =
      !isStandard && hasCostfulHistory && avg != null && (productDrifted || differs(tailAvg));
    let correctionId: string | null = null;
    if (tx && drifted && avg != null) {
      const updated = await tx.product.update({
        where: { id: product.id },
        data: { averageCost: avg },
        select: { currentStock: true },
      });
      const correction = await tx.stockMovement.create({
        data: {
          productId: product.id,
          type: MovementType.COST_BASIS,
          quantity: new Prisma.Decimal(0),
          unitCost: avg,
          avgCostAfter: avg,
          stockAfter: updated.currentStock,
          reference: `${REPLAY_CORRECTION_PREFIX}${opts.trigger ?? "ENDPOINT"}`,
          notes: productDrifted
            ? `${product.averageCost != null ? costDecimal(product.averageCost).toString() : "none"} → ${avg.toString()}`
            : `as-of-now snapshot ${tailAvg != null ? costDecimal(tailAvg).toString() : "none"} → ${avg.toString()}`,
          performedById: opts.performedById ?? null,
        },
        select: { id: true },
      });
      correctionId = correction.id;
    }

    return {
      hasCostfulHistory,
      oldAvgCost,
      newAvgCost: avg != null ? Number(avg) : null,
      stockDrift: Number(stockDrift),
      gapDetected: false,
      correctionId,
    };
  }
}
