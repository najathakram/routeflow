/** A catalog row passed IN by the caller; this module never reads a database. */
export interface CatalogItemRow {
  id: string;
  name: string;
}

/** One alias row passed IN. `sourceItemKey` is the full "Parent:Child" source name. */
export interface ItemAliasRow {
  sourceItemKey: string;
  productId: string | null;
  ignore: boolean;
}

export interface ItemSuggestion {
  productId: string;
  name: string;
  /** 0..1, higher is nearer. A suggestion never confirms anything. */
  score: number;
}

export type ItemMatchKind =
  "ALIAS" | "EXACT" | "NORMALISED" | "AMBIGUOUS" | "SUGGESTED" | "UNMATCHED";

export interface ItemMatchResult {
  kind: ItemMatchKind;
  /** The full source name, trimmed; the key for aliases and staged lines. */
  sourceKey: string;
  /** Set only for ALIAS, EXACT and NORMALISED. Never from a suggestion. */
  productId: string | null;
  ignore: boolean;
  suggestions: ItemSuggestion[];
}

export interface NearNameGroup {
  /** Full source names, sorted. */
  members: string[];
  /** Always false: a group is a suggestion for a person to confirm. */
  confirmed: false;
}
