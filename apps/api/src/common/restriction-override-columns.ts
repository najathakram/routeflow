/**
 * Row 510: the four staff restriction-override stamp columns on OrderItem and InvoiceItem, named ONCE.
 *
 * - `OVERRIDE_STAMP_SELECT`: spread into a line `select` that must read the stamp (held lines under a lock, coverage).
 * - `carryOverrideStamp(src)`: the stamp of a source line, for a copier that CARRIES it (order->invoice, back-sync,
 *   merge, split). Copiers that RESET it simply leave the columns out (NULL), or spread `CLEARED_OVERRIDE_STAMP` on an
 *   in-place update that changes the line's product.
 * - `withoutOverrideStamp(row)`: a copy of a line with the four columns removed (the PDF model mapper; buyer reads
 *   are an allowlist in staff-only-fields.ts that never names them).
 *
 * Staff-only: a buyer read, a PDF and a receipt never carry these (pinned by restriction-override-staff-only.spec.ts).
 */

export const OVERRIDE_STAMP_COLUMNS = [
  "restrictionOverrideReason",
  "restrictionOverrideBy",
  "restrictionOverrideAt",
  "restrictionOverrideRuleIds",
] as const;
export type OverrideStampColumn = (typeof OVERRIDE_STAMP_COLUMNS)[number];

/** The stamp as stored. `restrictionOverrideBy` is the User id; a NULL list column reads as `[]`. */
export interface OverrideStamp {
  restrictionOverrideReason: string | null;
  restrictionOverrideBy: string | null;
  restrictionOverrideAt: Date | null;
  restrictionOverrideRuleIds: string[];
}

export const OVERRIDE_STAMP_SELECT = {
  restrictionOverrideReason: true,
  restrictionOverrideBy: true,
  restrictionOverrideAt: true,
  restrictionOverrideRuleIds: true,
} as const satisfies Record<OverrideStampColumn, true>;

/** The write that clears a line's stamp (a substitution to another product re-judges it). */
export const CLEARED_OVERRIDE_STAMP: Readonly<OverrideStamp> = Object.freeze({
  restrictionOverrideReason: null,
  restrictionOverrideBy: null,
  restrictionOverrideAt: null,
  restrictionOverrideRuleIds: [] as string[],
});

/** Does this line carry an override? Keyed on the timestamp: a cleared stamp has `[]` rule ids and no `At`. */
export function hasOverrideStamp(line: Partial<OverrideStamp> | null | undefined): boolean {
  return line?.restrictionOverrideAt != null;
}

/**
 * The stamp of `src` for a copier that carries it, exactly as stored (a missing column reads as cleared, so a source
 * read without the columns never invents a stamp). Returns a fresh array: the copy never aliases the source list.
 */
export function carryOverrideStamp(src: Partial<OverrideStamp> | null | undefined): OverrideStamp {
  return {
    restrictionOverrideReason: src?.restrictionOverrideReason ?? null,
    restrictionOverrideBy: src?.restrictionOverrideBy ?? null,
    restrictionOverrideAt: src?.restrictionOverrideAt ?? null,
    restrictionOverrideRuleIds: [...(src?.restrictionOverrideRuleIds ?? [])],
  };
}

/** A shallow copy of `row` without the four stamp columns (keys absent, not undefined). */
export function withoutOverrideStamp<T extends object>(row: T): Omit<T, OverrideStampColumn> {
  const out = { ...row } as Record<string, unknown>;
  for (const col of OVERRIDE_STAMP_COLUMNS) delete out[col];
  return out as Omit<T, OverrideStampColumn>;
}
