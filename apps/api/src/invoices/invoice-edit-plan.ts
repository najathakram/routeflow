/**
 * SA-184 / SA-186 (B670, B701, B674) — how `InvoicesService.update()` turns an edit payload into
 * per-line writes. Pure (no DB, no logging of its own), so the rules are testable without standing
 * up the service; the service keeps every DB read and write. Also keeps `invoices.service.ts` under
 * its size ratchet: the ~90-line line mapper that used to sit inside `update()` lives here now.
 *
 * ROOT. `update()` used to re-derive EVERY line on every save, from a pack guessed per productId
 * (the invoice's other lines, then the live product). A notes-only save could therefore re-price or
 * re-split a stored line, and a sibling line's pack could leak onto it.
 *
 * RULES.
 *  1. MATCH. A payload line is matched to one of THIS invoice's stored rows by its optional `id`
 *     (never by productId). An id that is not one of this invoice's rows (unknown, another invoice,
 *     another tenant: the lookup is tenant-scoped) is a 400 "unknown line id". Old cached clients
 *     send no id: an id-less line that equals a still-unmatched stored row on the FULL tuple
 *     (productId, qty, boxes, pieces, unitPrice, discount, taxRate) is that row, matched in payload order
 *     against stored order. Anything short of the full tuple is a changed/new line. (The fallback is
 *     removed at R1.1: #2096.)
 *  2. UNTOUCHED. A matched line whose payload equals the stored row on qty, boxes, pieces, unitPrice,
 *     discount and taxRate is PRESERVED VERBATIM: stored money, split, pack, levy and snapshots, no
 *     re-derivation. Only description/notes/orderItemId are taken from the payload.
 *  3. CHANGED. A changed line is re-priced. Its pack comes from its OWN stored pack (the saved
 *     snapshot, else the pack its stored split implies); a NEW split implying a different pack is a
 *     re-pack and needs the operator's `unitsPerBox` (SA-196); with no stored pack it comes from the
 *     payload's own split, else the operator's explicit `unitsPerBox` (integer >= 2, checked: qty must equal
 *     boxes x pack + pieces, and it may never disagree with a recoverable pack). Never the live
 *     product, never a sibling's pack. A changed line that was stored with a box split (or is sent
 *     with one) and has no recoverable pack is refused: "set the box and piece count for <line> to
 *     edit it". A brand-new line (no stored row) has no snapshot: the write moment is the snapshot
 *     moment, so the live pack is its last resort (SA-077).
 */

import { BadRequestException } from "@nestjs/common";
import { assertSellableLines } from "../products/sellable-lines";
import type { ResolvedLineUnits } from "../products/line-units";
import { isUnitAware, prepareUnitLadders, requestsUnit } from "../orders/unit-line-build";
import { norm } from "../orders/unit-label-norm";
import { buildInvoiceUnitLine } from "./invoice-unit-line";
import {
  categoryTaxSnapshotOf,
  computeCategoryTax,
  normalizeBoxesPieces,
  packFromOwnSplit,
  regulatedUnitBasis,
  roundMoney,
  splitMatchesQty,
  type CategoryTaxType,
} from "@routeflow/pricing";
import { assertInvoiceTotalsSane, storedInvoiceTotals } from "../common/money-invariants.util";
import { foldCategoryTax } from "./manual-invoice-context";
import { priceReplacedLine, resolveUpdateLinePack } from "./update-pack-resolution";

export interface EditPayloadLine {
  id?: string;
  productId?: string | null;
  description?: string | null;
  orderItemId?: string | null;
  qty: number;
  unitPrice: number;
  discount?: number | null;
  taxRate?: number | null;
  unitLabel?: string | null;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  promoFreeUnits?: number | null;
  notes?: string | null;
}

/** A stored InvoiceItem row, as this module reads it (Prisma Decimals arrive as objects). */
export type StoredEditRow = Record<string, any> & { id: string };

export interface LineMatch {
  row: StoredEditRow | null;
  untouched: boolean;
  /** The payload names another product than the matched row: the row's own pack is not its pack. */
  productChanged: boolean;
}

const same = (a: unknown, b: unknown): boolean =>
  a == null || b == null ? a == null && b == null : Math.abs(Number(a) - Number(b)) < 1e-9;

