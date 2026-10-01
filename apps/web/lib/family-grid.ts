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
const norm = (s: string) => s.trim().toLowerCase();

export function validateFamilyForm(f: FamilyForm): FamilyValidation {
  const family: FamilyValidation["family"] = {};
  const rows: FamilyValidation["rows"] = {};
  let formError: string | null = null;

  if (!f.name.trim()) family.name = "Enter a family name.";
  if (f.pricePerUnit.trim() && !MONEY.test(f.pricePerUnit.trim())) family.pricePerUnit = PRICE_MSG;
  if (f.standardCost.trim() && !COST.test(f.standardCost.trim()))
    family.standardCost = "Enter a cost like 0.80.";

  if (f.rows.length < 1) formError = "Add at least one variant.";
  else if (f.rows.length > MAX_FAMILY_ROWS)
    formError = `A family takes up to ${MAX_FAMILY_ROWS} variants at a time.`;

  const set = (i: number, field: RowField, msg: string) => {
    rows[i] = { ...(rows[i] ?? {}), [field]: msg };
  };

  f.rows.forEach((r, i) => {
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
  });

  // Duplicates inside the grid, flagged on EVERY row that repeats (blank values never count).
  for (const field of ["name", "sku", "barcode", "unitSku"] as const) {
    const seen = new Map<string, number[]>();
    f.rows.forEach((r, i) => {
      const v = norm(r[field]);
      if (v) seen.set(v, [...(seen.get(v) ?? []), i]);
    });
    for (const idxs of seen.values())
      if (idxs.length > 1) idxs.forEach((i) => set(i, field, DUP_MSG));
  }

  const valid =
    formError === null && Object.keys(family).length === 0 && Object.keys(rows).length === 0;
  return { valid, family, rows, formError };
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
      ...(given(f.pricePerUnit) ? { pricePerUnit: trim(f.pricePerUnit) } : {}),
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
