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
    if (v.endsOn && v.startsOn && dayToIso(v.endsOn) <= dayToIso(v.startsOn)) {
      ctx.addIssue({
        code: "custom",
        path: ["endsOn"],
        message: "The end date must be after the start date",
      });
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
    ...(v.endsOn ? { effectiveTo: dayToIso(v.endsOn) } : {}),
    reason: v.reason.trim(),
  };
}
