import { z } from "zod";
import type { CreateSellingRestrictionRequest } from "@routeflow/types";

/**
 * The create-rule form's values, validation and wire request. Validation mirrors the API's
 * (create-restriction.dto.ts + the service): exactly one target, a STATE rule needs >= 1 state, the
 * end must be after the start, a reason is required — so the common mistakes are caught in the
 * form, in plain words, before a request is made.
 */
export interface RuleFormValues {
  targetKind: "CATEGORY" | "PRODUCT";
  categoryId: string;
  productId: string;
  jurisdiction: "FEDERAL" | "STATE";
  /** 2-letter USPS codes (from the shared US_STATES list). */
  states: string[];
  surface: "ALL" | "BUYER_PORTAL";
  /** `YYYY-MM-DD` from a date input; "" = starts now. */
  startsOn: string;
  /** `YYYY-MM-DD`; "" = no end date. */
  endsOn: string;
  reason: string;
}

export const emptyRuleForm: RuleFormValues = {
  targetKind: "CATEGORY",
  categoryId: "",
  productId: "",
  jurisdiction: "STATE",
  states: [],
  surface: "ALL",
  startsOn: "",
  endsOn: "",
  reason: "",
};

export const REASON_MAX = 500;

/** A date input's day as the start of that day in the admin's own timezone, as an ISO instant. */
export const dayToIso = (day: string): string => new Date(`${day}T00:00:00`).toISOString();

/**
 * The stored END of a rule for an "Ends on <day>" the admin typed. The engine's window is
 * [effectiveFrom, effectiveTo): the end is EXCLUSIVE, so a rule the admin means to cover all of
 * Dec 31 must be sent as the start of Jan 1 (local calendar arithmetic, so month/year/DST
 * boundaries are right). Sending the start of Dec 31 would free the banned product a whole day
 * early.
 */
export const dayEndToIso = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number);
  // setFullYear, not the Date(y, m, d) constructor: that one maps years 0-99 to 1900-1999, which
  // would skew the end from `dayToIso` (which parses the year as written).
  const end = new Date(2000, 0, 1);
  end.setFullYear(y, m - 1, d + 1);
  return end.toISOString();
};

export const ruleFormSchema = z
  .object({
    targetKind: z.enum(["CATEGORY", "PRODUCT"]),
    categoryId: z.string(),
    productId: z.string(),
    jurisdiction: z.enum(["FEDERAL", "STATE"]),
    states: z.array(z.string()),
    surface: z.enum(["ALL", "BUYER_PORTAL"]),
    startsOn: z.string(),
    endsOn: z.string(),
    reason: z
      .string()
      .trim()
      .min(1, "Add a reason")
      .max(REASON_MAX, "Keep the reason under 500 characters"),
  })
  .superRefine((v, ctx) => {
    if (v.targetKind === "CATEGORY" && !v.categoryId) {
      ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Pick a category" });
    }
    if (v.targetKind === "PRODUCT" && !v.productId) {
      ctx.addIssue({ code: "custom", path: ["productId"], message: "Pick a product" });
    }
    if (v.jurisdiction === "STATE" && v.states.length === 0) {
      ctx.addIssue({ code: "custom", path: ["states"], message: "Pick at least one state" });
    }
    if (v.endsOn) {
      // Compare the exclusive END bound: a same-day rule (start = end) is a valid one-day rule. A
      // blank start means "now" (the API's default), so an end day already past is refused here in
      // words about the field the admin actually filled in, not by a server error about a start
      // date they never entered.
      const endBound = new Date(dayEndToIso(v.endsOn)).getTime();
      if (v.startsOn && endBound <= new Date(dayToIso(v.startsOn)).getTime()) {
        ctx.addIssue({
          code: "custom",
          path: ["endsOn"],
          message: "The end date can't be before the start date",
        });
      } else if (!v.startsOn && endBound <= Date.now()) {
        ctx.addIssue({
          code: "custom",
          path: ["endsOn"],
          message: "The end date has already passed",
        });
      }
    }
  });

/** The API request for a VALID form: only the chosen target, no states on a federal rule. */
export function toCreateRequest(v: RuleFormValues): CreateSellingRestrictionRequest {
  return {
    ...(v.targetKind === "CATEGORY" ? { categoryId: v.categoryId } : { productId: v.productId }),
    jurisdiction: v.jurisdiction,
    ...(v.jurisdiction === "STATE" ? { states: [...new Set(v.states)] } : {}),
    surface: v.surface,
    ...(v.startsOn ? { effectiveFrom: dayToIso(v.startsOn) } : {}),
    ...(v.endsOn ? { effectiveTo: dayEndToIso(v.endsOn) } : {}),
    reason: v.reason.trim(),
  };
}
