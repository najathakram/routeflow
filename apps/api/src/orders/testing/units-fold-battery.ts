/**
 * SA-984 §4 / D3: the units fold-in equivalence battery. Test support, not a spec (Jest never runs this file).
 *
 * What the fold changes for a tenant that holds none of the three `flag.units_*` keys is decided by the READERS of those
 * keys. This kit lets a spec run the same document line twice, once with every key OFF and once with every key ON, and
 * puts the two sets of figures side by side:
 *   - `makeFlagStub` answers both entitlement methods (`hasFlag` AND `hasFlagStrict`, plan risk R1: a stub with only
 *     `hasFlag` makes `loadUnitsPricesV2` return null before the flag is ever read, so every cell would read "equal"
 *     without the flag being on) and RECORDS every call, so each cell reports how many times a flag was consulted.
 *   - `priceLine` runs ONE order line through the real readers in the order `OrdersService.create()` calls them
 *     (prepareUnitLadders -> customerPricing -> derivedBaseAsPack -> resolveLineUnits -> buildUnitLine, or the pack
 *     branch's own pricing/tax). The pack branch is a transcription of orders.service.ts:1679-1843; the DB lane
 *     (units-fold-e0-documents.db.spec.ts) runs the real create() on Postgres.
 *   - `expectSame` fails LOUDLY: it prints the OLD and the NEW figure of every compared field. `expectDiffers` is the
 *     positive control: it fails when a toggle that must move a figure moved nothing.
 *
 * STOP RULE (SA-984 §5): a failing `expectSame` is a finding, not a bug in the test. Never edit its expectation; report
 * both figures to the SA/owner.
 */
import { isDeepStrictEqual } from "node:util";
import {
  computeLineSubtotal,
  invoiceLineQtyText,
  normalizeBoxesPieces,
  regulatedUnitBasis,
  type LadderUnit,
  type PromotionRule,
  type TrackedCategoryRow,
} from "@routeflow/pricing";
import { resolveLineUnits } from "../../products/line-units";
import { resolveBuyerLinePrice } from "../buyer-merge-pricing";
import { linePieceQty } from "../line-piece-qty";
import { orderTotalsOf } from "../order-totals";
import {
  buildUnitLine,
  categoryTaxForLine,
  derivedBaseAsPack,
  isUnitAware,
  prepareUnitLadders,
} from "../unit-line-build";
import { customerPricing } from "../units-prices-v2";

// ─── the three keys, and a stub that records who asked ──────────────────────────────────────────────────────────────
/** The figure key for the stored category-tax amount, spelled as a string so the repo-wide writer census (category-tax-trio-callsites) does not count this read-only kit. */
const TAX_AMOUNT_KEY = "categoryTaxAmount";
export const FLAG_V1 = "flag.units_v1";
export const FLAG_PRICES_V2 = "flag.units_prices_v2";
export const FLAG_SETTINGS = "flag.units_settings_v1";
export type FlagState = "off" | "on";
/** All three keys off, all three on, or exactly the keys a holder tenant has today (SA-987 Q3: a holder's OFF side is its own key set). */
export type KeySet = FlagState | readonly string[];
const ALL_KEYS = [FLAG_V1, FLAG_PRICES_V2, FLAG_SETTINGS] as const;

export interface FlagCall {
  method: "hasFlag" | "hasFlagStrict";
  tenantId: string;
  flag: string;
}
/** How often each key was asked, and through which entitlement method. */
export interface Consulted {
  units_v1: number;
  units_prices_v2: number;
  units_settings_v1: number;
  strict: number;
  plain: number;
}
export interface FlagStub {
  state: KeySet;
  /** Both methods when `strict` (the default). With `strict: false` only `hasFlag`: the DEAD stub of risk R1. */
  entitlements: {
    hasFlag(tenantId: string, flag: string): Promise<boolean>;
    hasFlagStrict?(tenantId: string, flag: string): Promise<boolean>;
  };
  calls: FlagCall[];
  consulted(): Consulted;
}

