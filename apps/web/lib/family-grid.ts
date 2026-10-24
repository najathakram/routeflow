import { roundMoney } from "@routeflow/pricing";
import type {
  CreateFamilyRequest,
  FamilyVariantInput,
  UpdateFamilyVariantsRequest,
} from "@routeflow/types";

/**
 * WS8: the pure side of the family create dialog and the variants grid — client rules that mirror the
 * API DTO (apps/api/src/products/dto/family.dto.ts), and the exact request bodies. The write is the
 * authority; these only spare the operator a round trip for the common mistakes.
 */

export const MAX_FAMILY_ROWS = 200;

// Decimal(10,2): at most 8 integer digits. Decimal(10,4): at most 6.
const MONEY = /^\d{1,8}(\.\d+)?$/;
const COST = /^\d{1,6}(\.\d+)?$/;

export interface GridRow {
  /** Stable React key (not sent). */
  key: string;
  /** Present for a saved variant; absent for a row not yet created. */
  id?: string;
  name: string;
  sku: string;
  barcode: string;
  unitSku: string;
  /** Text input value; "" = not set. */
  unitsPerBox: string;
  pricePerUnit: string;
  /** "" = inherit the family cost (SA-606g). */
  standardCost: string;
}

export const blankRow = (key: string): GridRow => ({
  key,
  name: "",
  sku: "",
  barcode: "",
  unitSku: "",
  unitsPerBox: "",
  pricePerUnit: "",
  standardCost: "",
});

export interface FamilyForm {
  name: string;
  category: string;
  description: string;
  pricePerUnit: string;
  standardCost: string;
  copyFamilyPrice: boolean;
  rows: GridRow[];
}

export type RowField =
  "name" | "sku" | "barcode" | "unitSku" | "unitsPerBox" | "pricePerUnit" | "standardCost";

export interface FamilyValidation {
  valid: boolean;
  family: { name?: string; pricePerUnit?: string; standardCost?: string };
  rows: Record<number, Partial<Record<RowField, string>>>;
  formError: string | null;
}

const PRICE_MSG = "Enter a price like 1.50.";
const DUP_MSG = "Appears more than once.";
export const CANNOT_CLEAR_MSG = "Can't be cleared once set. Enter a new value.";
export const FAMILY_PRICE_REQUIRED_MSG = "Enter the family price.";
export const COPY_PRICE_NEEDS_PRICE_MSG = "Enter the family price to copy it onto the variants.";
const norm = (s: string) => s.trim().toLowerCase();

/** The row rules alone: used by the create dialog (with the family fields) and the detail edit. */
export function validateRows(
  rowsIn: GridRow[],
  opts: { original?: GridRow[]; capRows?: boolean } = {},
): Pick<FamilyValidation, "valid" | "rows" | "formError"> {
  const capRows = opts.capRows ?? true;
  const savedById = new Map(
    (opts.original ?? []).filter((r) => r.id).map((r) => [r.id as string, r]),
  );
  const rows: FamilyValidation["rows"] = {};
  let formError: string | null = null;
  if (rowsIn.length < 1) formError = "Add at least one variant.";
  else if (capRows && rowsIn.length > MAX_FAMILY_ROWS)
    formError = `A family takes up to ${MAX_FAMILY_ROWS} variants at a time.`;

  const set = (i: number, field: RowField, msg: string) => {
    rows[i] = { ...(rows[i] ?? {}), [field]: msg };
  };

  rowsIn.forEach((r, i) => {
    if (!r.name.trim()) set(i, "name", "Enter a name.");
    const price = r.pricePerUnit.trim();
    if (!price) set(i, "pricePerUnit", "Enter a price.");
    else if (!MONEY.test(price)) set(i, "pricePerUnit", PRICE_MSG);
    const cost = r.standardCost.trim();
    if (cost && !COST.test(cost)) {
      set(i, "standardCost", "Enter a cost like 0.80, or leave blank to use the family cost.");
    }
    const upb = r.unitsPerBox.trim();
    if (upb && !(/^\d+$/.test(upb) && Number(upb) >= 1))
      set(i, "unitsPerBox", "Whole number, 1 or more.");
    // An update has no "clear" for units/case or cost (the API 400s / ignores it): refuse visibly rather
    // than let Save report success while the old value stays.
    const before = r.id ? savedById.get(r.id) : undefined;
    if (before) {
      for (const f of ["unitsPerBox", "standardCost"] as const) {
        if (before[f].trim() && !r[f].trim()) set(i, f, CANNOT_CLEAR_MSG);
      }
    }
  });

  // Duplicates inside the grid, flagged on EVERY row that repeats (blank values never count).
  for (const field of ["name", "sku", "barcode", "unitSku"] as const) {
    const seen = new Map<string, number[]>();
    rowsIn.forEach((r, i) => {
      const v = norm(r[field]);
      if (v) seen.set(v, [...(seen.get(v) ?? []), i]);
    });
    for (const idxs of seen.values())
      if (idxs.length > 1) idxs.forEach((i) => set(i, field, DUP_MSG));
  }
  return { valid: formError === null && Object.keys(rows).length === 0, rows, formError };
}

