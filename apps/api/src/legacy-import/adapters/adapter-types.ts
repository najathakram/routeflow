import type { CanonicalLine } from "./canonical";

export interface AdaptInput {
  headers: readonly string[];
  cells: readonly string[];
  recordNo: number;
  physicalLine: number;
}

export interface SourceAdapter {
  readonly key: string;
  readonly version: number;
  readonly fileKind: "SALES_LINES";
  /**
   * REQUIRED, never defaulted: does this source state which payment settled which invoice?
   * A shape that cannot say must say `false`; a later linked source says `true`.
   */
  readonly linksKnown: boolean;
  /** True only for the exact header signature this adapter was verified against. */
  matches(headers: readonly string[]): boolean;
  adaptRecord(input: AdaptInput): { line: CanonicalLine | null };
}

/** Validates an adapter at definition time, so a JS caller cannot leave linksKnown out. */
export function defineAdapter(def: SourceAdapter): SourceAdapter {
  if (typeof (def as { linksKnown?: unknown }).linksKnown !== "boolean") {
    throw new Error(`Adapter "${def.key}" must state linksKnown (true or false).`);
  }
  return Object.freeze({ ...def });
}