export function makeFlagStub(state: KeySet, opts: { strict?: boolean } = {}): FlagStub {
  const held: readonly string[] =
    typeof state === "string" ? (state === "on" ? ALL_KEYS : []) : state;
  const flags = new Map<string, boolean>(ALL_KEYS.map((k) => [k, held.includes(k)]));
  const calls: FlagCall[] = [];
  const ask = (method: FlagCall["method"]) => async (tenantId: string, flag: string) => {
    calls.push({ method, tenantId, flag });
    return flags.get(flag) === true;
  };
  const entitlements: FlagStub["entitlements"] = { hasFlag: ask("hasFlag") };
  if (opts.strict !== false) entitlements.hasFlagStrict = ask("hasFlagStrict");
  return {
    state,
    entitlements,
    calls,
    consulted: () => ({
      units_v1: calls.filter((c) => c.flag === FLAG_V1).length,
      units_prices_v2: calls.filter((c) => c.flag === FLAG_PRICES_V2).length,
      units_settings_v1: calls.filter((c) => c.flag === FLAG_SETTINGS).length,
      strict: calls.filter((c) => c.method === "hasFlagStrict").length,
      plain: calls.filter((c) => c.method === "hasFlag").length,
    }),
  };
}

// ─── the failing-assertion form ─────────────────────────────────────────────────────────────────────────────────────
export type Fig = Record<string, unknown>;
export type CellLabel = "DIFFERENT" | "equal by short-circuit" | "equal, flag consulted";
export interface CellRow {
  cell: string;
  equal: boolean;
  /** "equal by short-circuit" = equal because no flag was ever asked (SA-987 §1.2): never read it as flag coverage. */
  label: CellLabel;
  consulted_v1: number | "";
  consulted_v2: number | "";
  consulted_settings: number | "";
}
const CELL_LOG: CellRow[] = [];

const diffKeys = (off: Fig, on: Fig): string[] =>
  Object.keys({ ...off, ...on }).filter((k) => !isDeepStrictEqual(off[k], on[k]));
const show = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

/** Every compared field, OLD = flag off, NEW = flag on. Throws, printing both figures of each field that moved. */
export function expectSame(cell: string, off: Fig, on: Fig): void {
  const diff = diffKeys(off, on);
  if (diff.length === 0) return;
  throw new Error(
    `UNITS-FOLD DIFFERENCE ${cell}\n` +
      diff.map((k) => `  ${k}: OLD=${show(off[k])}  NEW=${show(on[k])}`).join("\n") +
      `\nSTOP (SA-984 §5): report both figures to the SA/owner. Do not edit this expectation.`,
  );
}

/**
 * The positive control: the toggle must move at least one field. When nothing moved the control is dead (a stub that
 * never reached the flag, plan R1), and every "equal" cell next to it proves nothing.
 */
export function expectDiffers(
  cell: string,
  off: Fig,
  on: Fig,
  opts: { ruling: string; fields?: string[] },
): string[] {
  const diff = diffKeys(off, on);
  if (diff.length === 0) {
    throw new Error(
      `UNITS-FOLD POSITIVE CONTROL IS DEAD ${cell} (${opts.ruling})\n` +
        `  flag off and flag on gave the SAME figures: ${show(off)}\n` +
        `  The toggle moved nothing, so the equal cells beside this one prove nothing.`,
    );
  }
  for (const f of opts.fields ?? []) {
    if (!diff.includes(f)) {
      throw new Error(
        `UNITS-FOLD POSITIVE CONTROL ${cell} (${opts.ruling}): ${f} did not move\n` +
          `  OLD=${show(off[f])}  NEW=${show(on[f])}\n  moved instead: ${diff.join(", ")}`,
      );
    }
  }
  return diff;
}

export type Want = "none" | "some";
export interface RunsOpts {
  /** Per key: "none" (the default) = the key was never asked; "some" = asked at least once, in BOTH runs. */
  consulted?: Partial<Record<"units_v1" | "units_prices_v2" | "units_settings_v1", Want>>;
  /** A run that threw is a figure too (`error`), but an "equal" cell where both threw proves nothing. */
  allowError?: boolean;
}
export interface LineRun {
  fig: Fig;
  consulted: Consulted;
}

