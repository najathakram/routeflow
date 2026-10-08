import { API_ERROR_CODES, type ProductUnitLevel } from "@routeflow/types";
import { resolveUnitPrice, type LadderProduct } from "@routeflow/pricing";

/**
 * Units rebuild U-2: the pure side of the chained ladder editor. Rows are entered as a CHAIN
 * ("6 Bottle = 1 Pack", "4 Pack = 1 Case"); the server stores them FLAT (`factorToBase` is the only math source),
 * so everything here works out the flat size from the chain. The messages match PUT /products/:id/units word for word.
 */
export const MAX_FACTOR = 1_000_000;
export const PIECE = "Piece";

export interface LadderRow {
  /** Stable React key; never sent. */
  key: string;
  /** The saved ProductUnit id; undefined = not saved yet. */
  id?: string;
  /** The unit this row defines (the "1 [right]" side). */
  label: string;
  /** The "[n]" side, as typed. */
  perParent: string;
  /** What it is made of (the "[left]" side): the base unit or a lower row's label. */
  parentLabel: string;
  price: string;
  /** Tier 2..5 prices as typed. */
  tiers: [string, string, string, string];
  isDefault: boolean;
  sku: string;
  barcode: string;
}

export interface LadderDraft {
  /** "" = Piece. */
  baseLabel: string;
  rows: LadderRow[];
  /** The label of the row (or the base) the product price is for; null = no pack. */
  packLevel: string | null;
  /** Names created in the editor, sent with Save. */
  newUnits: string[];
  basePrice: string;
  baseTiers: [string, string, string, string];
  baseIsDefault: boolean;
}

export const norm = (s: string) => s.trim().toLowerCase();
export const baseWord = (d: Pick<LadderDraft, "baseLabel">) => d.baseLabel.trim() || PIECE;
const plural = (w: string) => `${w}s`;
const fmtInt = (n: number) => n.toLocaleString("en-US");

export const emptyDraft = (): LadderDraft => ({
  baseLabel: "",
  rows: [],
  packLevel: null,
  newUnits: [],
  basePrice: "",
  baseTiers: ["", "", "", ""],
  baseIsDefault: false,
});

let keySeq = 0;
export const newKey = () => `row-${++keySeq}`;

export function blankRow(label: string, parentLabel: string): LadderRow {
  return {
    key: newKey(),
    label,
    perParent: "",
    parentLabel,
    price: "",
    tiers: ["", "", "", ""],
    isDefault: false,
    sku: "",
    barcode: "",
  };
}

export interface RowError {
  field: "perParent" | "label" | "parent" | "size" | "pack";
  message: string;
}

export interface Resolved {
  /** Flat size per row key (only rows that resolved). */
  factors: Map<string, number>;
  errors: Map<string, RowError>;
}

