import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import {
  PricingRulesNotReadyError,
  applyCellPatches,
  ladderPrice,
  materializePack,
  planCellEdit,
  priceSource,
  rowOf,
  roundMoney,
  validateSetPrice,
  type CellPatch,
  type PriceTier,
} from "@routeflow/pricing";
import type {
  CustomerPriceConflict,
  CustomerPriceMove,
  PriceCellPatch,
  SavePricesRequest,
  SavePricesResponse,
  SkippedCustomerCell,
  UndoPricesRequest,
  UndoSkipCell,
} from "@routeflow/types";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  STOCK_TX_OPTIONS,
  lockProductsForStock,
  setStockLockTimeout,
} from "../common/product-locks";
import { familyPriceAuthorityError } from "./family-price";
import { assertOrderUnitSwitchAllowed, pricingRulesNotReady } from "../common/pricing-rules-ready";
import { PrismaService } from "../prisma/prisma.service";
import {
  ProductPriceGridService,
  addUnitFirst,
  governedReason,
  type PriceModel,
} from "./product-price-grid.service";

type Tx = any;

const STALE_MESSAGE =
  "These prices changed since you opened them. Reload to see the latest, then try again.";
const SKIP_NOT_REPORTED = "Only a customer price listed as changed can be skipped when undoing.";
const UNDO_UNAVAILABLE_MESSAGE = "That change can no longer be undone.";

const cellKey = (c: { ref: string; tier: number }) => `${c.ref}|${c.tier}`;
const sameMoney = (a: number | null, b: number | null) =>
  (a == null ? null : roundMoney(a)) === (b == null ? null : roundMoney(b));

/**
 * Units v2 price writes (SA-796 R-1, SA-799 b): POST products/:productId/prices and .../prices/undo.
 *
 * ONE transaction per call: lock the Product row, re-read the grid model under the lock, compare the client's
 * revision AND price-state token (R-1's value compare-and-set: legacy writers skip the revision bump), re-plan the
 * patches and keeps from the fresh view with the pricing core (a client's follower values are never trusted), write the
 * pack columns through `materializePack` and the unit rows, move customer cells under their own row locks and
 * per-cell value compare-and-set, bump `priceRevision` once in the same UPDATE as the pack columns, and write ONE audit
 * row that stores the inverse. Any mismatch is a 409 LADDER_REVISION_STALE with nothing written. No money math lives
 * here: every price is a core result or a `roundMoney`ed input.
 */