/**
 * qty, boxes, pieces, unitPrice, discount, taxRate — the tuple SA-184 calls "untouched" — plus the unit
 * (VU-4a). A unit line's payload qty counts the UNIT (stored as `boxes`; its `qty` column is base pieces).
 */
const sameMoneyTuple = (item: EditPayloadLine, row: StoredEditRow): boolean =>
  norm(item.unitLabel ?? "") === norm(row.unitLabel ?? "") &&
  (requestsUnit(item)
    ? same(item.qty, row.boxes)
    : same(item.qty, row.qty) && same(item.boxes, row.boxes) && same(item.pieces, row.pieces)) &&
  same(item.unitPrice, row.unitPrice) &&
  same(item.discount ?? 0, row.discount ?? 0) &&
  same(item.taxRate ?? 0, row.taxRate ?? 0);

export function matchEditLines(items: EditPayloadLine[], stored: StoredEditRow[]): LineMatch[] {
  const byId = new Map(stored.map((r) => [r.id, r]));
  const used = new Set<string>();
  const out: LineMatch[] = items.map(() => ({
    row: null,
    untouched: false,
    productChanged: false,
  }));
  items.forEach((item, i) => {
    if (item.id == null) return;
    const row = byId.get(item.id);
    if (!row) throw new BadRequestException("unknown line id");
    if (used.has(row.id)) throw new BadRequestException("duplicate line id");
    used.add(row.id);
    // A unit row re-sent as a pack line (Case -> Box) must not carry the old factor as its own pack.
    const productChanged =
      (item.productId ?? null) !== (row.productId ?? null) ||
      (!requestsUnit(item) && norm(row.unitLabel ?? "") !== "");
    out[i] = { row, untouched: !productChanged && sameMoneyTuple(item, row), productChanged };
  });
  items.forEach((item, i) => {
    if (item.id != null) return;
    const row = stored.find(
      (r) =>
        !used.has(r.id) &&
        (r.productId ?? null) === (item.productId ?? null) &&
        sameMoneyTuple(item, r),
    );
    if (!row) return;
    used.add(row.id);
    out[i] = { row, untouched: true, productChanged: false };
  });
  return out;
}

export interface EditedLine {
  /** The stored row this line updates in place, or null for a brand-new line. */
  rowId: string | null;
  untouched: boolean;
  /** The operator's explicit pack when it was the ONLY source of this line's pack (SA-189: audited). */
  attestedPack?: number;
  /** Every column the line writes (create shape minus tenantId, which the caller adds). */
  data: Record<string, any>;
}

interface PlanCtx {
  items: EditPayloadLine[];
  /** The invoice's stored rows (the same ones `matches` were computed against). */
  stored: StoredEditRow[];
  matches: LineMatch[];
  productMap: ReadonlyMap<
    string,
    {
      unitsPerBox?: number | null;
      trackedCategoryId?: string | null;
      trackedSubcategoryId?: string | null;
    }
  >;
  categoryMap: ReadonlyMap<string, any>;
  clampFreeUnits: (free: number | undefined, boxes: number | null, qty: number) => number;
  warn: (message: string) => void;
  /** VU-4a: `resolveLineUnits` per item (index-aligned; undefined = no unit requested). The CALLER resolves. */
  resolved?: ReadonlyArray<ResolvedLineUnits | undefined>;
}

const lineLabel = (item: EditPayloadLine) =>
  item.description?.trim() || item.productId || "this line";

/**
 * The pack a stored row carries: its own saved `unitsPerBox`, else the pack its own stored split implies
 * (2 boxes x 12 = 24), never the live product. Null once the product changed or when neither is readable.
 */
function rowOwnPack(row: StoredEditRow, productChanged: boolean): number | null {
  if (productChanged) return null;
  if (Number(row.unitsPerBox) > 1) return Number(row.unitsPerBox);
  return packFromOwnSplit({ qty: Number(row.qty), boxes: row.boxes, pieces: row.pieces });
}

