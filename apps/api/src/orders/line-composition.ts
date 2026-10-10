import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { componentUnitPrice4, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { resolveLineUnits, type LineUnitsProduct } from "../products/line-units";
import { printableUnitBarcode, synthesizeLegacyBarcodes } from "../products/product-barcode-rules";

/**
 * #2717 M3 (SA-572 I9/I10/I11/I12, SA-579, SA-589): FIXED line composition. A FIXED line is a
 * whole-box line of a RECIPE product; its components are frozen on the line as integer pieces
 * whose sum is exactly the line's pieces (I12, checked in the writing tx, never a CHECK).
 * Documents never join Recipe (I11): a line keeps the composition it was created with and is
 * rescaled from its OWN stored rows, never from the current ACTIVE recipe.
 *
 * `displayUnitPrice4` (SA-589) is written on the component rows only: componentUnitPrice4 of the
 * line's NET stored subtotal over its pieces, so a BOGO line shows what was paid, not list.
 * Display only (I5): no sum, tax or credit path reads it.
 */
export interface PlannedComponent {
  componentProductId: string;
  qty: number;
}

export interface PlanFixedInput {
  recipe: { comps: PlannedComponent[]; unitsPerPack: number };
  line: {
    boxes: number;
    pieces: number;
    unitsPerBox: number | null;
    qty?: number;
    unitLabel?: string | null;
  };
}

const bad = (code: string, message: string) => new BadRequestException({ code, message });

function assertWholeBoxes(line: { boxes: number; pieces: number }): void {
  if (Number(line.pieces ?? 0) !== 0 || !Number.isInteger(line.boxes) || line.boxes < 1) {
    throw bad(API_ERROR_CODES.FIXED_WHOLE_BOXES, "A mixed pack is sold in whole boxes only.");
  }
}

/**
 * The whole-pack count a line composes as. A boxed line uses its `boxes`; a QTY-ONLY (selling
 * unit) line has boxes and pieces both null/0, and its `qty` IS the pack count. A loose-pieces
 * line (pieces > 0, no boxes) stays 0 so assertWholeBoxes still refuses it. LOCAL value only:
 * never written back to any OrderItem column.
 */
export function effectiveBoxes(l: {
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
}): number {
  const boxes = Number(l.boxes ?? 0);
  if (boxes > 0) return boxes;
  if (Number(l.pieces ?? 0) > 0) return boxes;
  const qty = Number(l.qty ?? 0);
  return qty > 0 ? qty : 0;
}

/** I12: whole non-negative component pieces summing EXACTLY to the line's pieces, else 400. */
export function assertComponentSum(pieces: number, qtys: number[]): void {
  const whole = qtys.every((q) => Number.isInteger(q) && q >= 0);
  const sum = qtys.reduce((a, q) => a + q, 0);
  if (!whole || sum !== pieces) {
    throw bad(
      API_ERROR_CODES.COMPONENT_SUM_MISMATCH,
      `Component pieces (${sum}) must add up to the line's ${pieces} pieces.`,
    );
  }
}

/**
 * The per-line components of a FIXED line: recipe component qty x boxes. Refuses a unit-aware
 * line (400), loose pieces (400), and a pack size that differs from the line's snapshot (409).
 */
export function planFixedComposition(input: PlanFixedInput): PlannedComponent[] {
  const { recipe, line } = input;
  if (line.unitLabel) {
    throw bad(
      API_ERROR_CODES.COMPOSED_UNIT_LINE,
      "A mixed pack cannot be sold on a unit-aware line.",
    );
  }
  assertWholeBoxes(line);
  if (Number(line.unitsPerBox) !== recipe.unitsPerPack) {
    throw new ConflictException({
      code: API_ERROR_CODES.RECIPE_PACK_MISMATCH,
      message: "The recipe's pack size differs from the line's pack size.",
    });
  }
  const planned = recipe.comps.map((c) => ({
    componentProductId: c.componentProductId,
    qty: c.qty * line.boxes,
  }));
  assertComponentSum(
    line.boxes * recipe.unitsPerPack,
    planned.map((c) => c.qty),
  );
  return planned;
}

/**
 * Re-size a line from its STORED components (I11, L-222): old boxes = stored sum / pack size,
 * per-box qty = stored qty / old boxes. A stored composition that does not divide is corrupt: a
 * 500-class tripwire that logs the COUNT only (no ids or names, client-data policy).
 */
export function rescaleComposition(input: {
  stored: PlannedComponent[];
  unitsPerPack: number;
  boxes: number;
}): PlannedComponent[] {
  const { stored, unitsPerPack, boxes } = input;
  const sum = stored.reduce((a, c) => a + c.qty, 0);
  const oldBoxes = unitsPerPack > 0 ? sum / unitsPerPack : NaN;
  const ok =
    stored.length > 0 &&
    Number.isInteger(oldBoxes) &&
    oldBoxes > 0 &&
    stored.every((c) => Number.isInteger(c.qty) && c.qty % oldBoxes === 0);
  if (!ok) {
    new Logger("LineComposition").error(
      `COMPOSITION_CORRUPT: stored composition of ${stored.length} components does not divide into whole boxes`,
    );
    throw new InternalServerErrorException({
      code: API_ERROR_CODES.COMPOSITION_CORRUPT,
      message: "This line's mixed-pack composition is inconsistent.",
    });
  }
  return stored.map((c) => ({
    componentProductId: c.componentProductId,
    qty: (c.qty / oldBoxes) * boxes,
  }));
}

/** What the snapshot reads off a component Product. */
export interface ComponentProductFacts {
  id: string;
  name: string;
  sku: string | null;
  unitSku: string | null;
  barcode: string | null;
  unitsPerBox: number | null;
  barcodes: Array<{ code: string; symbology: string; level: string; primaryFor: string | null }>;
}

/**
 * I9 / SA-572a (ii): the printable UNIT barcode. The UNIT primary row (a COPIED row counts); with
 * no rows at all, the same rows the legacy column would synthesize; else none.
 */
export function snapshotUnitBarcode(p: ComponentProductFacts): {
  unitBarcode: string | null;
  barcodeSymbology: string | null;
} {
  const rows = p.barcodes.length
    ? p.barcodes
    : synthesizeLegacyBarcodes({ barcode: p.barcode, unitsPerBox: p.unitsPerBox });
  const code = printableUnitBarcode(rows);
  if (!code) return { unitBarcode: null, barcodeSymbology: null };
  const row = rows.find((r) => r.level === "UNIT" && r.primaryFor === "UNIT");
  return { unitBarcode: code, barcodeSymbology: row?.symbology ?? null };
}

export interface ComponentSnapshotRow {
  componentProductId: string;
  qty: number;
  name: string;
  unitSku: string | null;
  unitBarcode: string | null;
  barcodeSymbology: string | null;
  displayUnitPrice4: number | null;
  position: number;
}

/**
 * Frozen component rows for ONE document line (no parent key, no tenantId: the caller adds both).
 * Every row takes componentUnitPrice4(roundMoney(net subtotal), pieces): the value repeats across
 * the line's components and is frozen per document row (SA-589). The subtotal is rounded here
 * because `isWholeCents` has no tolerance.
 */
export function buildComponentSnapshots(input: {
  planned: PlannedComponent[];
  products: Map<string, ComponentProductFacts>;
  netSubtotal: number;
  pieces: number;
}): ComponentSnapshotRow[] {
  const price = componentUnitPrice4(roundMoney(input.netSubtotal), input.pieces);
  return input.planned.map((c, position) => {
    const p = input.products.get(c.componentProductId);
    if (!p) {
      throw bad(API_ERROR_CODES.RECIPE_INVALID, "A component product was not found.");
    }
    const { unitBarcode, barcodeSymbology } = snapshotUnitBarcode(p);
    return {
      componentProductId: c.componentProductId,
      qty: c.qty,
      name: p.name,
      unitSku: p.unitSku ?? p.sku ?? null,
      unitBarcode,
      barcodeSymbology,
      displayUnitPrice4: price,
      position,
    };
  });
}

/** The one place documents read Recipe rows (I11): a port, adapted in recipe-snapshot.adapter.ts. */
export interface RecipeSnapshot {
  recipeId: string;
  version: number;
  unitsPerPack: number;
  comps: PlannedComponent[];
}

export interface RecipeSnapshotPort {
  activeRecipeFor(productId: string): Promise<RecipeSnapshot | null>;
  /** A specific version, for a line already stamped with it (a merge-moved line keeps v1). */
  recipeById(recipeId: string): Promise<RecipeSnapshot | null>;
  productFacts(ids: string[]): Promise<Map<string, ComponentProductFacts>>;
}

export interface SyncContext {
  tenantId: string;
  /** `mixed_packs` mode is on for this tenant; off = every line stays plain, nothing is read. */
  enabled: boolean;
  port: RecipeSnapshotPort;
}

/**
 * Bring the frozen composition of ORDER lines in step with the rows just written, inside the
 * writing tx (call it after every orderItem create/update that can change a RECIPE line).
 * - mode off, an empty id list, or a non-RECIPE line: nothing happens (byte-identical to today);
 * - a line that already has components keeps them and is rescaled from them (never re-reads Recipe);
 * - a new RECIPE line takes the ACTIVE recipe's components and stamps compositionMode/recipeId/
 *   recipeVersion; I12 is asserted BEFORE any write so a mismatch rolls the whole tx back.
 * Nested rows carry the tenantId explicitly (nested creates are not tenant-injected, SA-579 S4).
 */
export async function syncLineCompositions(
  tx: Prisma.TransactionClient,
  lineIds: string[],
  ctx: SyncContext,
): Promise<void> {
  if (!ctx.enabled || lineIds.length === 0) return;
  const lines = await tx.orderItem.findMany({
    where: { id: { in: lineIds } },
    select: {
      id: true,
      productId: true,
      qty: true,
      boxes: true,
      pieces: true,
      unitsPerBox: true,
      unitLabel: true,
      subtotal: true,
      compositionMode: true,
      recipeId: true,
      recipeVersion: true,
      product: { select: { id: true, kind: true, unit: true, unitsPerBox: true } },
      components: {
        select: { componentProductId: true, qty: true },
        orderBy: { position: "asc" },
      },
    },
  });
  for (const l of lines) {
    if (l.product?.kind !== "RECIPE") continue;
    // A qty-only line composes as `qty` whole packs (local value; no column is rewritten).
    const boxes = effectiveBoxes({
      boxes: l.boxes,
      pieces: l.pieces,
      qty: l.qty == null ? null : Number(l.qty),
    });
    const ownUpb = l.unitsPerBox == null ? null : Number(l.unitsPerBox);
    // A qty-only line snapshots no factor of its own: take the PACK factor through the one sanctioned
    // resolver (never a direct live-product read, line-units-callsites ratchet).
    const packUpb =
      l.boxes == null
        ? resolveLineUnits(l.product as unknown as LineUnitsProduct, [], { unitLabel: null }, null)
            .unitsPerBox
        : 0;
    const unitsPerBox = ownUpb ?? (packUpb > 0 ? packUpb : null);
    // A qty-only UNIT-AWARE line (unitLabel set, no box split) counts units of that label, not
    // packs: it stays plain, exactly as before (only boxed lines refuse a unit label).
    if (
      l.unitLabel &&
      l.boxes == null &&
      Number(l.pieces ?? 0) === 0 &&
      l.compositionMode !== "FIXED"
    ) {
      continue;
    }
    if (boxes === 0 && Number(l.pieces ?? 0) === 0) {
      // A struck (cancelled, zeroed) line has no pieces: its component rows go with them.
      await tx.orderItemComponent.deleteMany({
        where: { orderItemId: l.id, tenantId: ctx.tenantId },
      });
      continue;
    }
    let planned: PlannedComponent[];
    let stamp: { recipeId: string; version: number } | null = null;
    if (l.compositionMode === "FIXED" && l.components.length > 0) {
      if (l.unitLabel) {
        throw bad(
          API_ERROR_CODES.COMPOSED_UNIT_LINE,
          "A mixed pack cannot be sold on a unit-aware line.",
        );
      }
      assertWholeBoxes({ boxes, pieces: Number(l.pieces ?? 0) });
      planned = rescaleComposition({
        stored: l.components.map((c) => ({
          componentProductId: c.componentProductId,
          qty: Number(c.qty),
        })),
        unitsPerPack: unitsPerBox as number,
        boxes,
      });
    } else {
      // A line already stamped (a merge-moved line) keeps its own version; a new one takes ACTIVE.
      const recipe = l.recipeId
        ? await ctx.port.recipeById(l.recipeId)
        : await ctx.port.activeRecipeFor(l.product.id);
      if (!recipe) continue;
      planned = planFixedComposition({
        recipe,
        line: { boxes, pieces: Number(l.pieces ?? 0), unitsPerBox, unitLabel: l.unitLabel },
      });
      stamp = l.recipeId ? null : { recipeId: recipe.recipeId, version: recipe.version };
    }
    assertComponentSum(
      boxes * (unitsPerBox as number),
      planned.map((c) => c.qty),
    );
    const products = await ctx.port.productFacts(planned.map((c) => c.componentProductId));
    const rows = buildComponentSnapshots({
      planned,
      products,
      netSubtotal: Number(l.subtotal),
      pieces: boxes * (unitsPerBox as number),
    });
    await tx.orderItemComponent.deleteMany({
      where: { orderItemId: l.id, tenantId: ctx.tenantId },
    });
    await tx.orderItemComponent.createMany({
      data: rows.map((r) => ({
        ...r,
        tenantId: ctx.tenantId,
        orderItemId: l.id,
        barcodeSymbology: r.barcodeSymbology as never,
      })),
    });
    if (stamp) {
      await tx.orderItem.update({
        where: { id: l.id },
        data: { compositionMode: "FIXED", recipeId: stamp.recipeId, recipeVersion: stamp.version },
      });
    }
  }
}