@Injectable()
export class ProductPriceWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grid: ProductPriceGridService,
  ) {}

  save(
    productId: string,
    dto: SavePricesRequest,
    actorId: string | null,
  ): Promise<SavePricesResponse> {
    return this.locked(productId, async (tx, m, tenantId) => {
      this.assertNotGoverned(m);
      this.assertFresh(m, dto.expectedRevision, dto.expectedPriceState);
      if (dto.orderUnit != null && dto.orderUnit !== m.view.anchor) assertOrderUnitSwitchAllowed();

      const cells = this.planCells(m, dto);
      const moves = await this.checkMoves(tx, m, productId, tenantId, dto.customerMoves ?? []);
      const { inverse } = await this.apply(tx, m, productId, cells, moves);

      const request = {
        patches: dto.patches,
        keeps: dto.keeps ?? [],
        customerMoves: dto.customerMoves ?? [],
        ...(dto.orderUnit != null ? { orderUnit: dto.orderUnit } : {}),
      };
      const undo = { patches: inverse.patches, customerMoves: moves.inverse };
      const audit = await tx.auditLog.create({
        data: {
          userId: actorId,
          action: AUDIT_ACTIONS.PRODUCT_PRICES_SAVED,
          entityType: "Product",
          entityId: productId,
          meta: {
            request,
            undo,
            revisionBefore: m.revision,
            revisionAfter: m.revision + 1,
            actor: actorId,
          },
        },
        select: { id: true },
      });
      const fresh = await this.grid.read(tx, productId);
      return { revision: fresh.revision, auditId: audit.id, undo, grid: fresh.grid };
    });
  }

  undo(
    productId: string,
    dto: UndoPricesRequest,
    actorId: string | null,
  ): Promise<SavePricesResponse> {
    return this.locked(productId, async (tx, m, tenantId) => {
      this.assertNotGoverned(m);
      const saved = await tx.auditLog.findFirst({
        where: {
          id: dto.auditId,
          tenantId,
          entityType: "Product",
          entityId: productId,
          action: AUDIT_ACTIONS.PRODUCT_PRICES_SAVED,
        },
        select: { id: true, meta: true },
      });
      const stored = (
        saved?.meta as {
          undo?: { patches?: PriceCellPatch[]; customerMoves?: CustomerPriceMove[] };
        } | null
      )?.undo;
      if (!saved || !stored) throw this.undoUnavailable();
      const already = await tx.auditLog.findFirst({
        where: {
          tenantId,
          entityType: "Product",
          entityId: productId,
          action: AUDIT_ACTIONS.PRODUCT_PRICES_UNDONE,
          meta: { path: ["undoes"], equals: dto.auditId },
        },
        select: { id: true },
      });
      if (already) throw this.undoUnavailable();
      this.assertFresh(m, dto.expectedRevision, dto.expectedPriceState);

      const patches = (stored.patches ?? []).map((p) => ({
        ref: p.ref,
        tier: p.tier as PriceTier,
        to: p.to == null ? null : roundMoney(p.to),
      }));
      // A unit deleted since the save: its cells cannot be put back.
      if (patches.some((p) => !m.view.rows.some((r) => r.ref === p.ref)))
        throw this.undoUnavailable();
      // Strict: if ANY customer cell the inverse would restore changed since the save, the whole undo is refused
      // (409 with `conflicts`), never partly applied.
      const moves = await this.checkMoves(
        tx,
        m,
        productId,
        tenantId,
        stored.customerMoves ?? [],
        false,
        dto.skip ?? [],
      );
      await this.apply(tx, m, productId, patches, moves);

      const audit = await tx.auditLog.create({
        data: {
          userId: actorId,
          action: AUDIT_ACTIONS.PRODUCT_PRICES_UNDONE,
          entityType: "Product",
          entityId: productId,
          meta: {
            undoes: dto.auditId,
            skipped: moves.skipped,
            revisionBefore: m.revision,
            revisionAfter: m.revision + 1,
            actor: actorId,
          },
        },
        select: { id: true },
      });
      const fresh = await this.grid.read(tx, productId);
      return {
        revision: fresh.revision,
        auditId: audit.id,
        grid: fresh.grid,
        ...(moves.skipped.length > 0 ? { skipped: moves.skipped } : {}),
      };
    });
  }

  // ─── planning ───────────────────────────────────────────────────────────────

  /** Patches then keeps, re-planned on the fresh view by the core. Throws 400 PRICE_EDIT_INVALID with every refusal. */
  private planCells(m: PriceModel, dto: SavePricesRequest): CellPatch[] {
    const keeps = dto.keeps ?? [];
    const customerMoves = dto.customerMoves ?? [];
    if (dto.patches.length === 0 && keeps.length === 0 && customerMoves.length === 0) {
      throw this.invalid(["There is nothing to save."]);
    }
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const c of [...dto.patches, ...keeps]) {
      if (seen.has(cellKey(c))) problems.push("A price is listed twice in this change.");
      seen.add(cellKey(c));
    }

    // The implicit base row has no ProductUnit: the price write never mints one (Add unit does, through
    // ProductUnitsService), so a price on it is refused before anything is planned.
    const baseRow = m.view.rows.find((r) => r.ref === "base");
    if (baseRow && [...dto.patches, ...keeps].some((c) => c.ref === "base")) {
      problems.push(addUnitFirst(baseRow.label));
    }

    let view = m.view;
    const out: CellPatch[] = [];
    for (const p of dto.patches) {
      if (p.ref === "base" && baseRow) continue;
      const plan = planCellEdit(view, p.ref, p.tier as PriceTier, p.to, m.rules);
      if (plan.problems.length > 0) {
        problems.push(...plan.problems);
        continue;
      }
      view = plan.view;
      out.push(...plan.patches);
    }
    for (const k of keeps) {
      if (k.ref === "base" && baseRow) continue;
      const row = m.view.rows.find((r) => r.ref === k.ref);
      if (!row) {
        problems.push("That unit is not on this product.");
        continue;
      }
      // Already a set price: nothing to keep. The value a Keep pins is the fresh view's, never the client's.
      if (priceSource(rowOf(m.view, k.ref), k.tier as PriceTier) === "set") continue;
      const shown = ladderPrice(m.view, k.ref, k.tier as PriceTier, m.rules);
      if (!sameMoney(shown, k.value)) {
        problems.push(`${row.label}: that price is not what it shows now.`);
        continue;
      }
      const plan = planCellEdit(view, k.ref, k.tier as PriceTier, shown, m.rules);
      if (plan.problems.length > 0) {
        problems.push(...plan.problems);
        continue;
      }
      view = plan.view;
      out.push(...plan.patches);
    }
    if (problems.length > 0) throw this.invalid([...new Set(problems)]);
    return out;
  }

  /**
   * Validates the customer cells, locks their rows (ordered) and applies the value compare-and-set: every cell whose
   * row no longer holds `from` is a conflict, and any conflict is a 409 LADDER_REVISION_STALE listing them all.
   */
  private async checkMoves(
    tx: Tx,
    m: PriceModel,
    productId: string,
    tenantId: string,
    raw: readonly CustomerPriceMove[],
    requireLiveCustomers = true,
    skip: readonly UndoSkipCell[] = [],
  ) {
    const problems: string[] = [];
    const seen = new Set<string>();
    const wanted = raw.map((mv) => ({
      customerId: mv.customerId,
      ref: mv.ref,
      tier: mv.tier,
      from: mv.from == null ? null : roundMoney(mv.from),
      to: mv.to == null ? null : roundMoney(mv.to),
    }));
    for (const mv of wanted) {
      const key = `${mv.customerId}|${mv.ref}`;
      if (seen.has(key)) {
        problems.push(
          `The customer price for ${mv.customerId} on ${mv.ref} is listed twice in this change.`,
        );
      }
      seen.add(key);
      const unitRow = m.view.rows.find((r) => r.ref === mv.ref);
      if (!unitRow) problems.push("That unit is not on this product.");
      else if (mv.ref === "base") problems.push(addUnitFirst(unitRow.label));
      if (mv.from == null && mv.to == null)
        problems.push("A customer price change needs a new price.");
      if ((mv.from != null && mv.from <= 0) || (mv.to != null && !validateSetPrice(mv.to).ok)) {
        problems.push("A customer price must be above $0.00.");
      }
    }
    const ids = [...new Set(wanted.map((mv) => mv.customerId))].sort();
    if (ids.length === 0) {
      if (skip.length > 0) throw this.invalid([SKIP_NOT_REPORTED]);
      return {
        writes: [] as WriteMove[],
        inverse: [] as CustomerPriceMove[],
        skipped: [] as SkippedCustomerCell[],
      };
    }

    // A save may only target a live customer (not outside the tenant, not soft-deleted). An Undo restores cells the
    // save wrote when the customer was live; a customer gone since shows up as a conflict below instead.
    if (requireLiveCustomers) {
      const found: { id: string }[] = await tx.customer.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true },
      });
      if (found.length !== ids.length) problems.push("A customer on this change was not found.");
    }
    if (problems.length > 0) throw this.invalid([...new Set(problems)]);

    await tx.$executeRaw`SELECT id FROM "CustomerUnitPrice" WHERE "productId" = ${productId} AND "tenantId" = ${tenantId} AND "customerId" = ANY(${ids}::text[]) ORDER BY "customerId", "unitRef" FOR UPDATE`;
    const rows: { id: string; customerId: string; unitRef: string; price: unknown }[] =
      await tx.customerUnitPrice.findMany({
        where: { productId, customerId: { in: ids } },
        select: { id: true, customerId: true, unitRef: true, price: true },
      });
    const byKey = new Map(rows.map((r) => [`${r.customerId}|${r.unitRef}`, r]));

    const writes: WriteMove[] = [];
    const inverse: CustomerPriceMove[] = [];
    const conflicts: CustomerPriceConflict[] = [];
    const skipped: SkippedCustomerCell[] = [];
    const skipByKey = new Map<string, UndoSkipCell>();
    for (const k of skip) {
      const key = `${k.customerId}|${k.ref}`;
      if (skipByKey.has(key)) throw this.invalid(["A skipped customer price is listed twice."]);
      skipByKey.set(key, k);
    }
    const reported = new Set<string>();
    for (const mv of wanted) {
      const row = byKey.get(`${mv.customerId}|${mv.ref}`);
      const current = row ? roundMoney(Number(row.price)) : null;
      if (current !== mv.from) {
        const key = `${mv.customerId}|${mv.ref}`;
        reported.add(key);
        const asked = skipByKey.get(key);
        // A skip is a compare-and-set on what the preview showed: still that value -> left as it is.
        if (asked && (asked.seen == null ? null : roundMoney(asked.seen)) === current) {
          skipped.push({ customerId: mv.customerId, ref: mv.ref, tier: mv.tier, current });
          continue;
        }
        conflicts.push({
          customerId: mv.customerId,
          ref: mv.ref,
          tier: mv.tier,
          expected: mv.from,
          current,
        });
        continue;
      }
      if (mv.from === mv.to) continue; // no change
      writes.push({ ...mv, rowId: row?.id ?? null });
      inverse.push({
        customerId: mv.customerId,
        ref: mv.ref,
        tier: mv.tier,
        from: mv.to,
        to: mv.from,
      });
    }
    // Only a customer cell that is in conflict can be skipped; anything else (a product cell, a cell that was never
    // reported) is a malformed request, whatever else is stale.
    if ([...skipByKey.keys()].some((key) => !reported.has(key))) {
      throw this.invalid([SKIP_NOT_REPORTED]);
    }
    if (conflicts.length > 0) throw this.stale(m, conflicts);
    return { writes, inverse, skipped };
  }

  // ─── writing ────────────────────────────────────────────────────────────────

  /** The pack columns (with the one revision bump), the changed unit rows, the customer cells. Returns the inverse patches. */
  private async apply(
    tx: Tx,
    m: PriceModel,
    productId: string,
    patches: readonly CellPatch[],
    moves: { writes: WriteMove[] },
  ) {
    const applied = applyCellPatches(m.view, patches);
    let pack;
    try {
      pack = materializePack(applied.view, m.rules);
    } catch (e) {
      if (e instanceof PricingRulesNotReadyError) throw pricingRulesNotReady();
      throw e;
    }
    await tx.product.update({
      where: { id: productId },
      data: {
        pricePerUnit: roundMoney(pack.pricePerUnit),
        priceTier2: roundMoney(pack.priceTier2),
        priceTier3: roundMoney(pack.priceTier3),
        priceTier4: roundMoney(pack.priceTier4),
        priceTier5: roundMoney(pack.priceTier5),
        packAuto: pack.packAuto,
        priceRevision: { increment: 1 },
      },
    });

    for (const row of applied.view.rows) {
      if (row.ref === "pack") continue;
      const before = m.view.rows.find((r) => r.ref === row.ref);
      if (!before || before.set.every((v, i) => sameMoney(v, row.set[i]))) continue;
      const data = {
        price: money(row.set[0]),
        priceTier2: money(row.set[1]),
        priceTier3: money(row.set[2]),
        priceTier4: money(row.set[3]),
        priceTier5: money(row.set[4]),
      };
      // Never a unit mint: a price on the implicit base row was refused in planning (Add unit creates it).
      if (row.ref === "base") throw this.invalid([addUnitFirst(row.label)]);
      await tx.productUnit.update({ where: { id: row.ref }, data });
    }

    for (const w of moves.writes) {
      if (w.to == null) await tx.customerUnitPrice.deleteMany({ where: { id: w.rowId } });
      else if (w.rowId)
        await tx.customerUnitPrice.update({ where: { id: w.rowId }, data: { price: w.to } });
      else {
        await tx.customerUnitPrice.create({
          data: { customerId: w.customerId, productId, unitRef: w.ref, price: w.to },
        });
      }
    }

    const inversePatches: PriceCellPatch[] = applied.undo.map((p) => ({
      ref: p.ref,
      tier: p.tier,
      to: p.to,
    }));
    return { inverse: { patches: inversePatches } };
  }

  // ─── plumbing ───────────────────────────────────────────────────────────────

  private async locked<T>(
    productId: string,
    fn: (tx: Tx, m: PriceModel, tenantId: string) => Promise<T>,
  ): Promise<T> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("Select a tenant before editing prices.");
    let current: PriceModel | undefined;
    try {
      return await this.prisma.tenantTransaction(async (tx) => {
        // Same advisory lock as ProductUnitsService.locked, taken FIRST (house order: advisory, then row), so a unit
        // add / edit / delete is serialised with this write. The lock timeout is set before any lock wait.
        await setStockLockTimeout(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext(${productId}))`;
        await lockProductsForStock(tx, tenantId, [productId]);
        current = await this.grid.read(tx, productId);
        return fn(tx, current, tenantId);
      }, STOCK_TX_OPTIONS);
    } catch (e) {
      // P2002: a customer cell inserted by someone else between our lock and our insert. P2025: a row we meant to
      // update is gone (a unit or customer cell deleted by a writer outside the locks). Both mean "changed since".
      const code = (e as { code?: string } | null)?.code;
      if ((code === "P2002" || code === "P2025") && current) throw this.stale(current);
      throw e;
    }
  }

  /**
   * The family owns a variant's, a family's and a recipe's price (family-price.ts): this writer never touches such a
   * row, so it can never bypass that authority. Family prices go through ProductsService (V20 is a later sprint).
   */
  private assertNotGoverned(m: PriceModel): void {
    const p = m.product;
    if (p.parentProductId) throw familyPriceAuthorityError(p.parentProductId);
    const reason = governedReason(p);
    if (reason) throw this.invalid([reason]);
  }

  private assertFresh(m: PriceModel, expectedRevision: number, expectedPriceState: string): void {
    if (m.revision !== expectedRevision || m.priceState !== expectedPriceState) throw this.stale(m);
  }

  private stale(m: PriceModel, conflicts?: CustomerPriceConflict[]): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: API_ERROR_CODES.LADDER_REVISION_STALE,
      message: STALE_MESSAGE,
      revision: m.revision,
      grid: m.grid,
      ...(conflicts ? { conflicts } : {}),
    });
  }

  private invalid(problems: string[]): BadRequestException {
    return new BadRequestException({
      statusCode: 400,
      code: API_ERROR_CODES.PRICE_EDIT_INVALID,
      message: problems[0],
      problems,
    });
  }

  private undoUnavailable(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE,
      message: UNDO_UNAVAILABLE_MESSAGE,
    });
  }
}

type WriteMove = {
  customerId: string;
  ref: string;
  tier: number;
  from: number | null;
  to: number | null;
  rowId: string | null;
};

const money = (v: number | null): number | null => (v == null ? null : roundMoney(v));