/** The pack a CHANGED, matched line may be re-split at, or a 400. Never the live product. */
function recoverChangedPack(
  item: EditPayloadLine,
  row: StoredEditRow,
  productChanged: boolean,
): { pack: number | null; boxes: number | null; pieces: number | null; attested?: boolean } {
  const hasSplit = item.boxes != null || item.pieces != null;
  const ownPack = rowOwnPack(row, productChanged);
  const splitPack = hasSplit
    ? packFromOwnSplit({ qty: item.qty, boxes: item.boxes, pieces: item.pieces })
    : null;
  const explicit = item.unitsPerBox != null && item.unitsPerBox >= 2 ? item.unitsPerBox : null;
  if (item.unitsPerBox != null && explicit == null) {
    throw new BadRequestException(
      `Line "${lineLabel(item)}": unitsPerBox must be a whole number of 2 or more`,
    );
  }
  // SA-196: a NEW split that implies a different pack than the row's own snapshot never wins
  // silently — it is a re-pack, so the operator must attest it (unitsPerBox = the implied pack),
  // which is then audited.
  const repack = splitPack != null && ownPack != null && splitPack !== ownPack;
  if (repack && explicit !== splitPack) {
    throw new BadRequestException(
      `Line "${lineLabel(item)}": the split implies pack ${splitPack} but this line's pack is ${ownPack}; set unitsPerBox ${splitPack} to re-pack it`,
    );
  }
  const recovered = repack ? null : (splitPack ?? ownPack);
  if (explicit != null && recovered != null && explicit !== recovered) {
    throw new BadRequestException(
      `Line "${lineLabel(item)}": the pack ${explicit} disagrees with this line's own pack ${recovered}`,
    );
  }
  // SA-219: the operator's explicit pack is stored and audited only when the row has NO snapshot of its own to
  // recover (or it is an attested re-pack). An explicit pack equal to the recovered snapshot is ignored.
  const attested = explicit != null && (ownPack == null || repack);
  const pack = recovered ?? explicit;
  const wasBoxed = !productChanged && row.boxes != null;
  if (pack == null) {
    if (hasSplit || wasBoxed) {
      throw new BadRequestException(
        `set the box and piece count for ${lineLabel(item)} to edit it`,
      );
    }
    return { pack: null, boxes: null, pieces: null };
  }
  if (hasSplit) {
    const boxes = item.boxes ?? null;
    const pieces = item.pieces ?? null;
    if (
      explicit != null &&
      !splitMatchesQty({ qty: Number(item.qty), boxes, pieces, unitsPerBox: explicit })
    ) {
      throw new BadRequestException(
        `Line "${lineLabel(item)}": qty ${item.qty} is not ${boxes ?? 0} boxes x ${explicit} + ${pieces ?? 0} pieces`,
      );
    }
    return { pack, boxes, pieces, attested };
  }
  // A box-unaware line keeps its snapshot but stays loose (money = unitPrice x qty).
  if (!wasBoxed) return { pack, boxes: null, pieces: null, attested };
  // A stored box line edited without a split: re-split its qty at its OWN pack.
  const split = normalizeBoxesPieces({ qty: item.qty, unitsPerBox: pack });
  return { pack, boxes: split.boxes, pieces: split.pieces, attested };
}

/** A stored box line whose pack cannot be recovered from its own snapshot or split, and which no payload line matched. */
function isEditOfUnmatchedLegacyRow(ctx: PlanCtx, item: EditPayloadLine): boolean {
  // A client that sends ids knows which lines are new; only an id-less (old cached) client can be editing one.
  if (ctx.items.some((i) => i.id != null)) return false;
  const matched = new Set(ctx.matches.flatMap((m) => (m.row ? [m.row.id] : [])));
  return ctx.stored.some(
    (r) =>
      !matched.has(r.id) &&
      (r.productId ?? null) === (item.productId ?? null) &&
      r.boxes != null &&
      !(Number(r.unitsPerBox) > 1) &&
      packFromOwnSplit({ qty: Number(r.qty), boxes: r.boxes, pieces: r.pieces }) == null,
  );
}