/** Work out each row's flat size and every error the editor can show inline (first error per row wins). */
export function resolveDraft(draft: LadderDraft, opts: { packWord?: string } = {}): Resolved {
  const base = baseWord(draft);
  const errors = new Map<string, RowError>();
  const factors = new Map<string, number>();
  const byKey = new Map<string, LadderRow>();
  const setErr = (row: LadderRow, e: RowError) => {
    if (!errors.has(row.key)) errors.set(row.key, e);
  };
  for (const row of draft.rows) {
    const label = row.label.trim();
    if (!label) {
      setErr(row, { field: "label", message: "Pick a unit." });
      continue;
    }
    if (norm(label) === norm(base)) {
      setErr(row, { field: "label", message: `Pick a bigger unit than ${base}.` });
      continue;
    }
    const first = byKey.get(norm(label));
    if (first) {
      setErr(row, {
        field: "label",
        message: `${first.label.trim()} is already in this ladder. Use each unit once.`,
      });
      continue;
    }
    byKey.set(norm(label), row);
  }

  const visiting = new Set<string>();
  const resolve = (row: LadderRow): number | null => {
    const cached = factors.get(row.key);
    if (cached !== undefined) return cached;
    if (errors.get(row.key)?.field === "label") return null;
    const n = Number(row.perParent);
    if (!row.perParent.trim() || !Number.isInteger(n) || n < 2) {
      setErr(row, { field: "perParent", message: "Enter a whole number, 2 or more." });
      return null;
    }
    let parentFactor = 1;
    const left = row.parentLabel.trim();
    if (left && norm(left) !== norm(base)) {
      const parent = byKey.get(norm(left));
      if (!parent || parent === row || visiting.has(row.key)) {
        setErr(row, {
          field: "parent",
          message: `Pick a unit from this ladder to build ${row.label.trim()} on.`,
        });
        return null;
      }
      visiting.add(row.key);
      const pf = resolve(parent);
      visiting.delete(row.key);
      if (pf == null) return null;
      parentFactor = pf;
    }
    const f = n * parentFactor;
    if (f > MAX_FACTOR) {
      setErr(row, {
        field: "perParent",
        message: `That's more than 1,000,000 ${plural(base)} in one ${row.label.trim()}. Check the numbers.`,
      });
      return null;
    }
    factors.set(row.key, f);
    return f;
  };
  for (const row of draft.rows) resolve(row);

  const seen = new Map<number, LadderRow>();
  for (const row of draft.rows) {
    const f = factors.get(row.key);
    if (f == null) continue;
    const prior = seen.get(f);
    if (prior) {
      setErr(row, {
        field: "size",
        message: `${prior.label.trim()} and ${row.label.trim()} would both hold ${fmtInt(f)} ${plural(base)}. Change one.`,
      });
    } else seen.set(f, row);
  }
  if (opts.packWord && draft.baseLabel.trim() && norm(opts.packWord) === norm(base)) {
    const row = packRow(draft) ?? draft.rows[0];
    if (row)
      setErr(row, {
        field: "pack",
        message: "The pack can't have the same name as the smallest unit.",
      });
  }
  return { factors, errors };
}

/** "1 Case = 4 Packs = 24 Bottles": the top-down chain of the biggest row, or "" when there is nothing to say. */
export function summaryText(draft: LadderDraft, resolved: Resolved = resolveDraft(draft)): string {
  const base = baseWord(draft);
  const good = draft.rows.filter((r) => resolved.factors.has(r.key) && !resolved.errors.has(r.key));
  if (good.length === 0) return "";
  // Walk up to the largest size, then down its parent chain.
  const top = good.reduce((a, b) =>
    (resolved.factors.get(b.key) as number) > (resolved.factors.get(a.key) as number) ? b : a,
  );
  const parts: string[] = [`1 ${top.label.trim()}`];
  let cur: LadderRow | undefined = top;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.key)) {
    guard.add(cur.key);
    const n = Number(cur.perParent);
    const left = cur.parentLabel.trim();
    const parent: LadderRow | undefined =
      left && norm(left) !== norm(base)
        ? draft.rows.find((r) => norm(r.label) === norm(left))
        : undefined;
    if (parent) {
      parts.push(`${fmtInt(n)} ${n === 1 ? parent.label.trim() : plural(parent.label.trim())}`);
      cur = parent;
    } else {
      parts.push(`${fmtInt(resolved.factors.get(top.key) as number)} ${plural(base)}`);
      break;
    }
  }
  // Collapse "N Packs = 24 Bottles" when the chain was a single hop.
  return parts.join(" = ");
}

/** Add-new-unit name rules, same as Settings. */
export function unitNameError(raw: string, taken: string[]): string | null {
  const name = raw.trim();
  if (!name) return "Enter a name.";
  if (name.length > 30) return "Keep it to 30 characters or fewer.";
  const hit = taken.find((t) => norm(t) === norm(name));
  if (hit) return `You already have a unit called ${hit}.`;
  return null;
}

