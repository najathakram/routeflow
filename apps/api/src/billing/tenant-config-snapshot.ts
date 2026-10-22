/**
 * Entitlement config that survives downgrade -> re-upgrade (Lane B A2; owner ruling 2026-09-18;
 * spec: SPEC-entitlement-snapshot-restore.md). PURE functions only — no Prisma, no clock, no I/O —
 * so every rule below is unit-testable and `TenantConfigSnapshotService` stays a thin shell:
 *
 *  - `buildSnapshotPayload` is the ONLY writer of `TenantFeatureConfigSnapshot.payload`.
 *  - `planRestore` is the ONLY reader of it (the one place that decides what a restore does).
 *
 * The rules, in the spec's words:
 *  - a snapshot captures every `TenantFeatureConfig` row + every ACTIVE `TenantFeatureOverride`;
 *  - restore is AS-WAS: it recreates/updates an entry to the snapshot's value;
 *  - restore never overwrites a value the tenant changed AFTER the downgrade (the row's
 *    `updatedAt` is newer than `takenAt` — newer wins and is reported);
 *  - restore skips (and reports) an entry the platform no longer has: a feature no longer in the
 *    registry, a mode the feature no longer offers, an override that has since expired, an entry
 *    the NEW plan does not allow (`planAllows`, supplied by the plan-change wiring);
 *  - restore is idempotent: a second run over the same state changes nothing;
 *  - an override is never resurrected over something an admin did after the downgrade: any row for
 *    that feature created or revoked AFTER `takenAt`, or ANY still-unrevoked row (live or expired —
 *    it occupies the partial unique index `(tenantId, featureKey) WHERE revokedAt IS NULL`), keeps
 *    the current state and is reported.
 *
 * KNOWN LIMITATION: a config row DELETED after the downgrade has no tombstone, so restore cannot
 * tell "lost" from "deliberately reset" and recreates it. Closing that needs a deletion record
 * (or an audit lookup) — raised with the lead, not guessed at here.
 */
import type { ConfigSnapshotHeld, ConfigSnapshotSkipReason } from "@routeflow/types";
import { featureDefByKey } from "./feature-registry";
import { applyAddonOverrides, fleetHeldIn } from "./fulfilment-capability";

export const SNAPSHOT_PAYLOAD_VERSION = 1 as const;

export interface SnapshotConfigEntry {
  featureKey: string;
  mode: string;
  settings: unknown;
  reason: string;
  updatedById: string | null;
}

export interface SnapshotOverrideEntry {
  featureKey: string;
  effect: "GRANT" | "DENY";
  kind: string;
  reason: string;
  expiresAt: string | null;
  createdById: string | null;
}

export interface SnapshotPayload {
  version: typeof SNAPSHOT_PAYLOAD_VERSION;
  configs: SnapshotConfigEntry[];
  overrides: SnapshotOverrideEntry[];
}

/** The subset of a `TenantFeatureConfig` row the snapshot reads. */
export interface ConfigRow {
  id: string;
  featureKey: string;
  mode: string;
  settings: unknown;
  reason: string;
  updatedById: string | null;
  updatedAt: Date;
}

