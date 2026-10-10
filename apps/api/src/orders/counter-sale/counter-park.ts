import { COUNTER_PARK_LABEL_MAX } from "@routeflow/pricing";
import type { LockFamily } from "../../common/db-locks";

/** Advisory-lock family of the parked-cart cap: keyed on the tenant id (one lock covers the per-register and tenant-wide caps). */
export const COUNTER_PARK_LOCK_FAMILY = "counter-park" satisfies LockFamily;

/** Rows the hourly sweep deletes per statement. */
export const COUNTER_PARK_SWEEP_BATCH = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route `:id` that cannot be a UUID names no row: the answer is the same PARK_TAKEN 404, with no query run. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** `HH:MM` (24 h) of `at` in `zone`; UTC when the zone is missing or unknown. */
export function localHm(at: Date, zone: string | null): string {
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  try {
    return fmt(zone || "UTC");
  } catch {
    return fmt("UTC");
  }
}

/** The label a park without one gets: the customer's business name, else "Walk-in · HH:MM". Capped, never empty. */
export function defaultParkLabel(customerName: string | undefined, hm: string): string {
  const name = customerName?.trim();
  return (name ? name : `Walk-in · ${hm}`).slice(0, COUNTER_PARK_LABEL_MAX);
}

/** A raw row as the parked-cart statements return it. */
export interface ParkedRow {
  id: string;
  label: string;
  registerKey?: string;
  createdAt: Date | string;
  expiresAt?: Date | string;
  payload?: unknown;
  lineCount?: number | null;
  customerName?: string | null;
}

export const iso = (d: Date | string): string => new Date(d).toISOString();

/** The `lines` length of a stored payload (0 when it has none): a list row never carries the payload itself. */
export function lineCountOf(payload: unknown): number {
  const lines = (payload as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? lines.length : 0;
}

/** The customer's business name of a stored payload, when it has one. */
export function customerNameOf(payload: unknown): string | undefined {
  const name = (payload as { customer?: { businessName?: unknown } | null } | null)?.customer
    ?.businessName;
  return typeof name === "string" && name ? name : undefined;
}