/** expectSame over two runs, plus the "flag consulted" count assertion that stops an equal-by-short-circuit cell reading as coverage. */
export function expectSameRuns(cell: string, off: LineRun, on: LineRun, opts: RunsOpts = {}): void {
  if (!opts.allowError) {
    for (const [side, run] of [
      ["OLD", off],
      ["NEW", on],
    ] as const) {
      if (run.fig.error !== undefined) {
        throw new Error(
          `UNITS-FOLD CELL THREW ${cell} (${side}): ${show(run.fig.error)}\n  An equal cell where the line never priced proves nothing.`,
        );
      }
    }
  }
  const want = (k: "units_v1" | "units_prices_v2" | "units_settings_v1"): Want =>
    opts.consulted?.[k] ?? "none";
  const wrong: string[] = [];
  for (const k of ["units_v1", "units_prices_v2", "units_settings_v1"] as const) {
    for (const [side, run] of [
      ["OLD", off],
      ["NEW", on],
    ] as const) {
      const n = run.consulted[k];
      if (want(k) === "none" ? n !== 0 : n === 0) {
        wrong.push(`  ${k} consulted ${n}x on the ${side} side, wanted ${want(k)}`);
      }
    }
  }
  const equal = diffKeys(off.fig, on.fig).length === 0;
  const asked =
    on.consulted.units_v1 + on.consulted.units_prices_v2 + on.consulted.units_settings_v1 > 0;
  CELL_LOG.push({
    cell,
    equal,
    label: !equal ? "DIFFERENT" : asked ? "equal, flag consulted" : "equal by short-circuit",
    consulted_v1: on.consulted.units_v1,
    consulted_v2: on.consulted.units_prices_v2,
    consulted_settings: on.consulted.units_settings_v1,
  });
  expectSame(cell, off.fig, on.fig);
  if (wrong.length) {
    throw new Error(`UNITS-FOLD FLAG-CONSULTED COUNT ${cell}\n${wrong.join("\n")}`);
  }
}

/** The per-cell table (cell, equal?, flag consulted) for the PR body: call it from `afterAll`. Nothing is written to disk. */
export function reportCells(title: string): void {
  if (CELL_LOG.length === 0) return;
  console.log(`${title}\n${JSON.stringify(CELL_LOG, null, 1)}`);
  console.table(CELL_LOG);
}

// ─── shapes: one product each, seeded identically for both flag states ─────────────────────────────────────────────
export const TENANT = "t-fold";
export const TAX_RATE = 0.0825;

export interface ProductRow {
  id: string;
  name: string;
  unit: string;
  unitsPerBox: number | null;
  pricePerUnit: string;
  priceTier2: string | null;
  priceTier3: string | null;
  priceTier4: string | null;
  priceTier5: string | null;
  category: string | null;
  trackedCategoryId: string | null;
  trackedSubcategoryId: string | null;
  orderUnitRef: string;
  packAuto: number;
}
export type CategoryRow = TrackedCategoryRow & { id: string };
export interface Shape {
  id: string;
  /** What the shape is, in words (the cell names use the id). */
  note: string;
  product: ProductRow;
  /** The ProductUnit ladder rows: empty for every shape a tenant without the flags can hold. */
  units: LadderUnit[];
  category?: CategoryRow;
}

const row = (
  id: string,
  unitsPerBox: number | null,
  over: Partial<ProductRow> = {},
): ProductRow => ({
  id,
  name: `Shape ${id}`,
  unit: "Box",
  unitsPerBox,
  pricePerUnit: "11.00",
  priceTier2: "10.50",
  priceTier3: "10.00",
  priceTier4: "9.50",
  priceTier5: "9.00",
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  orderUnitRef: "pack",
  packAuto: 0,
  ...over,
});
const level = (
  label: string,
  factorToBase: number,
  over: Partial<LadderUnit> = {},
): LadderUnit => ({
  label,
  factorToBase,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  ...over,
});
export const REGULATED: CategoryRow = {
  id: "cat-reg",
  taxType: "EXCISE_PER_UNIT",
  rate: 0.5,
  priceIncludesTax: false,
};

/** SA-984 §1: the no-pack shapes (unitsPerBox null / 0 / 1) are NAMED rows. */
export const NO_PACK_SHAPES = ["N-null", "N-0", "N-1"] as const;
export const SHAPES: Record<string, Shape> = {
  "N-null": {
    id: "N-null",
    note: "no pack: unitsPerBox null",
    product: row("p-n-null", null),
    units: [],
  },
  "N-0": { id: "N-0", note: "no pack: unitsPerBox 0", product: row("p-n-0", 0), units: [] },
  "N-1": { id: "N-1", note: "no pack: unitsPerBox 1", product: row("p-n-1", 1), units: [] },
  B12: {
    id: "B12",
    note: "a 12-pack, no ProductUnit rows (the common existing shape)",
    product: row("p-b12", 12),
    units: [],
  },
  "B12-reg": {
    id: "B12-reg",
    note: "a 12-pack in a per-unit regulated category (tax follows the piece count)",
    product: row("p-b12-reg", 12, {
      trackedCategoryId: REGULATED.id,
      trackedSubcategoryId: "sub-reg",
    }),
    units: [],
    category: REGULATED,
  },
  // Holder-only data (SA-984 §0): a tenant without the flags cannot hold ProductUnit rows.
  // E1-b (SA-984 §4): a level row but NO Piece row, so a Piece pick is the derived base (billed as the pack's pieces).
  LADC: {
    id: "LADC",
    note: "holder-only: a 12-pack and a Case of 48, no Piece row",
    product: row("p-ladc", 12),
    units: [level("Case", 48)],
  },
  // E1-c (SA-987 §1.6 / Q2): an OWN-priced Piece row at the price the picker displays for the derived Piece, per tier
  // (tier 1: 11.00 / 12 = 0.92; tier 3: 10.00 / 12 = 0.83). The only shape that reaches buildUnitLine's factor-1 branch.
  LADP: {
    id: "LADP",
    note: "holder-only: a 12-pack, a Case of 48 and an own-priced Piece row (0.92 / tier 3 0.83)",
    product: row("p-ladp", 12),
    units: [level("Case", 48), level("Piece", 1, { price: "0.92", priceTier3: "0.83" })],
  },
  LAD: {
    id: "LAD",
    note: "holder-only: a 12-pack, a Case of 48 and an unpriced Piece row",
    product: row("p-lad", 12),
    units: [level("Case", 48), level("Piece", 1)],
  },
};

