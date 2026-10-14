import {
  RULE_TARGETS_MAX_PER_REQUEST,
  type RuleTargetSummary,
  type SellingRestrictionListItemDto,
} from "@routeflow/types";
import { fmtDate } from "./formatting";
import { ruleSentence } from "./restriction-rules";

/**
 * Row 509 PR5: every sentence the rule chooser, the catalog's Restrict… menu and the product card say, in one place.
 * Pure, so the copy has one home and the dialogs stay thin.
 */

export const RESTRICT_MAX = RULE_TARGETS_MAX_PER_REQUEST;
export const UNDO_ADD_REASON = "Undone right after adding";

export const ALREADY_IN_RULE = "Already in this rule.";
export const RESTRICT_SAVE_FAILED = "Couldn't save. Nothing was changed. Try again.";
export const RESTRICT_UNDO_FAILED = "Couldn't undo. Nothing was changed.";
export const RESTRICT_TOO_MANY = `Select up to ${RESTRICT_MAX.toLocaleString("en-US")} products at a time.`;

/** Why a bulk action is off while the selection came from "Select all matching" (it holds ids beyond this page). */
export const OFF_PAGE_HINT = "Choose products on this page to use this action.";

/** The id of the one visible hint line the catalog bar renders while the selection is off-page; disabled controls point at it. */
export const OFF_PAGE_HINT_ID = "bulk-off-page-hint";

/** An account admin: the only roles that may change a rule that applies to every portal customer (owner L5). */
export const isRuleAdmin = (role: string | undefined): boolean =>
  role === "TENANT_ADMIN" || role === "SUPER_ADMIN";

export const ruleHref = (id: string) => `/settings/restrictions/rules/${id}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const productsText = (n: number) => plural(n, "product", "products");

/** "this product" for one, "8 products" for more (dialog titles). */
export const subjectText = (n: number) => (n === 1 ? "this product" : productsText(n));

/** "12 products" | "3 labels" | "2 labels + 4 products": what a rule covers now. null when the server did not say. */
export function coverageText(summary?: RuleTargetSummary): string | null {
  if (!summary) return null;
  const p = summary.products;
  const c = summary.categories;
  if (c === 0) return productsText(p);
  const labels = plural(c, "label", "labels");
  return p === 0 ? labels : `${labels} + ${productsText(p)}`;
}

/** How many things a rule covers (products + labels); 0 when the server did not say. */
export const coverageCount = (summary?: RuleTargetSummary): number =>
  summary ? summary.products + summary.categories : 0;

/**
 * One line of what a rule does: the rules page's own sentence ("Banned in Texas and California · <surface>", one
 * wording for both screens) plus what it covers and, for a scheduled rule, when it starts.
 */
export function ruleLine(r: SellingRestrictionListItemDto): string {
  const parts = [ruleSentence(r)];
  const cover = coverageText(r.targetSummary);
  if (cover) parts.push(cover);
  if (r.status === "SCHEDULED") parts.push(`starts ${fmtDate(r.effectiveFrom)}`);
  return parts.join(" · ");
}

/** What the admin typed as the reason is the closest thing a rule has to a name. */
export function ruleLabel(r: Pick<SellingRestrictionListItemDto, "reason">): string {
  const t = (r.reason ?? "").trim();
  if (!t) return "Rule without a reason";
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/** "Vapes, Sample Pod, +10 more" from the summary's first three names; null when there are none. */
export function previewText(
  r: Pick<SellingRestrictionListItemDto, "targetSummary">,
): string | null {
  const s = r.targetSummary;
  if (!s || s.preview.length === 0) return null;
  const names = s.preview.map((p) => p.name);
  const rest = s.products + s.categories - names.length;
  return rest > 0 ? `${names.join(", ")}, +${rest} more` : names.join(", ");
}

export function chooserTitle(mode: "add" | "remove", n: number): string {
  return mode === "add"
    ? `Add ${subjectText(n)} to a rule`
    : `Remove ${subjectText(n)} from a rule`;
}

export function confirmTitle(mode: "add" | "remove", n: number, label: string): string {
  return mode === "add"
    ? `Add ${productsText(n)} to “${label}”?`
    : `Remove ${productsText(n)} from “${label}”?`;
}

export function confirmButton(mode: "add" | "remove", n: number): string {
  return mode === "add" ? `Add ${productsText(n)}` : `Remove ${productsText(n)}`;
}

export function addedTitle(added: number, alreadyIn: number, total: number): string {
  if (added === 0)
    return `Nothing changed. ${total === 1 ? "It was" : `All ${total} were`} already in it.`;
  return alreadyIn > 0 ? `${added} added · ${alreadyIn} already in it` : `${added} added`;
}

export function removedTitle(removed: number): string {
  return removed === 0 ? "Nothing changed. None of them were in it." : `${removed} removed`;
}

export const needsATargetText = (label: string) =>
  `This would leave “${label}” covering nothing. Lift the rule instead?`;
