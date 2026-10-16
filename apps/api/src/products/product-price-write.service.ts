import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import {
  PricingRulesNotReadyError,
  applyCellPatches,
  baseLabelOf,
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
  CustomerPriceMove,
  PriceCellPatch,
  SavePricesRequest,
  SavePricesResponse,
  UndoPricesRequest,
} from "@routeflow/types";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { STOCK_TX_OPTIONS, lockProductsForStock } from "../common/product-locks";
import { familyPriceAuthorityError } from "./family-price";
import { assertOrderUnitSwitchAllowed, pricingRulesNotReady } from "../common/pricing-rules-ready";
import { PrismaService } from "../prisma/prisma.service";
import { ProductPriceGridService, type PriceModel } from "./product-price-grid.service";

type Tx = any;

const STALE_MESSAGE =
  "These prices changed since you opened them. Reload to see the latest, then try again.";
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
      const moves = await this.checkMoves(
        tx,
        m,
        productId,
        tenantId,
        dto.customerMoves ?? [],
        false,
      );
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
      // Customer cells the inverse would touch that someone changed since are left as they are.
      const moves = await this.checkMoves(
        tx,
        m,
        productId,
        tenantId,
        stored.customerMoves ?? [],
        true,
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
            revisionBefore: m.revision,
            revisionAfter: m.revision + 1,
            skippedCustomerMoves: moves.skipped,
            actor: actorId,
          },
        },
        select: { id: true },
      });
      const fresh = await this.grid.read(tx, productId);
      return { revision: fresh.revision, auditId: audit.id, grid: fresh.grid };
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

    let view = m.view;
    const out: CellPatch[] = [];
    for (const p of dto.patches) {
      const plan = planCellEdit(view, p.ref, p.tier as PriceTier, p.to, m.rules);
      if (plan.problems.length > 0) {
        problems.push(...plan.problems);
        continue;
      }
      view = plan.view;
      out.push(...plan.patches);
    }
    for (const k of keeps) {
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
   * Validates the customer cells, locks their rows (ordered) and applies the value compare-and-set. `lenient` (Undo)
   * drops a cell whose row no longer holds `from`; a save refuses with 409.
   */
  private async checkMoves(
    tx: Tx,
    m: PriceModel,
    productId: string,
    tenantId: string,
    raw: readonly CustomerPriceMove[],
    lenient: boolean,
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
      if (!m.view.rows.some((r) => r.ref === mv.ref))
        problems.push("That unit is not on this product.");
      if (mv.from == null && mv.to == null)
        problems.push("A customer price change needs a new price.");
      if ((mv.from != null && mv.from <= 0) || (mv.to != null && !validateSetPrice(mv.to).ok)) {
        problems.push("A customer price must be above $0.00.");
      }
    }
    const ids = [...new Set(wanted.map((mv) => mv.customerId))].sort();
    if (ids.length === 0)
      return { writes: [] as WriteMove[], inverse: [] as CustomerPriceMove[], skipped: 0 };

    const found: { id: string }[] = await tx.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (found.length !== ids.length) problems.push("A customer on this change was not found.");
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
    let skipped = 0;
    for (const mv of wanted) {
      const row = byKey.get(`${mv.customerId}|${mv.ref}`);
      const current = row ? roundMoney(Number(row.price)) : null;
      if (current !== mv.from) {
        if (lenient) {
          skipped += 1;
          continue;
        }
        throw this.stale(m);
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

    const created: Record<string, string> = {};
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
      if (row.ref === "base") {
        // The implicit piece row has no ProductUnit yet; its first price creates it (factor 1, the base unit's name).
        const unit = await tx.productUnit.create({
          data: { productId, label: baseLabelOf(m.product), factorToBase: 1, ...data },
          select: { id: true },
        });
        created.base = unit.id;
      } else {
        await tx.productUnit.update({ where: { id: row.ref }, data });
      }
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
      ref: created[p.ref] ?? p.ref,
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
        await lockProductsForStock(tx, tenantId, [productId]);
        current = await this.grid.read(tx, productId);
        return fn(tx, current, tenantId);
      }, STOCK_TX_OPTIONS);
    } catch (e) {
      // A customer cell inserted by someone else between our lock and our insert: the row we expected absent exists.
      if ((e as { code?: string } | null)?.code === "P2002" && current) throw this.stale(current);
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
    if (p.kind === "FAMILY" || p.kind === "RECIPE") {
      throw this.invalid(["The price of a family or recipe product is set on the family."]);
    }
  }

  private assertFresh(m: PriceModel, expectedRevision: number, expectedPriceState: string): void {
    if (m.revision !== expectedRevision || m.priceState !== expectedPriceState) throw this.stale(m);
  }

  private stale(m: PriceModel): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: API_ERROR_CODES.LADDER_REVISION_STALE,
      message: STALE_MESSAGE,
      revision: m.revision,
      grid: m.grid,
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