export function buildEditedLines(ctx: PlanCtx): EditedLine[] {
  return ctx.items.map((item, i): EditedLine => {
    const { row, untouched, productChanged } = ctx.matches[i];
    if (row && untouched) {
      // Verbatim: stored money, split, pack, levy and snapshots. Only cosmetic fields follow the payload.
      return {
        rowId: row.id,
        untouched: true,
        data: {
          ...row,
          qty: Number(row.qty),
          unitPrice: Number(row.unitPrice),
          discount: Number(row.discount ?? 0),
          taxRate: Number(row.taxRate ?? 0),
          subtotal: Number(row.subtotal),
          categoryTaxAmount: Number(row.categoryTaxAmount ?? 0),
          description: item.description ?? row.description,
          notes: item.notes ?? null,
          orderItemId: item.orderItemId ?? row.orderItemId ?? null,
        },
      };
    }
    const product = item.productId ? ctx.productMap.get(item.productId) : undefined;
    const unitRes = ctx.resolved?.[i];
    if (product && unitRes && isUnitAware(unitRes)) {
      // VU-4a (D3): the SAME builder create() uses for a unit line; a changed line writes its whole data.
      const category = product.trackedCategoryId
        ? ctx.categoryMap.get(product.trackedCategoryId)
        : null;
      const { tenantId: _t, ...data } = buildInvoiceUnitLine({
        item: item as any,
        product,
        resolved: unitRes,
        category,
        tenantId: undefined,
      });
      return { rowId: row?.id ?? null, untouched: false, data };
    }
    const livePack = product?.unitsPerBox ?? null;
    const qty = item.qty;
    let boxes: number | null = null;
    let pieces: number | null = null;
    let unitsPerBox: number | undefined;
    let ownPack: number | null = null;
    let attestedPack: number | undefined;
    if (row) {
      const r = recoverChangedPack(item, row, productChanged);
      if (r.attested && r.pack != null) attestedPack = r.pack;
      boxes = r.boxes;
      pieces = r.pieces;
      if (r.pack != null) unitsPerBox = r.pack;
      ownPack = rowOwnPack(row, productChanged);
    } else if (item.productId && isEditOfUnmatchedLegacyRow(ctx, item)) {
      // An id-less line that is NOT the full tuple of any stored row, while a stored legacy box line of
      // the same product with no recoverable pack went unmatched, is that line being edited by an old
      // client. Fail closed rather than bill it as a new loose line (SA-186).
      throw new BadRequestException(
        `set the box and piece count for ${lineLabel(item)} to edit it`,
      );
    } else if (item.productId && (item.boxes != null || item.pieces != null)) {
      // A brand-new line: no snapshot yet, so its own split, then the explicit pack, then live (SA-077).
      boxes = item.boxes ?? null;
      pieces = item.pieces ?? null;
      const own = packFromOwnSplit({ qty, boxes: item.boxes, pieces: item.pieces });
      const explicit = item.unitsPerBox != null && item.unitsPerBox >= 2 ? item.unitsPerBox : null;
      const res = resolveUpdateLinePack(own ?? explicit, item, livePack, new Map());
      if (res.pack != null) unitsPerBox = res.pack;
      if (explicit != null && res.pack === explicit) attestedPack = explicit;
      if (res.warn) ctx.warn(res.warn);
    }
    // Reports a payload/live divergence only; the pack above was already chosen without the live one.
    const splitPack =
      item.boxes != null || item.pieces != null
        ? packFromOwnSplit({ qty, boxes: item.boxes, pieces: item.pieces })
        : null;
    if (splitPack != null && livePack && livePack !== splitPack) {
      ctx.warn(
        `productId ${item.productId} — payload's implied pack ${splitPack} differs from the live ` +
          `product's ${livePack}; using the payload's pack.`,
      );
    }
    const freeUnits = ctx.clampFreeUnits(item.promoFreeUnits ?? undefined, boxes, qty);
    const lineSub = priceReplacedLine(item as any, { qty, boxes, pieces, unitsPerBox, freeUnits });
    const category = product?.trackedCategoryId
      ? ctx.categoryMap.get(product.trackedCategoryId)
      : null;
    // The levy basis reads the SAME resolved pack the money used (SA-180): never the live pack for a stored line.
    const basisPack = Number(unitsPerBox ?? ownPack ?? (row ? 0 : livePack) ?? 0);
    const pieceQty = regulatedUnitBasis(
      // A label that resolved to the pack (the only way one reaches this branch) is a pack line.
      { qty, boxes, pieces, unitLabel: null },
      basisPack,
    ).unitBasisQty;
    const categoryTaxAmount = category
      ? computeCategoryTax({
          taxType: category.taxType as CategoryTaxType,
          rate: Number(category.rate),
          unitBasisQty: pieceQty,
          lineSubtotal: lineSub,
          priceIncludesTax: category.priceIncludesTax,
        })
      : 0;
    return {
      rowId: row?.id ?? null,
      untouched: false,
      attestedPack,
      data: {
        description: item.description,
        productId: item.productId,
        // An edit that does not name the order line keeps the stored link (the editors never send it).
        orderItemId: item.orderItemId ?? (productChanged ? null : (row?.orderItemId ?? null)),
        qty,
        unitPrice: item.unitPrice,
        discount: item.discount ?? 0,
        taxRate: item.taxRate ?? 0,
        subtotal: lineSub,
        boxes,
        pieces,
        // A unit row re-sent as a pack line clears its label (the key is absent on every other pack line).
        ...(row?.unitLabel ? { unitLabel: null } : {}),
        // Never CLEAR a pack the line carried (B717); a stored line keeps its own, never a sibling's.
        unitsPerBox: unitsPerBox ?? ownPack ?? null,
        promoFreeUnits: freeUnits > 0 ? freeUnits : null,
        trackedCategoryId: product?.trackedCategoryId ?? null,
        trackedSubcategoryId: product?.trackedSubcategoryId ?? null,
        categoryTaxAmount,
        ...categoryTaxSnapshotOf(category ?? null),
        notes: item.notes ?? null,
        msrp: null as number | null,
      },
    };
  });
}