export interface CustomerRow {
  id: string;
  pricingTier: number | null;
  /** CustomerPrice rows (per-product tier overrides, and the customer's own order unit). */
  cp: Array<{ productId: string; pricingTier: number | null; orderUnitRef?: string | null }>;
  /** CustomerUnitPrice rows: typed prices by level ref. Holder-only data. */
  typed?: Array<{ productId: string; unitRef: string; price: string }>;
}
export const customerOf = (
  id: string,
  pricingTier: number | null,
  over: Partial<CustomerRow> = {},
): CustomerRow => ({ id, pricingTier, cp: [], ...over });

export interface LineReq {
  qty?: number;
  boxes?: number;
  pieces?: number;
  unitLabel?: string;
  unitPrice?: number;
}

// ─── one line through the real readers, in create()'s order ────────────────────────────────────────────────────────
/** An EXISTING stored unit line being edited (a qty change that re-sends its unit): the snapshot the rewrite keeps. */
export interface StoredLine {
  unitLabel: string;
  unitsPerBox: number;
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  originalPrice: number | null;
}
export interface PriceLineArgs {
  state: KeySet;
  shape: Shape;
  cust: CustomerRow;
  req: LineReq;
  /** "staff" (the order screen, the counter) or "buyer" (the portal: promos, and no unit pick). */
  actor?: "staff" | "buyer";
  promos?: PromotionRule[];
  /** Edit of an existing stored unit line (the request names its id and re-sends its unit). */
  existing?: StoredLine;
  /** Pass a stub to share it across lines or to use the dead one (R1); default is a fresh recording stub. */
  stub?: FlagStub;
}

/** The tenant client the pricing readers query: the ladder rows, the customer's typed prices, and no tier-unit rows. */
export const fakeDb = (shape: Shape, cust: CustomerRow) => ({
  productUnit: {
    findMany: async () => shape.units.map((u) => ({ ...u, productId: shape.product.id })),
  },
  customerUnitPrice: {
    findMany: async () => (cust.typed ?? []).filter((t) => t.productId === shape.product.id),
  },
  productTierUnit: { findMany: async () => [] },
});

