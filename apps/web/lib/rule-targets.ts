import type {
  RuleTargetKind,
  RuleTargetSummary,
  RuleTargetsInput,
  SellingRestrictionListItemDto,
} from "@routeflow/types";
import { countNoun } from "./plural";

/**
 * Row 509: the products and labels a rule covers, as the editor handles them. One shape for the
 * picker, the new-rule form and the rule detail; the wire shape is `RuleTargetsInput`.
 */
export interface PickedTarget {
  kind: RuleTargetKind;
  id: string;
  /** "<Family> - <Variant>" for a variant, "<Family> (all variants)" for a whole family, the label name. */
  name: string;
  /** A FAMILY (or parent) picked as a whole: it covers every current and future variant (owner Q1). */
  isFamily?: boolean;
  sku?: string | null;
  /** A variant's family id, so picking the whole family can drop the variant chips it now covers. */
  parentId?: string | null;
}

/** Past this many picks the chips collapse into a count with "Show all". */
export const PICKER_CHIP_COLLAPSE_AT = 8;

/** The request half of a pick list: ids split by kind, an empty side omitted. */
export function targetsToInput(list: readonly PickedTarget[]): RuleTargetsInput {
  const productIds = list.filter((t) => t.kind === "PRODUCT").map((t) => t.id);
  const categoryIds = list.filter((t) => t.kind === "CATEGORY").map((t) => t.id);
  return {
    ...(productIds.length ? { productIds } : {}),
    ...(categoryIds.length ? { categoryIds } : {}),
  };
}

export function countsOf(list: readonly PickedTarget[]): { products: number; labels: number } {
  const labels = list.filter((t) => t.kind === "CATEGORY").length;
  return { products: list.length - labels, labels };
}

/** "12 products · 2 labels" ("" for none). `sep` joins the two halves (" and " in a sentence). */
export function targetCountText(products: number, labels: number, sep = " · "): string {
  return [
    products > 0 ? countNoun(products, "product") : "",
    labels > 0 ? countNoun(labels, "label") : "",
  ]
    .filter(Boolean)
    .join(sep);
}

/** The calm live sentence of the new-rule dialog: "Applies to 12 products in TX, CA". */
export function appliesToLine(
  list: readonly PickedTarget[],
  jurisdiction: "FEDERAL" | "STATE",
  states: readonly string[],
): string {
  const { products, labels } = countsOf(list);
  const what = targetCountText(products, labels, " and ");
  if (!what) return "";
  if (jurisdiction === "FEDERAL") return `Applies to ${what} everywhere`;
  return states.length > 0 ? `Applies to ${what} in ${states.join(", ")}` : `Applies to ${what}`;
}

/**
 * What a rules-list card calls the rule's target. With a server `targetSummary`: a single target keeps
 * its own name and kind (so a one-product rule reads as before), several read "12 products · Vapes label"
 * with the first three names beneath. Without one (a pre-509 server) the legacy single target.
 */
export function ruleCardTarget(
  r: Pick<SellingRestrictionListItemDto, "categoryName" | "productName"> & {
    targetSummary?: RuleTargetSummary;
  },
): {
  name: string;
  kind: "Category" | "Product" | null;
  /** "Vapes, Sample Pod, Gummies, +10 more"; null for a single target. */
  names: string | null;
  /** Products plus labels; null when the server sent no summary. */
  total: number | null;
} {
  const s = r.targetSummary;
  if (!s) {
    return r.productName
      ? { name: r.productName, kind: "Product", names: null, total: null }
      : { name: r.categoryName ?? "Unknown item", kind: "Category", names: null, total: null };
  }
  const total = s.products + s.categories;
  if (total === 1) {
    const only = s.preview[0];
    const isProduct = only ? only.kind === "PRODUCT" : s.products === 1;
    return {
      name: only?.name ?? r.productName ?? r.categoryName ?? "Unknown item",
      kind: isProduct ? "Product" : "Category",
      names: null,
      total,
    };
  }
  const labelPart =
    s.categories === 0
      ? ""
      : s.categories === 1
        ? `${s.preview.find((p) => p.kind === "CATEGORY")?.name ?? "1"} label`
        : countNoun(s.categories, "label");
  const productPart = s.products > 0 ? countNoun(s.products, "product") : "";
  const shown = s.preview.slice(0, 3).map((p) => p.name);
  const more = total - shown.length;
  return {
    name: [productPart, labelPart].filter(Boolean).join(" · "),
    kind: null,
    names: shown.length > 0 ? [...shown, ...(more > 0 ? [`+${more} more`] : [])].join(", ") : null,
    total,
  };
}
