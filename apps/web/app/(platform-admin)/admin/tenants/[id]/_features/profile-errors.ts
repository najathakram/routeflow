import { API_ERROR_CODES, type BusinessProfileBillingFailedAddon } from "@routeflow/types";
import { FLEET_ENABLERS, keyLabel } from "./setup-copy";

/**
 * Fixed copy for a failed business-profile call, chosen by the API's error CODE (the B986 rule: no raw server text on
 * screen). The server `message` is never read. Feature KEYS in the body become fixed labels (`keyLabel`); a key this
 * build does not know becomes a generic phrase, never the raw key.
 */

interface ErrorBody {
  code?: unknown;
  missing?: unknown;
  alreadyDisabled?: unknown;
  failedStep?: { step?: unknown; key?: unknown } | null;
  /** ROW c: per-add-on outcomes (`BusinessProfileBillingFailedAddon[]`); absent from an older server. */
  addons?: unknown;
}

const KNOWN_KEY = (key: unknown): key is string =>
  typeof key === "string" && keyLabel(key) !== "a feature";

/** "A", "A and B", "A, B and C". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Labels for the keys we know; each unknown key is counted as "another add-on" so a partial apply is never hidden. */
function addonList(keys: unknown): string {
  if (!Array.isArray(keys)) return "";
  const labels = keys.map((k) => (KNOWN_KEY(k) ? keyLabel(k) : "another add-on"));
  return joinList(labels);
}

function stepPhrase(step: unknown, key: unknown): string {
  switch (step) {
    case "grant":
      return `turning on ${keyLabel(key)}`;
    case "deny":
      return `turning off ${keyLabel(key)}`;
    case "mode":
      return `saving ${KNOWN_KEY(key) ? keyLabel(key) : "a setting"}`;
    case "audit":
      return "recording the change";
    default:
      return "a later step";
  }
}

const BILLING_STOPPED_NO_BODY =
  "The business profile could not be applied because billing could not be stopped. Check the tenant's setup, then try again.";

/** The well-formed entries of the 503 body's `addons` list; anything else is dropped (never printed). */
function readAddons(raw: unknown): BusinessProfileBillingFailedAddon[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is BusinessProfileBillingFailedAddon =>
      !!a &&
      typeof a === "object" &&
      typeof (a as { key?: unknown }).key === "string" &&
      typeof (a as { wasComp?: unknown }).wasComp === "boolean" &&
      typeof (a as { billingStopped?: unknown }).billingStopped === "boolean" &&
      typeof (a as { switchedOff?: unknown }).switchedOff === "boolean",
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One add-on, one sentence: a comp has no billing, so it only ever says "switched off". */
function addonSentence(a: BusinessProfileBillingFailedAddon): string {
  const label = KNOWN_KEY(a.key) ? keyLabel(a.key) : "another add-on";
  if (a.switchedOff)
    return a.wasComp ? `${capitalise(label)} switched off.` : `Billing stopped for ${label}.`;
  return a.wasComp
    ? `${capitalise(label)} could not be switched off; it's still on.`
    : `Billing for ${label} could not be stopped; it's still on.`;
}

/** The per-add-on message: the ones still on first, then the switched-off ones, then what to do next. */
function billingFailedAddonsCopy(
  body: ErrorBody,
  addons: BusinessProfileBillingFailedAddon[],
): string {
  const ordered = [...addons.filter((a) => !a.switchedOff), ...addons.filter((a) => a.switchedOff)];
  const anyDone = ordered.some((a) => a.switchedOff);
  const step = body.failedStep?.step;
  const head = anyDone
    ? "The business profile was only partly applied."
    : "The business profile was not applied.";
  const tail =
    step && step !== "billing"
      ? `Then ${stepPhrase(step, body.failedStep?.key)} failed. Try again to finish.`
      : anyDone
        ? "Try again to finish."
        : "Nothing was changed. Try again.";
  return [head, ...ordered.map(addonSentence), tail].join(" ");
}

/** BUSINESS_PROFILE_BILLING_FAILED: say exactly what was already switched off with billing stopped, and what failed. */
function billingFailedCopy(body: ErrorBody): string {
  const addons = readAddons(body.addons);
  if (addons.length > 0) return billingFailedAddonsCopy(body, addons);
  const done = addonList(body.alreadyDisabled);
  const step = body.failedStep?.step;
  const key = body.failedStep?.key;
  if (step === "billing") {
    if (!done) {
      return `The business profile was not applied: billing for ${keyLabel(key)} could not be stopped. Nothing was changed. Try again.`;
    }
    return `The business profile was only partly applied. Billing was already stopped for ${done}, but not for ${keyLabel(key)}. Try again to finish.`;
  }
  if (done && step) {
    return `The business profile was only partly applied. Billing was already stopped for ${done}, then ${stepPhrase(step, key)} failed. Try again to finish.`;
  }
  if (done) {
    return `The business profile was only partly applied. Billing was already stopped for ${done}. Try again to finish.`;
  }
  return BILLING_STOPPED_NO_BODY;
}

export function profileErrorCopy(err: unknown, fallback: string): string {
  const e = err as { response?: { status?: number; data?: ErrorBody } } | null | undefined;
  const body: ErrorBody = e?.response?.data ?? {};
  const status = e?.response?.status;

  switch (body.code) {
    case API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED:
      return billingFailedCopy(body);
    case API_ERROR_CODES.PROFILE_PLAN_CHANGED:
      return "This account changed since the preview. Review the updated changes below, then confirm again.";
    case API_ERROR_CODES.LOCK_UNAVAILABLE:
      return "This account's add-ons are being changed right now. Try again in a moment.";
    case API_ERROR_CODES.BUSINESS_PROFILE_UNKNOWN:
      return "That business profile does not exist.";
    case API_ERROR_CODES.BUSINESS_PROFILE_UNAVAILABLE:
      return "This business profile isn't available for this tenant.";
    case API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET: {
      const named = Array.isArray(body.missing)
        ? body.missing.filter((k): k is string =>
            (FLEET_ENABLERS as readonly string[]).includes(k as string),
          )
        : [];
      const labels = named.map((k) => keyLabel(k));
      return labels.length > 0
        ? `Delivery needs a fleet feature turned on first: ${labels.join(" or ")}. Any one is enough.`
        : "Delivery needs a fleet feature turned on first.";
    }
    case API_ERROR_CODES.FEATURE_MODE_REQUIRES:
      return KNOWN_KEY(body.missing)
        ? `This needs ${keyLabel(body.missing)} turned on first.`
        : "This needs a feature turned on first.";
    default:
      break;
  }
  if (status === 404) return "That tenant was not found.";
  if (status === 403) return "Only platform admins can change a business profile.";
  return fallback;
}

/**
 * True when a failed apply had already switched off (and stopped billing for) at least one add-on, so the tenant's
 * setup HAS changed and the screen behind the dialog must reload.
 */
export function profilePartlyApplied(err: unknown): boolean {
  const body = (err as { response?: { data?: ErrorBody } } | null | undefined)?.response?.data;
  return (
    body?.code === API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED &&
    Array.isArray(body.alreadyDisabled) &&
    body.alreadyDisabled.length > 0
  );
}

/** The plan changed under the admin (409 PROFILE_PLAN_CHANGED): the preview must be re-run before Confirm. */
export function profilePlanChanged(err: unknown): boolean {
  const body = (err as { response?: { data?: ErrorBody } } | null | undefined)?.response?.data;
  return body?.code === API_ERROR_CODES.PROFILE_PLAN_CHANGED;
}