/** Remove a row and every row built (even indirectly) on it. */
export function removeRowAndDescendants(rows: LadderRow[], key: string): LadderRow[] {
  const gone = new Set<string>([key]);
  const labelOf = new Map(rows.map((r) => [r.key, norm(r.label)]));
  let grew = true;
  while (grew) {
    grew = false;
    const goneLabels = new Set([...gone].map((k) => labelOf.get(k)));
    for (const r of rows) {
      if (!gone.has(r.key) && goneLabels.has(norm(r.parentLabel))) {
        gone.add(r.key);
        grew = true;
      }
    }
  }
  return rows.filter((r) => !gone.has(r.key));
}

/** True for the row the product's own price is for (the pack): it is sent without a price of its own. */
export const isPackRow = (draft: LadderDraft, row: LadderRow) =>
  draft.packLevel != null && norm(draft.packLevel) === norm(row.label);

/** The pack row this draft prices the product at (null = base or no pack). */
export function packRow(draft: LadderDraft): LadderRow | null {
  if (!draft.packLevel) return null;
  return draft.rows.find((r) => norm(r.label) === norm(draft.packLevel as string)) ?? null;
}

/** "Case = 24 Bottles (from your units below)" for the read-only Units per box, or null when nothing is set. */
export function unitsPerBoxText(draft: LadderDraft, resolved = resolveDraft(draft)): string | null {
  const row = packRow(draft);
  if (!row) return null;
  const f = resolved.factors.get(row.key);
  if (f == null) return null;
  return `${row.label.trim()} = ${fmtInt(f)} ${plural(baseWord(draft))} (from your units below)`;
}

/** The "Set up units" line shown while the editor is closed. */
export function collapsedText(
  draft: LadderDraft,
  unitsPerBox: number | null | undefined,
  isSetUp: boolean = draft.rows.length > 0,
): string {
  if (!isSetUp) {
    const upb = Math.trunc(Number(unitsPerBox ?? 0));
    return upb > 1 ? `Sold by the box (${upb} pieces) and by the piece.` : "Sold in single pieces.";
  }
  return summaryText(draft);
}

export const hasSavedSetup = (draft: LadderDraft) => draft.rows.length > 0;

// ─── loading ────────────────────────────────────────────────────────────────

export interface LadderProductShape {
  unit?: string | null;
  unitsPerBox?: number | null;
  baseUnitLabel?: string | null;
  packLabel?: string | null;
}

/** The ProductUnit shape the editor reads: the shared type plus the U-2 columns. */
export type LadderUnitRecord = ProductUnitLevel & {
  perParent?: number | null;
  sku?: string | null;
};

const s = (v: string | number | null | undefined) => (v == null ? "" : String(Number(v)));

/**
 * Rebuild the editor's chain from what the server holds. A legacy level (no perParent) loads as
 * "[factor] [Piece] = 1 [Level]". The pack becomes a row of its own (the server never stores it as one).
 */
