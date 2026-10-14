import {
  US_STATES,
  type RestrictionStatus,
  type SellingRestrictionListItemDto,
} from "@routeflow/types";
import { fmtDate } from "./formatting";

/** Pure display helpers for the rules list (plain language — never a raw enum or id). */

const STATE_NAME = new Map(US_STATES.map((s) => [s.code, s.name]));
export const stateName = (code: string): string => STATE_NAME.get(code) ?? code;

export const STATUS_FILTERS: ReadonlyArray<{ value: RestrictionStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "SCHEDULED", label: "Scheduled" },
  { value: "EXPIRED", label: "Expired" },
  { value: "LIFTED", label: "Lifted" },
];

export const STATUS_BADGE: Record<
  RestrictionStatus,
  { variant: "success" | "info" | "neutral" | "warning"; label: string }
> = {
  ACTIVE: { variant: "success", label: "Active" },
  SCHEDULED: { variant: "info", label: "Scheduled" },
  EXPIRED: { variant: "neutral", label: "Expired" },
  LIFTED: { variant: "warning", label: "Lifted" },
};

/** What the rule covers: a whole category or one product. */
export function ruleTarget(
  r: Pick<SellingRestrictionListItemDto, "categoryName" | "productName">,
): {
  name: string;
  kind: "Category" | "Product";
} {
  return r.productName
    ? { name: r.productName, kind: "Product" }
    : { name: r.categoryName ?? "Unknown item", kind: "Category" };
}

export function jurisdictionText(
  r: Pick<SellingRestrictionListItemDto, "jurisdiction" | "states">,
) {
  if (r.jurisdiction === "FEDERAL") return "Banned everywhere (federal)";
  return r.states.length ? "Banned in" : "Banned everywhere (no states listed)";
}

/**
 * The ONE wording for where a rule applies. Neutral on purpose: it says which channel the rule covers
 * and nothing about what staff can do (row 510 owns any staff sentence). Every surface that names a
 * channel (cards, detail, settings fields) goes through this.
 */
export const surfaceText = (s: SellingRestrictionListItemDto["surface"]) =>
  s === "BUYER_PORTAL" ? "Buyer portal only" : "All orders";

/**
 * The two admin-only sentences, said the same way on every surface (rules list and detail, the edit
 * dialog, the catalog chooser, the product page). A rule that hides products from every portal
 * customer is the account admin's to change; operators may still lift a state rule.
 */
export const ADMIN_ONLY_CHANGE_HINT =
  "Only an account admin can change a rule that hides products from every portal customer.";
/** The note under the disabled "Everywhere (federal)" choice for a viewer who isn't an account admin (SA copy). */
export const ADMIN_ONLY_FEDERAL_NOTE =
  "Only an account admin can make a rule apply everywhere (federal).";
export const ADMIN_ONLY_LIFT_HINT =
  "Only an account admin can lift a rule that hides products from every portal customer.";

/**
 * Can this viewer lift this rule (owner L5)? Operators may lift a STATE rule; a rule that applies
 * everywhere (FEDERAL) is the account admin's (TENANT_ADMIN or SUPER_ADMIN, as rule-lock.ts decides).
 * "none" = nothing to offer (not staff, or the rule is no longer in force).
 */
export function liftState(
  role: string | undefined,
  rule: Pick<SellingRestrictionListItemDto, "jurisdiction" | "status">,
): "enabled" | "admin-only" | "none" {
  if (rule.status !== "ACTIVE" && rule.status !== "SCHEDULED") return "none";
  if (role === "TENANT_ADMIN" || role === "SUPER_ADMIN") return "enabled";
  if (role !== "OPERATOR") return "none";
  return rule.jurisdiction === "FEDERAL" ? "admin-only" : "enabled";
}

/**
 * The window as an admin reads it. `effectiveTo` is EXCLUSIVE (the engine stops applying the rule AT
 * that instant), so a rule the admin ended "on Dec 31" is stored as the start of Jan 1; showing
 * that stored date would read one day late. Show the last day the rule is in force: the day
 * containing the final millisecond before the end. This is right for any stored end (an API rule
 * ending mid-afternoon still shows that same day).
 */
export const lastDayInForce = (effectiveTo: string): string => {
  const t = new Date(effectiveTo).getTime();
  // An unparseable end must not crash the page render (`toISOString` throws on NaN): hand it back
  // untouched and let `fmtDate` show its usual dash.
  return Number.isNaN(t) ? effectiveTo : new Date(t - 1).toISOString();
};

export function windowText(
  r: Pick<SellingRestrictionListItemDto, "effectiveFrom" | "effectiveTo">,
) {
  const from = fmtDate(r.effectiveFrom);
  return r.effectiveTo
    ? `${from} – ${fmtDate(lastDayInForce(r.effectiveTo))}`
    : `From ${from}, no end date`;
}

export function emptyText(filter: RestrictionStatus | "ALL"): {
  title: string;
  description: string;
} {
  if (filter === "ALL") {
    return {
      title: "No selling restrictions yet",
      description:
        "Rules you add here stop matching products from being sold where they are banned.",
    };
  }
  const label = STATUS_FILTERS.find((f) => f.value === filter)!.label.toLowerCase();
  return { title: `No ${label} rules`, description: "Try another filter to see the rest." };
}

/** One line for a rule's header: who it bans and where it applies ("Banned in Texas and California · All sales"). */
export function ruleSentence(
  r: Pick<SellingRestrictionListItemDto, "jurisdiction" | "states" | "surface">,
): string {
  let where: string;
  if (r.jurisdiction === "STATE" && r.states.length > 0) {
    const names = r.states.map(stateName);
    where =
      names.length > 4
        ? `Banned in ${names.length} states`
        : names.length === 1
          ? `Banned in ${names[0]}`
          : `Banned in ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  } else {
    where = jurisdictionText(r);
  }
  return `${where} · ${surfaceText(r.surface)}`;
}
