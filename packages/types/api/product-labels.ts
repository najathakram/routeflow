// Product category labels (2026-09-19, Lane R step 4). Wire shapes for the label manager and the
// product-detail label panel. `LabelMode` is the pinned enum mirror in `./enums`.
import type { LabelMode } from "./enums";

/** A tenant-defined restriction category ("Alcohol", "THC"). Archived = hidden from pickers. */
export interface LabelCategoryDto {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  /** Products carrying an INCLUDE label for this category. */
  productCount: number;
  /** Active (unlifted, unexpired) selling restrictions attached to this category. */
  activeRestrictionCount: number;
}

/** One product↔category assignment. EXCLUDE = a variant's opt-out of a label reaching it through its parent. */
export interface ProductLabelDto {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryArchived: boolean;
  mode: LabelMode;
  reason: string | null;
  createdByName: string | null;
  createdAt: string;
  /**
   * EXCLUDE only. true = the opt-out is in force (its pin is the variant's CURRENT parent); false =
   * INERT — the variant was reparented since (or the row predates the pin), so the label still
   * applies. null on INCLUDE rows.
   */
  optOutActive: boolean | null;
}

/** A category a variant inherits: what its parent's effective label set contains. */
export interface InheritedLabelDto {
  categoryId: string;
  categoryName: string;
  categoryArchived: boolean;
}

/**
 * The labels a product carries. `own` are its own rows (INCLUDE and, on variants, EXCLUDE);
 * `inherited` is the PARENT's EFFECTIVE set as the restrictions engine computes it (through up to
 * five ancestors, never a snapshot; empty for a parent/standalone). `ancestryResolvable` is false when
 * an ancestor is missing / cyclic / too deep — the inherited set is then incomplete, and the engine
 * fails closed for such a product.
 */
export interface ProductLabelsDto {
  productId: string;
  parentProductId: string | null;
  ancestryResolvable: boolean;
  own: ProductLabelDto[];
  inherited: InheritedLabelDto[];
  /**
   * The tenant's label ids an ACTIVE federal (all-customer) rule covers. Writing one of these labels is admin-only
   * (owner ruling 2026-10-14): an operator sees its controls disabled with the shared hint.
   */
  federalCategoryIds: string[];
}

export interface SetProductLabelRequest {
  mode: LabelMode;
  /** REQUIRED when mode = EXCLUDE (an opt-out is a ban-bypass vector). */
  reason?: string;
}