export function validateFamilyForm(f: FamilyForm): FamilyValidation {
  const family: FamilyValidation["family"] = {};
  if (!f.name.trim()) family.name = "Enter a family name.";
  // SA-606i: the family price is REQUIRED by the API (no implicit $0.00), so a blank one is refused here, not at the server.
  if (!f.pricePerUnit.trim()) family.pricePerUnit = FAMILY_PRICE_REQUIRED_MSG;
  else if (!MONEY.test(f.pricePerUnit.trim())) family.pricePerUnit = PRICE_MSG;
  // Copying a family price that rounds to $0.00 would save every variant at $0.00: the server refuses it (coded 400), so
  // it is blocked here with the same fixed copy (the money rounding is @routeflow/pricing's).
  else if (f.copyFamilyPrice && roundMoney(Number(f.pricePerUnit.trim())) <= 0)
    family.pricePerUnit = COPY_PRICE_NEEDS_PRICE_MSG;
  if (f.standardCost.trim() && !COST.test(f.standardCost.trim()))
    family.standardCost = "Enter a cost like 0.80.";
  const r = validateRows(f.rows);
  return {
    valid: r.valid && Object.keys(family).length === 0,
    family,
    rows: r.rows,
    formError: r.formError,
  };
}

const trim = (s: string) => s.trim();
const given = (s: string) => (s.trim() ? s.trim() : undefined);

function variantInput(r: GridRow): FamilyVariantInput {
  return {
    name: trim(r.name),
    ...(given(r.sku) ? { sku: trim(r.sku) } : {}),
    ...(given(r.barcode) ? { barcode: trim(r.barcode) } : {}),
    ...(given(r.unitSku) ? { unitSku: trim(r.unitSku) } : {}),
    ...(given(r.unitsPerBox) ? { unitsPerBox: Number(r.unitsPerBox) } : {}),
    pricePerUnit: trim(r.pricePerUnit),
    ...(given(r.standardCost) ? { standardCost: trim(r.standardCost) } : {}),
  };
}

/** The exact POST /products/families body: trimmed, blanks omitted, money kept as strings. */
export function toCreateRequest(f: FamilyForm): CreateFamilyRequest {
  return {
    family: {
      name: trim(f.name),
      ...(given(f.category) ? { category: trim(f.category) } : {}),
      ...(given(f.description) ? { description: trim(f.description) } : {}),
      pricePerUnit: trim(f.pricePerUnit),
      ...(given(f.standardCost) ? { standardCost: trim(f.standardCost) } : {}),
    },
    variants: f.rows.map(variantInput),
    ...(f.copyFamilyPrice ? { copyFamilyPrice: true } : {}),
  };
}

const EDITABLE = [
  "name",
  "sku",
  "barcode",
  "unitSku",
  "unitsPerBox",
  "pricePerUnit",
  "standardCost",
] as const;

/**
 * ONE all-or-nothing PATCH /products/:id/variants body from the edited grid: changed fields only per
 * saved row, new rows as `add`, rows no longer in the grid as `deactivate`. {} = nothing to send.
 * A cleared optional field is sent as "" so the server can clear it.
 */
export function diffVariantUpdates(
  original: GridRow[],
  edited: GridRow[],
): UpdateFamilyVariantsRequest {
  const byId = new Map(original.filter((r) => r.id).map((r) => [r.id as string, r]));
  const add: FamilyVariantInput[] = [];
  const update: Array<Record<string, unknown> & { id: string }> = [];
  const kept = new Set<string>();
  for (const r of edited) {
    if (!r.id) {
      add.push(variantInput(r));
      continue;
    }
    kept.add(r.id);
    const before = byId.get(r.id);
    if (!before) continue;
    const changes: Record<string, unknown> = {};
    for (const field of EDITABLE) {
      if (trim(r[field]) === trim(before[field])) continue;
      // Only the codes can be cleared by an update; name/price are required and units/cost have no
      // "clear" in the contract (an emptied cell is simply left as it was).
      if (!given(r[field]) && !(field === "sku" || field === "barcode" || field === "unitSku"))
        continue;
      changes[field] =
        field === "unitsPerBox" && given(r[field]) ? Number(r[field]) : trim(r[field]);
    }
    if (Object.keys(changes).length > 0) update.push({ id: r.id, ...changes });
  }
  const deactivate = [...byId.keys()].filter((id) => !kept.has(id));
  return {
    ...(update.length ? { update: update as UpdateFamilyVariantsRequest["update"] } : {}),
    ...(deactivate.length ? { deactivate } : {}),
    ...(add.length ? { add } : {}),
  };
}

/**
 * A PATCH conflict's `row` counts the request's `add` rows first, then its `update` rows (offset by
 * add.length). Maps it back to the grid index of the row that produced it, or null when out of range.
 */
export function patchRowToGridIndex(
  row: number,
  request: UpdateFamilyVariantsRequest,
  edited: GridRow[],
): number | null {
  const addCount = request.add?.length ?? 0;
  if (!Number.isInteger(row) || row < 0) return null;
  if (row < addCount) {
    const idx = edited.map((r, i) => (r.id ? -1 : i)).filter((i) => i >= 0)[row];
    return idx ?? null;
  }
  const upd = request.update?.[row - addCount];
  if (!upd) return null;
  const idx = edited.findIndex((r) => r.id === upd.id);
  return idx >= 0 ? idx : null;
}

/** Rows a PATCH carries: the server caps add + update + deactivate together (not the grid's row count). */
export function requestRowCount(r: UpdateFamilyVariantsRequest): number {
  return (r.add?.length ?? 0) + (r.update?.length ?? 0) + (r.deactivate?.length ?? 0);
}