/** The subset of a `TenantFeatureOverride` row the snapshot reads. */
export interface OverrideRow {
  id: string;
  featureKey: string;
  effect: "GRANT" | "DENY";
  kind: string;
  reason: string;
  expiresAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

const isActive = (o: OverrideRow, now: Date): boolean =>
  o.revokedAt === null && (o.expiresAt === null || o.expiresAt > now);

/** Deterministic order so two snapshots of the same state serialise identically. */
const byKey = <T extends { featureKey: string }>(a: T, b: T): number =>
  a.featureKey < b.featureKey ? -1 : a.featureKey > b.featureKey ? 1 : 0;

export function buildSnapshotPayload(
  configs: readonly ConfigRow[],
  overrides: readonly OverrideRow[],
  now: Date,
): SnapshotPayload {
  return {
    version: SNAPSHOT_PAYLOAD_VERSION,
    configs: configs
      .map((c) => ({
        featureKey: c.featureKey,
        mode: c.mode,
        settings: c.settings ?? null,
        reason: c.reason,
        updatedById: c.updatedById,
      }))
      .sort(byKey),
    overrides: overrides
      .filter((o) => isActive(o, now))
      .map((o) => ({
        featureKey: o.featureKey,
        effect: o.effect,
        kind: o.kind,
        reason: o.reason,
        expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null,
        createdById: o.createdById,
      }))
      .sort(byKey),
  };
}

export interface SkippedEntry {
  featureKey: string;
  /** The shared wire union (`@routeflow/types`) — never a second copy; `config-snapshot-wire-parity` pins it. */
  reason: ConfigSnapshotSkipReason;
}

export type HeldEntry = ConfigSnapshotHeld;

/**
 * Validates a stored payload before it is trusted. Returns null for anything that is not a
 * version-1 document, so a malformed/future-version row can never throw inside the caller's
 * plan-change transaction (which would block the upgrade) or be silently mis-read.
 */
export function parseSnapshotPayload(raw: unknown): SnapshotPayload | null {
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Partial<SnapshotPayload>;
  if (p.version !== SNAPSHOT_PAYLOAD_VERSION) return null;
  if (!Array.isArray(p.configs) || !Array.isArray(p.overrides)) return null;
  return p as SnapshotPayload;
}

export interface RestorePlan {
  configs: {
    create: SnapshotConfigEntry[];
    update: { id: string; entry: SnapshotConfigEntry }[];
    unchanged: string[];
    /** The tenant changed this AFTER the downgrade — the current value is kept. */
    keptNewer: string[];
    skipped: SkippedEntry[];
  };
  overrides: {
    create: SnapshotOverrideEntry[];
    unchanged: string[];
    /** A live override for this key already exists with a different effect — never overwritten. */
    keptNewer: string[];
    skipped: SkippedEntry[];
  };
}

export interface RestoreReport {
  restored: number;
  skipped: number;
  keptNewer: number;
  unchanged: number;
}

/** Stable structural equality for the JSON `settings` objects (key order must not matter). */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function planRestore(
  payload: SnapshotPayload,
  current: { configs: readonly ConfigRow[]; overrides: readonly OverrideRow[] },
  takenAt: Date,
  now: Date,
  /** Does the plan being restored TO allow this feature? Default: yes (the wiring supplies it). */
  planAllows: (featureKey: string) => boolean = () => true,
): RestorePlan {
  const plan: RestorePlan = {
    configs: { create: [], update: [], unchanged: [], keptNewer: [], skipped: [] },
    overrides: { create: [], unchanged: [], keptNewer: [], skipped: [] },
  };

  const currentConfig = new Map(current.configs.map((c) => [c.featureKey, c]));
  for (const entry of payload.configs) {
    const def = featureDefByKey(entry.featureKey);
    if (!def) {
      plan.configs.skipped.push({ featureKey: entry.featureKey, reason: "UNKNOWN_FEATURE" });
      continue;
    }
    if (!def.config || !Object.hasOwn(def.config.modes, entry.mode)) {
      plan.configs.skipped.push({ featureKey: entry.featureKey, reason: "MODE_NOT_OFFERED" });
      continue;
    }
    if (!planAllows(entry.featureKey)) {
      plan.configs.skipped.push({ featureKey: entry.featureKey, reason: "PLAN_NOT_ALLOWED" });
      continue;
    }
    const row = currentConfig.get(entry.featureKey);
    if (!row) {
      plan.configs.create.push(entry);
    } else if (row.mode === entry.mode && canonical(row.settings) === canonical(entry.settings)) {
      plan.configs.unchanged.push(entry.featureKey);
    } else if (row.updatedAt > takenAt) {
      plan.configs.keptNewer.push(entry.featureKey);
    } else {
      plan.configs.update.push({ id: row.id, entry });
    }
  }

  const byFeature = new Map<string, OverrideRow[]>();
  for (const o of current.overrides)
    byFeature.set(o.featureKey, [...(byFeature.get(o.featureKey) ?? []), o]);
  for (const entry of payload.overrides) {
    if (!featureDefByKey(entry.featureKey)) {
      plan.overrides.skipped.push({ featureKey: entry.featureKey, reason: "UNKNOWN_FEATURE" });
      continue;
    }
    if (entry.expiresAt !== null && new Date(entry.expiresAt) <= now) {
      plan.overrides.skipped.push({ featureKey: entry.featureKey, reason: "EXPIRED" });
      continue;
    }
    if (!planAllows(entry.featureKey)) {
      plan.overrides.skipped.push({ featureKey: entry.featureKey, reason: "PLAN_NOT_ALLOWED" });
      continue;
    }
    const rows = byFeature.get(entry.featureKey) ?? [];
    const live = rows.find((o) => isActive(o, now));
    if (live && live.effect === entry.effect && live.createdAt <= takenAt) {
      plan.overrides.unchanged.push(entry.featureKey);
      continue;
    }
    // Anything an admin did AFTER the downgrade wins: a row created, or revoked, since takenAt —
    // and any still-unrevoked row (live OR expired) already occupies the partial unique slot.
    const touchedAfter = rows.some(
      (o) =>
        o.createdAt > takenAt ||
        (o.revokedAt !== null && o.revokedAt > takenAt) ||
        o.revokedAt === null,
    );
    if (live && live.effect === entry.effect) plan.overrides.unchanged.push(entry.featureKey);
    else if (touchedAfter) plan.overrides.keptNewer.push(entry.featureKey);
    else plan.overrides.create.push(entry);
  }
  return plan;
}

export function summarizeRestore(plan: RestorePlan): RestoreReport {
  return {
    restored:
      plan.configs.create.length + plan.configs.update.length + plan.overrides.create.length,
    skipped: plan.configs.skipped.length + plan.overrides.skipped.length,
    keptNewer: plan.configs.keptNewer.length + plan.overrides.keptNewer.length,
    unchanged: plan.configs.unchanged.length + plan.overrides.unchanged.length,
  };
}

/** The registry key of the delivery method — the one config row a restore can HOLD (BO-13). */
export const FULFILMENT_MODEL_KEY = "fulfilment_model";

/**
 * BO-13: move ONE config entry out of `create`/`update` into `skipped` with `reason` — a pure transform
 * (the input plan is never mutated) applied AFTER `planRestore`, so preview and apply hold the same row
 * by construction. `unchanged` / `keptNewer` / already-`skipped` entries are left alone, and a key that is
 * not being written returns the plan untouched.
 */
export function holdConfigEntry(
  plan: RestorePlan,
  featureKey: string,
  reason: SkippedEntry["reason"],
): RestorePlan {
  const writing =
    plan.configs.create.some((e) => e.featureKey === featureKey) ||
    plan.configs.update.some((u) => u.entry.featureKey === featureKey);
  if (!writing) return plan;
  return {
    ...plan,
    configs: {
      ...plan.configs,
      create: plan.configs.create.filter((e) => e.featureKey !== featureKey),
      update: plan.configs.update.filter((u) => u.entry.featureKey !== featureKey),
      skipped: [...plan.configs.skipped, { featureKey, reason }],
    },
  };
}

/**
 * Row 640: move ONE to-be-created override out of `overrides.create` into `overrides.skipped` with `reason`
 * (pure; the input plan is never mutated). Applied AFTER `planRestore` by the same guarded step as the
 * delivery-method hold, so preview and apply hold the same override by construction.
 */
export function holdOverrideEntry(
  plan: RestorePlan,
  featureKey: string,
  reason: SkippedEntry["reason"],
): RestorePlan {
  if (!plan.overrides.create.some((e) => e.featureKey === featureKey)) return plan;
  return {
    ...plan,
    overrides: {
      ...plan.overrides,
      create: plan.overrides.create.filter((e) => e.featureKey !== featureKey),
      skipped: [...plan.overrides.skipped, { featureKey, reason }],
    },
  };
}

/**
 * BO-13: does the tenant hold a fleet module (Routes / Order delivery) AFTER this restore's own
 * override writes? Same rule as `isFleetHeld` (add-on rows, an override absolute: GRANT adds, DENY
 * removes), but over the tx-read rows plus the overrides this plan is about to create, so the answer is
 * the END state the restore would leave — not the saved state `FeatureConfigService.set` judges.
 */
export function fleetHeldAfterRestore(
  plan: RestorePlan,
  current: {
    overrides: readonly OverrideRow[];
    activeAddonKeys: Iterable<string>;
    /** Add-on keys the SAME transaction activates AFTER the restore (a checkout's `desiredNow`): held at commit. */
    pendingAddonKeys?: Iterable<string>;
  },
  now: Date,
): boolean {
  const effects: [string, "GRANT" | "DENY"][] = [
    ...current.overrides
      .filter((o) => isActive(o, now))
      .map((o): [string, "GRANT" | "DENY"] => [o.featureKey, o.effect]),
    ...plan.overrides.create.map((e): [string, "GRANT" | "DENY"] => [e.featureKey, e.effect]),
  ];
  const rows = [...current.activeAddonKeys, ...(current.pendingAddonKeys ?? [])];
  return fleetHeldIn(applyAddonOverrides(rows, effects));
}