/** What to write in place for a line that already has a stored row (null = nothing changed). */
export function inPlacePatch(line: EditedLine, row: StoredEditRow): Record<string, any> | null {
  const {
    tenantId: _t,
    id: _i,
    invoiceId: _v,
    createdAt: _c,
    updatedAt: _u,
    ...data
  } = line.data as any;
  if (!line.untouched) return data;
  const patch: Record<string, any> = {};
  for (const k of ["description", "notes", "orderItemId"] as const) {
    if ((data[k] ?? null) !== (row[k] ?? null)) patch[k] = data[k] ?? null;
  }
  if (!same(data.categoryTaxAmount ?? 0, row.categoryTaxAmount ?? 0))
    patch.categoryTaxAmount = data.categoryTaxAmount;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The invoice lines the linked order must be re-synced from (SA-203), or null when nothing money-relevant
 * changed. A re-priced, added or dropped line, or a levy patch, is "changed"; a notes/description-only save
 * is not, and leaves every order line unwritten. A discount/shipping change alone yields [] (totals only).
 */
export function orderSyncLines(
  lines: EditedLine[],
  stored: StoredEditRow[],
  cur: { discount?: unknown; shippingFee?: unknown },
  discount: number,
  shipping: number,
): Array<Record<string, any>> | null {
  const kept = new Set(lines.flatMap((l) => (l.rowId ? [l.rowId] : [])));
  const changed: Array<Record<string, any>> = stored.filter((r) => !kept.has(r.id));
  for (const l of lines) {
    const row = l.rowId ? stored.find((r) => r.id === l.rowId) : undefined;
    const levy = row != null && !same(l.data.categoryTaxAmount ?? 0, row.categoryTaxAmount ?? 0);
    // An orderItemId-only relink of an untouched line moves it to another order line: both ends resync.
    const relink = row != null && (l.data.orderItemId ?? null) !== (row.orderItemId ?? null);
    if (row && (!l.untouched || levy || relink)) changed.push(row);
    if (!row || !l.untouched || relink) changed.push(l.data);
  }
  const totalsMoved = !same(discount, cur.discount ?? 0) || !same(shipping, cur.shippingFee ?? 0);
  return changed.length > 0 || totalsMoved ? changed : null;
}

/**
 * The saved invoice's money from its lines' stored subtotals (same basis as each line): regular tax on the
 * post-discount subtotal, the regulated category tax folded in (RF-4; exempt -> 0 for both, snapshots zeroed).
 */
export function editInvoiceTotals(
  itemsData: Array<Record<string, any>>,
  isTaxExempt: boolean,
  discount: number,
  shipping: number,
): { subtotal: number; taxTotal: number; total: number } {
  const subtotal = roundMoney(itemsData.reduce((s, it) => s + Number(it.subtotal), 0));
  const regularTax = isTaxExempt
    ? 0
    : roundMoney(itemsData.reduce((s, it) => s + it.subtotal * (it.taxRate ?? 0), 0));
  const taxTotal = roundMoney(regularTax + foldCategoryTax(itemsData, isTaxExempt));
  return { subtotal, taxTotal, total: roundMoney(subtotal - discount + shipping + taxTotal) };
}

/** Reads the products (pack + regulated snapshot) and regulated-section tax config the edited lines reference. */
export async function loadEditCatalog(
  db: any,
  items: Array<{ productId?: string | null; unitLabel?: string | null }>,
  /** VU-4a: with the caller's prisma + entitlements, the unit ladders of the lines that ask for a unit. */
  units?: Parameters<typeof prepareUnitLadders>[1],
): Promise<{
  productMap: Map<string, any>;
  categoryMap: Map<string, any>;
  unitsByProduct: Map<string, any[]>;
}> {
  const productIds = [...new Set(items.filter((i) => i.productId).map((i) => i.productId!))];
  const products: any[] =
    productIds.length > 0
      ? await db.product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            name: true,
            kind: true,
            unit: true,
            unitsPerBox: true,
            trackedCategoryId: true,
            trackedSubcategoryId: true,
          },
        })
      : [];
  assertSellableLines(products); // WS8: PATCH /invoices/:id can never put a FAMILY on a line
  const catIds = [...new Set(products.map((p) => p.trackedCategoryId).filter(Boolean))] as string[];
  const cats: any[] =
    catIds.length > 0 ? await db.trackedCategory.findMany({ where: { id: { in: catIds } } }) : [];
  return {
    productMap: new Map(products.map((p) => [p.id, p])),
    categoryMap: new Map(cats.map((c) => [c.id, c])),
    // staff only, behind flag.units_v1; reads nothing when no line asks for a unit (create()'s own gate).
    unitsByProduct: units ? await prepareUnitLadders(items, units) : new Map(),
  };
}