export function draftFromServer(
  product: LadderProductShape,
  units: readonly LadderUnitRecord[],
): LadderDraft {
  const baseLabel =
    (product.baseUnitLabel ?? "").trim() === PIECE ? "" : (product.baseUnitLabel ?? "").trim();
  const base = baseLabel || PIECE;
  const upb = Math.trunc(Number(product.unitsPerBox ?? 0));
  const packFactor = upb > 1 ? upb : 0;
  const packWord = (product.packLabel ?? "").trim() || (product.unit ?? "").trim() || "Box";
  const levels = [...units]
    .filter((u) => u.factorToBase > 1)
    .sort((a, b) => a.factorToBase - b.factorToBase);
  const piece = units.find((u) => u.factorToBase === 1);

  const labelAt = new Map<number, string>([[1, base]]);
  if (packFactor) labelAt.set(packFactor, packWord);
  levels.forEach((u) => labelAt.set(u.factorToBase, u.label));

  const rows: LadderRow[] = levels.map((u) => {
    const per = u.perParent && u.perParent >= 2 ? u.perParent : null;
    const parentFactor = per ? u.factorToBase / per : 1;
    return {
      key: newKey(),
      id: u.id,
      label: u.label,
      perParent: String(per ?? u.factorToBase),
      parentLabel: labelAt.get(Number.isInteger(parentFactor) ? parentFactor : 1) ?? base,
      price: s(u.price),
      tiers: [s(u.priceTier2), s(u.priceTier3), s(u.priceTier4), s(u.priceTier5)],
      isDefault: u.isDefaultSelling,
      sku: u.sku ?? "",
      barcode: "",
    };
  });
  if (packFactor && !levels.some((u) => u.factorToBase === packFactor)) {
    // The pack's parent: the largest lower size that divides it (a legacy pack sits on the base).
    const lower = [...labelAt.keys()].filter((f) => f < packFactor && packFactor % f === 0);
    const parentFactor = lower.length ? Math.max(...lower) : 1;
    rows.push({
      ...blankRow(packWord, labelAt.get(parentFactor) ?? base),
      perParent: String(packFactor / parentFactor),
    });
    rows.sort((a, b) => factorOfRow(a, rows, base) - factorOfRow(b, rows, base));
  }
  return {
    baseLabel,
    rows,
    packLevel: packFactor ? packWord : null,
    newUnits: [],
    basePrice: s(piece?.price),
    baseTiers: [
      s(piece?.priceTier2),
      s(piece?.priceTier3),
      s(piece?.priceTier4),
      s(piece?.priceTier5),
    ],
    baseIsDefault: piece?.isDefaultSelling ?? false,
  };
}

function factorOfRow(row: LadderRow, rows: LadderRow[], base: string): number {
  const n = Number(row.perParent) || 1;
  const left = row.parentLabel.trim();
  const parent =
    left && norm(left) !== norm(base) ? rows.find((r) => norm(r.label) === norm(left)) : undefined;
  return n * (parent && parent !== row ? factorOfRow(parent, rows, base) : 1);
}

// ─── saving ─────────────────────────────────────────────────────────────────

export interface LadderPutBody {
  baseUnitLabel: string | null;
  packLabel: string | null;
  packLevel: string | null;
  levels: Array<{
    label: string;
    perParent: number;
    parentLabel: string | null;
    price?: number | null;
    tiers?: Array<number | null>;
    isDefaultSelling: boolean;
    sortOrder: number;
    barcode?: string | null;
    sku?: string | null;
  }>;
  newUnits?: string[];
  base?: { price?: number | null; tiers?: Array<number | null>; isDefaultSelling?: boolean } | null;
}

