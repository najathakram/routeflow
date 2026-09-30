/**
 * Mobile settings parity with web Settings PR-1 (#2787): pure logic for the route-defaults card, the
 * low-stock digest switch and the selling-restrictions entry. Same endpoints/DTOs as web
 * (`/settings/route`, `/users/me/preferences`, `/settings/restrictions`); only the UI differs.
 *
 * The route-defaults rules MIRROR apps/web `RouteDefaultsCard` (vectors copied into the test).
 * TODO(after Settings PR-1 #2792 lands): move validate/build into packages/types so the mirror dies.
 */
import { PREF } from "@routeflow/types";
import type { PreferencePatch, RestrictionsSettingsDto } from "@routeflow/types";

export type RouteDefaultsForm = {
  service: string;
  start: string;
  speed: string;
  lat: string;
  lng: string;
};
export type RouteDefaultsErrors = Partial<Record<keyof RouteDefaultsForm, string>>;

type RouteDefaultsData = {
  serviceTimeMinutes: number;
  defaultStartTime: string;
  averageSpeedKmh: number;
  depotLat?: number | null;
  depotLng?: number | null;
  depotAddress?: string | null;
};

const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

export function validateRouteDefaults(f: RouteDefaultsForm): RouteDefaultsErrors {
  const e: RouteDefaultsErrors = {};
  const svc = numOrNull(f.service);
  if (svc === null || !Number.isInteger(svc) || svc < 0 || svc > 120)
    e.service = "Enter whole minutes between 0 and 120.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.start)) e.start = "Use HH:MM, 24-hour (e.g. 08:00).";
  const spd = numOrNull(f.speed);
  if (spd === null || !Number.isFinite(spd) || spd < 1 || spd > 200)
    e.speed = "Enter a speed between 1 and 200 km/h.";
  const lat = numOrNull(f.lat);
  const lng = numOrNull(f.lng);
  if ((lat === null) !== (lng === null)) {
    const msg = "Set both latitude and longitude, or leave both blank.";
    if (lat === null) e.lat = msg;
    else e.lng = msg;
  }
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90))
    e.lat = "Latitude must be between -90 and 90.";
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))
    e.lng = "Longitude must be between -180 and 180.";
  return e;
}

/** PATCH /settings/route body. Both depot fields blank = keep the saved depot (keys omitted). */
export function buildRoutePatch(f: RouteDefaultsForm) {
  const lat = numOrNull(f.lat);
  const lng = numOrNull(f.lng);
  return {
    serviceTimeMinutes: Number(f.service),
    defaultStartTime: f.start,
    averageSpeedKmh: Number(f.speed),
    ...(lat !== null && lng !== null ? { depotLat: lat, depotLng: lng } : {}),
  };
}

/** Depot inputs stay blank: GET may return a cached geocode of the business address. */
export function routeDefaultsFormFrom(d: RouteDefaultsData): RouteDefaultsForm {
  return {
    service: String(d.serviceTimeMinutes),
    start: d.defaultStartTime,
    speed: String(d.averageSpeedKmh),
    lat: "",
    lng: "",
  };
}

/** Routing uses the saved coordinates first; the address is only the answer when none is saved. */
export function depotContext(
  d?: Pick<RouteDefaultsData, "depotLat" | "depotLng" | "depotAddress"> | null,
): string {
  if (d?.depotLat != null && d?.depotLng != null)
    return `Routes currently start from ${d.depotLat}, ${d.depotLng}.`;
  if (d?.depotAddress) return `Routes currently start from ${d.depotAddress}.`;
  return "No depot is set yet.";
}

/** Opt-out: absent means ON; only the string "false" turns it off. */
export function isDigestOn(prefs?: Record<string, string> | null): boolean {
  return prefs?.[PREF.lowStockDigestEnabled] !== "false";
}

export function digestPatch(on: boolean): PreferencePatch {
  return { [PREF.lowStockDigestEnabled]: on ? "true" : "false" };
}

/** The digest goes to TENANT_ADMINs only, so only they see the switch. */
export function showDigestToggle(role?: string | null): boolean {
  return role === "TENANT_ADMIN";
}

export function canEditSellingRules(role?: string | null): boolean {
  return role === "TENANT_ADMIN";
}

export function restrictionsSummary(dto?: RestrictionsSettingsDto | null): string {
  if (!dto) return "";
  if (!dto.enabled) return "Off — restricted products can be sold to any customer.";
  const first = dto.governingAddress === "SHIPPING_FIRST" ? "shipping" : "billing";
  return `On — the ${first} address decides first.`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Plain-language reason for the 409 SELLING_RESTRICTIONS_NOT_READY (never the raw code). */
export function notReadyMessage(err: unknown): string | null {
  const res = (err as { response?: { status?: number; data?: any } })?.response;
  if (res?.status !== 409 || res.data?.code !== "SELLING_RESTRICTIONS_NOT_READY") return null;
  const r = res.data.readiness ?? {};
  const parts: string[] = [];
  if (r.truncated)
    parts.push("this workspace is too large to check in one pass; ask support before enabling");
  if (r.customersWithoutAddress > 0)
    parts.push(
      plural(
        r.customersWithoutAddress,
        "customer without an address",
        "customers without an address",
      ),
    );
  if (r.customersAmbiguousNoDefault > 0)
    parts.push(
      plural(
        r.customersAmbiguousNoDefault,
        "customer with no default address",
        "customers with no default address",
      ),
    );
  if (r.addressesMissingStateCode > 0)
    parts.push(
      plural(r.addressesMissingStateCode, "address missing a state", "addresses missing a state"),
    );
  if (r.addressesNeedingReview > 0)
    parts.push(
      plural(r.addressesNeedingReview, "address needing review", "addresses needing review"),
    );
  return parts.length
    ? `Fix your customer data before turning this on: ${parts.join(", ")}.`
    : "Your customer data isn't ready for selling restrictions yet.";
}