/** SA-189: history must tell an attested pack (the operator's explicit unitsPerBox) from a recovered one. */
export async function auditAttestedPacks(
  tx: any,
  tenantId: string | null | undefined,
  invoiceId: string,
  editLines: EditedLine[],
): Promise<void> {
  const attested = editLines.flatMap((l) =>
    l.attestedPack ? [{ rowId: l.rowId, unitsPerBox: l.attestedPack }] : [],
  );
  if (attested.length === 0) return;
  await tx.auditLog.create({
    data: {
      tenantId,
      action: "INVOICE_LINE_PACK_ATTESTED",
      entityType: "invoice",
      entityId: invoiceId,
      meta: { attested },
    },
  });
}

/**
 * RF-012: a discount / shipping change alone recomputes the invoice total from its STORED lines (moved
 * verbatim out of `update()`, which sits at its size ceiling). Throws when the result is worse than stored.
 */
export function recalcTotalsFromItems(
  existingItems: Array<Record<string, any>>,
  dto: { discount?: number; shippingFee?: number },
  inv: { discount?: unknown; shippingFee?: unknown },
): Record<string, unknown> {
  const subtotal = roundMoney(
    existingItems.reduce((s: number, i: any) => s + Number(i.subtotal), 0),
  );
  const taxTotal = roundMoney(
    existingItems.reduce((s: number, i: any) => s + Number(i.subtotal) * Number(i.taxRate ?? 0), 0),
  );
  const invDiscount = dto.discount !== undefined ? dto.discount : Number(inv.discount);
  const shipping = dto.shippingFee !== undefined ? dto.shippingFee : Number(inv.shippingFee);
  const total = roundMoney(subtotal - invDiscount + shipping + taxTotal);
  assertInvoiceTotalsSane(
    { discount: invDiscount, subtotal, total },
    storedInvoiceTotals(inv as any),
  ); // B1030 / SA-651
  return { subtotal, taxAmount: taxTotal, discount: invDiscount, shippingFee: shipping, total };
}