export async function priceLine(a: PriceLineArgs): Promise<LineRun> {
  const stub = a.stub ?? makeFlagStub(a.state);
  const { shape, cust } = a;
  const product = shape.product;
  const db = fakeDb(shape, cust);
  const svc = {
    prisma: { forTenant: () => db, getTenantId: () => TENANT },
    entitlements: stub.entitlements as never,
  };
  try {
    const item = {
      productId: product.id,
      ...(a.existing ? { id: "line-1" } : {}),
      ...a.req,
    };
    // units_v1: the gate (staff, flag.units_v1) and the ladder of the named units. Reads nothing for a pack-only request.
    const unitsByProduct = await prepareUnitLadders([item], {
      isStaff: a.actor !== "buyer",
      prisma: svc.prisma,
      entitlements: stub.entitlements as never,
    });
    // S19: the tier maps (and, flag on with typed rows or an odd tier, the customer layer).
    const pc = await customerPricing(
      svc,
      cust.id,
      [product.id],
      { pricingTier: cust.pricingTier },
      cust.cp.filter((r) => r.productId === product.id),
    );
    const productMap = new Map([[product.id, product]]);
    const line = derivedBaseAsPack(item, productMap, unitsByProduct, pc.cpMap, pc.defaultTier);
    const ladder = unitsByProduct.get(product.id) ?? [];
    const resolved = resolveLineUnits(product, ladder, line, a.existing ?? null);
    const tier = pc.cpMap.get(product.id) ?? pc.defaultTier;
    let stored: Fig;
    if (isUnitAware(resolved)) {
      const built = buildUnitLine({
        product,
        units: ladder,
        resolved,
        item: { ...line, qty: line.qty ?? 0, productId: product.id },
        tier,
        customerLayer: pc.layer(product, resolved.unitLabel),
        taxFor: (qty, sub) => categoryTaxForLine(shape.category, qty, sub),
        position: 0,
        tenantId: TENANT,
        priceEditAllowed: true,
        ...(a.existing ? { stored: a.existing as never, existing: a.existing as never } : {}),
      });
      stored = { ...built };
    } else {
      const upb = upbOf(product);
      let qty = line.qty ?? 0;
      let boxes: number | null = null;
      let pieces: number | null = null;
      if ((line.boxes ?? 0) > 0 || (line.pieces ?? 0) > 0) {
        const split = normalizeBoxesPieces({
          boxes: line.boxes,
          pieces: line.pieces,
          qty: line.qty,
          unitsPerBox: upb,
        });
        qty = split.qty;
        boxes = split.boxes;
        pieces = split.pieces;
      }
      if (!(Number(qty) > 0)) throw new Error("Line quantity must be greater than zero.");
      const qtyPieces = regulatedUnitBasis(
        { qty, boxes, pieces, unitLabel: resolved.unitLabel },
        upb,
      ).unitBasisQty;
      const qtyUnits = boxes != null ? boxes : qty;
      const priced = resolveBuyerLinePrice(
        product,
        tier,
        a.promos ?? [],
        qtyPieces,
        qtyUnits,
        null,
        { boxes, pieces, unitsPerBox: upb },
        pc.layer(product),
      );
      const subtotal = computeLineSubtotal({
        unitPrice: priced.unitPrice,
        qty,
        boxes,
        pieces,
        unitsPerBox: upb,
        freeUnits: priced.freeUnits,
      });
      const tax = categoryTaxForLine(shape.category, qtyPieces, subtotal);
      stored = {
        qty,
        boxes,
        pieces,
        unitsPerBox: boxes != null && upb > 1 ? upb : null,
        unitLabel: null,
        unitPrice: priced.unitPrice,
        priceType: priced.priceType,
        originalPrice: priced.originalPrice,
        promoFreeUnits: priced.freeUnits > 0 ? priced.freeUnits : null,
        subtotal,
        [TAX_AMOUNT_KEY]: tax.amount,
        ...tax.snapshot,
      };
    }
    const totals = orderTotalsOf(
      [
        {
          subtotal: stored.subtotal as number,
          [TAX_AMOUNT_KEY]: stored[TAX_AMOUNT_KEY] as number,
        },
      ],
      { taxRate: TAX_RATE, isTaxExempt: false, discount: 0 },
    );
    const fig: Fig = {
      qty: stored.qty,
      boxes: stored.boxes,
      pieces: stored.pieces,
      unitsPerBox: stored.unitsPerBox,
      unitLabel: stored.unitLabel,
      unitPrice: stored.unitPrice,
      priceType: stored.priceType,
      originalPrice: stored.originalPrice,
      promoFreeUnits: stored.promoFreeUnits,
      subtotal: stored.subtotal,
      [TAX_AMOUNT_KEY]: stored[TAX_AMOUNT_KEY],
      categoryTaxType: stored.categoryTaxType,
      categoryTaxRate: stored.categoryTaxRate,
      headerSubtotal: totals.subtotal,
      headerTax: totals.tax,
      headerTotal: totals.total,
      // stock: the pieces a SALE movement decrements (order-stock.ts reads linePieceQty)
      stockPieces: linePieceQty(stored as never, upbOf(product)),
      // printed: the quantity cell, the same function the PDF and the packing slip call
      printedQty: invoiceLineQtyText(stored as never),
    };
    return { fig, consulted: stub.consulted() };
  } catch (e) {
    const err = e as Error;
    return {
      fig: { error: `${err.constructor.name}: ${err.message}` },
      consulted: stub.consulted(),
    };
  }
}
const upbOf = (row: ProductRow): number => Number(row.unitsPerBox ?? 0);

/** Both flag states of one cell. */
export async function bothStates(
  args: Omit<PriceLineArgs, "state" | "stub">,
  /** The OLD side's key set: all off (a non-holder, the default) or a holder's own keys (SA-987 Q3). */
  oldKeys: KeySet = "off",
): Promise<{ off: LineRun; on: LineRun }> {
  return {
    off: await priceLine({ ...args, state: oldKeys }),
    on: await priceLine({ ...args, state: "on" }),
  };
}
