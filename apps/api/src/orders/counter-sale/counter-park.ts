import { COUNTER_PARK_LABEL_MAX, type ParkedPriceLine } from "@routeflow/pricing";
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
  /** The list's `"payload"->'lines'` (only its pricing inputs leave the service: {@link priceLinesOf}). */
  lines?: unknown;
  customerName?: string | null;
}

export const iso = (d: Date | string): string => new Date(d).toISOString();

/** The `lines` length of a stored payload (0 when it has none): a list row never carries the payload itself. */
export function lineCountOf(payload: unknown): number {
  const lines = (payload as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? lines.length : 0;
}

/**
 * Row 330e: the pricing inputs of a stored payload's lines (`unitPrice`, `qty`, and the box/piece split when set),
 * for the list's per-row total. The screen totals them with `cartTotals`, the same function its live cart uses; no
 * money is computed here. A line without a finite price and qty is dropped, so a row's total never shows NaN.
 */
export function priceLinesOf(payload: unknown): ParkedPriceLine[] {
  const lines = (payload as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines)) return [];
  const out: ParkedPriceLine[] = [];
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const r = l as Record<string, unknown>;
    const unitPrice = Number(r.unitPrice);
    const qty = Number(r.qty);
    if (
      r.unitPrice == null ||
      r.qty == null ||
      !Number.isFinite(unitPrice) ||
      !Number.isFinite(qty)
    )
      continue;
    const line: ParkedPriceLine = { unitPrice, qty };
    for (const k of ["boxes", "pieces", "unitsPerBox"] as const) {
      const v = r[k];
      if (v != null && Number.isFinite(Number(v))) line[k] = Number(v);
    }
    out.push(line);
  }
  return out;
}

/**
 * R7b 2.1: the first few line names (+ qty) of a stored payload and its named-line count, for the list row. No query
 * change: the list already reads `payload->'lines'`. A non-array / nameless payload yields `{}`.
 */
export function itemSummaryOf(payload: unknown): {
  items?: Array<{ name: string; qty: number }>;
  itemCount?: number;
} {
  const lines = (payload as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines)) return {};
  const named: Array<{ name: string; qty: number }> = [];
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const r = l as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const qty = Number(r.qty);
    if (name) named.push({ name, qty: Number.isFinite(qty) ? qty : 0 });
  }
  if (named.length === 0) return {};
  return { items: named.slice(0, 3), itemCount: named.length };
}

/** The customer's business name of a stored payload, when it has one. */
export function customerNameOf(payload: unknown): string | undefined {
  const name = (payload as { customer?: { businessName?: unknown } | null } | null)?.customer
    ?.businessName;
  return typeof name === "string" && name ? name : undefined;
}
