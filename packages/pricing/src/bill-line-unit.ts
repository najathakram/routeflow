/**
 * SA-1207 S2b: the ONE reader of a bill (or PO) line's own unit (the census spec pins every `packSize` reader).
 * `case`: no label, pack above 1. `lot`: a label and pack above 1 (`factor` pieces per qty, never the catalog box).
 * `piece`: a label, no pack (stated, never B743 "unknown"). `unstated`: no label, pack null, 0 or 1.
 */
export type BillLineUnitKind = "case" | "piece" | "lot" | "unstated";

export interface BillLineUnit {
  kind: BillLineUnitKind;
  /** Pieces in one `qty` of the line: the pack for a case or lot, else 1. */
  factor: number;
  /** The line's own unit name when it states one, else null. */
  label: string | null;
  /** True for case and lot: `unitCost` is per pack, not per piece. */
  boxed: boolean;
  /** True when the line states its own unit (lot or piece): `packSize` is never the catalog box. */
  stated: boolean;
}

export function billLineUnit(item: {
  packSize?: number | string | null;
  unitLabel?: string | null;
}): BillLineUnit {
  const pack = Math.trunc(Number(item.packSize ?? 0));
  const label = item.unitLabel?.trim() ? item.unitLabel.trim() : null;
  const boxed = Number.isFinite(pack) && pack > 1;
  const kind: BillLineUnitKind = label ? (boxed ? "lot" : "piece") : boxed ? "case" : "unstated";
  return { kind, factor: boxed ? pack : 1, label, boxed, stated: label !== null };
}

/**
 * A lot, or a child of a split group, is locked to its own unit: an edit may change `unitCost` only
 * (SA-1207 S2b spec 6). The API refuses the rest (409 SPLIT_LINE_LOCKED); the web disables those fields.
 */
export function billLineLocked(item: {
  packSize?: number | string | null;
  unitLabel?: string | null;
  familyGroupId?: string | null;
}): boolean {
  return item.familyGroupId != null || billLineUnit(item).kind === "lot";
}