const money = (t: string): number | null => {
  const n = Number(t);
  return t.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

export function toPutBody(
  draft: LadderDraft,
  opts: { sendBase: boolean; sendCodes: boolean },
): LadderPutBody {
  const base = baseWord(draft);
  const pack = packRow(draft);
  const packIsBase = draft.packLevel != null && norm(draft.packLevel) === norm(base);
  return {
    baseUnitLabel: draft.baseLabel.trim() || null,
    packLabel: pack ? pack.label.trim() : packIsBase ? null : null,
    packLevel: draft.packLevel,
    levels: draft.rows.map((r, i) => ({
      label: r.label.trim(),
      perParent: Number(r.perParent),
      parentLabel:
        norm(r.parentLabel) === norm(base) || !r.parentLabel.trim() ? null : r.parentLabel.trim(),
      ...(isPackRow(draft, r) ? {} : { price: money(r.price), tiers: r.tiers.map(money) }),
      isDefaultSelling: isPackRow(draft, r) ? false : r.isDefault,
      sortOrder: i,
      ...(opts.sendCodes ? { barcode: r.barcode.trim() || null, sku: r.sku.trim() || null } : {}),
    })),
    ...(draft.newUnits.length ? { newUnits: draft.newUnits } : {}),
    ...(opts.sendBase
      ? {
          base:
            money(draft.basePrice) == null &&
            !draft.baseTiers.some((t) => money(t) != null) &&
            !draft.baseIsDefault
              ? null
              : {
                  price: money(draft.basePrice),
                  tiers: draft.baseTiers.map(money),
                  isDefaultSelling: draft.baseIsDefault,
                },
        }
      : {}),
  };
}

// ─── prices ─────────────────────────────────────────────────────────────────

/**
 * What tier `tier` would price at for the row labelled `label` if THAT field were left blank (so a derived
 * figure never previews the explicit price it replaces). Shared by the saved-row card and the editor table.
 */
export function derivedLevelPrice<U extends Parameters<typeof resolveUnitPrice>[1][number]>(
  product: LadderProduct,
  units: ReadonlyArray<U>,
  label: string,
  draftPrices: ReadonlyArray<number | null>,
  tier: number,
  isSelf: (u: U) => boolean,
): number | null {
  try {
    const preview = units.map((u) =>
      !isSelf(u)
        ? u
        : {
            ...u,
            price: draftPrices[0] == null || tier === 1 ? null : String(draftPrices[0]),
            priceTier2: tier === 2 || draftPrices[1] == null ? null : String(draftPrices[1]),
            priceTier3: tier === 3 || draftPrices[2] == null ? null : String(draftPrices[2]),
            priceTier4: tier === 4 || draftPrices[3] == null ? null : String(draftPrices[3]),
            priceTier5: tier === 5 || draftPrices[4] == null ? null : String(draftPrices[4]),
          },
    );
    return resolveUnitPrice(product, preview, label, tier);
  } catch {
    return null;
  }
}

// ─── server errors ──────────────────────────────────────────────────────────

export const USED_SIZE_SUFFIX =
  "is already used on an order or invoice at a different size, so its size cannot change. Create a new unit instead.";
export const COULDNT_CHECK =
  "Couldn't check that code right now. Your entry is still here. Try again.";

export interface MappedLadderError {
  /** Row label the message belongs under; undefined = form-level. */
  rowLabel?: string;
  field?: "perParent" | "label" | "size" | "sku" | "barcode" | "pack" | "parent";
  message: string;
  /** Show "Add a new unit instead" under the row. */
  offerNewUnit?: boolean;
}

type ApiErr = {
  response?: {
    status?: number;
    data?: {
      message?: unknown;
      code?: string;
      field?: string;
      level?: string;
      productName?: string;
      inactive?: boolean;
    };
  };
};

/** Map a PUT failure to the inline message it belongs under (by status + code + the used-size text). */
export function mapLadderError(err: unknown): MappedLadderError {
  const r = (err as ApiErr)?.response;
  const status = r?.status;
  const data = r?.data ?? {};
  const raw =
    typeof data.message === "string"
      ? data.message
      : Array.isArray(data.message)
        ? String(data.message[0])
        : "";
  if (status === 409 && raw.includes(USED_SIZE_SUFFIX)) {
    const label = raw.match(/^"(.*)" is already used/)?.[1];
    return { rowLabel: label, field: "perParent", message: raw, offerNewUnit: true };
  }
  if (
    status === 409 &&
    (data.code === API_ERROR_CODES.BARCODE_TAKEN || data.code === API_ERROR_CODES.CODE_TAKEN)
  ) {
    const kind = data.field === "barcode" ? "barcode" : "SKU";
    const holder = data.productName ?? "another product";
    return {
      rowLabel: data.level,
      field: data.field === "barcode" ? "barcode" : "sku",
      message: data.inactive
        ? `That ${kind} is on ${holder}, which is turned off. Turn it back on to change it, or use a different ${kind}.`
        : `That ${kind} is already on ${holder}. One ${kind} can only belong to one product. Use a different one, or change ${holder} first.`,
    };
  }
  if (status === 503) return { message: COULDNT_CHECK };
  if (data.level || data.field) {
    return {
      rowLabel: data.level,
      field: (data.field as MappedLadderError["field"]) ?? undefined,
      message: raw || "Couldn't save the units.",
    };
  }
  return { message: raw || "Couldn't save the units." };
}
