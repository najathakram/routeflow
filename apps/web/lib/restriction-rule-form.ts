import { z } from "zod";
import {
  RULE_TARGETS_MAX_PER_RULE,
  type CreateSellingRestrictionRequest,
  type RuleEditRequest,
  type SellingRestrictionListItemDto,
} from "@routeflow/types";
import { lastDayInForce } from "./restriction-rules";
import { targetsToInput, type PickedTarget } from "./rule-targets";

/**
 * The create-rule form's values, validation and wire request. Validation mirrors the API's
 * (create-restriction.dto.ts + the service): at least one product or label (row 509), a STATE rule
 * needs >= 1 state, the end must be after the start, a reason is required — so the common mistakes
 * are caught in the form, in plain words, before a request is made.
 */
export interface RuleFormValues {
  /** Products and/or labels the rule covers (owner Q2: they may mix). Empty on an edit. */
  targets: PickedTarget[];
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
  targets: [],
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

/** The settings half of a rule (shared by create and edit); targets are validated by the create schema. */
const settingsShape = {
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
};

type SettingsValues = Pick<
  RuleFormValues,
  "jurisdiction" | "states" | "surface" | "startsOn" | "endsOn" | "reason"
>;

function checkSettings(v: SettingsValues, ctx: z.RefinementCtx) {
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
}

/** An edit's settings (everything but the targets). */
export const ruleSettingsSchema = z.object(settingsShape).superRefine(checkSettings);

export const ruleFormSchema = z
  .object({ ...settingsShape, targets: z.array(z.any()) })
  .superRefine((v, ctx) => {
    if (v.targets.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Pick at least one product or label",
      });
    } else if (v.targets.length > RULE_TARGETS_MAX_PER_RULE) {
      ctx.addIssue({
        code: "custom",
        path: ["targets"],
        message: `A rule can cover up to ${RULE_TARGETS_MAX_PER_RULE.toLocaleString("en-US")} products and labels. Split it into two rules.`,
      });
    }
    checkSettings(v, ctx);
  });

/** The API request for a VALID form: the picked targets, no states on a federal rule. */
export function toCreateRequest(v: RuleFormValues): CreateSellingRestrictionRequest {
  return {
    targets: targetsToInput(v.targets),
    jurisdiction: v.jurisdiction,
    ...(v.jurisdiction === "STATE" ? { states: [...new Set(v.states)] } : {}),
    surface: v.surface,
    ...(v.startsOn ? { effectiveFrom: dayToIso(v.startsOn) } : {}),
    ...(v.endsOn ? { effectiveTo: dayEndToIso(v.endsOn) } : {}),
    reason: v.reason.trim(),
  };
}

// ─── Edit in place (row 509 PR3) ─────────────────────────────────────────────────────────────────

type EditableRule = Pick<
  SellingRestrictionListItemDto,
  "jurisdiction" | "states" | "surface" | "effectiveFrom" | "effectiveTo" | "reason"
>;

/** A stored instant as the `YYYY-MM-DD` of that day in the admin's own timezone. */
const isoToDay = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The edit form's starting values: the rule's own settings, the end as the LAST day in force. */
export function ruleToFormValues(rule: EditableRule): RuleFormValues {
  return {
    targets: [],
    jurisdiction: rule.jurisdiction,
    states: [...rule.states],
    surface: rule.surface,
    startsOn: isoToDay(rule.effectiveFrom),
    endsOn: rule.effectiveTo ? isoToDay(lastDayInForce(rule.effectiveTo)) : "",
    reason: rule.reason,
  };
}

/**
 * The edit request for a VALID form. A window day the admin did not touch goes back as the stored
 * instant (an API-made rule ending mid-afternoon must not be rounded to midnight by a round trip);
 * a changed day converts exactly like create; a cleared end is an explicit `null` (open-ended).
 */
export function toEditRequest(
  v: RuleFormValues,
  original: EditableRule,
  note?: string,
): RuleEditRequest {
  const startUnchanged = v.startsOn === isoToDay(original.effectiveFrom);
  const origEndDay = original.effectiveTo ? isoToDay(lastDayInForce(original.effectiveTo)) : "";
  const endUnchanged = v.endsOn === origEndDay;
  const trimmedNote = note?.trim();
  return {
    jurisdiction: v.jurisdiction,
    ...(v.jurisdiction === "STATE" ? { states: [...new Set(v.states)] } : {}),
    surface: v.surface,
    ...(startUnchanged
      ? { effectiveFrom: original.effectiveFrom }
      : v.startsOn
        ? { effectiveFrom: dayToIso(v.startsOn) }
        : {}),
    effectiveTo: endUnchanged ? original.effectiveTo : v.endsOn ? dayEndToIso(v.endsOn) : null,
    reason: v.reason.trim(),
    ...(trimmedNote ? { note: trimmedNote } : {}),
  };
}
