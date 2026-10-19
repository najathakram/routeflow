import type { Prisma } from "@prisma/client";
import type { BillingEventService } from "./billing-event.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

/**
 * SA-788 (a) - the ONE writer of `TenantAddon`, and one record per change.
 *
 * A `TenantAddon` row IS the tenant's entitlement, so every change to it must leave a trace. The MRR ledger
 * (`emitAddonDelta`) writes nothing for a $0 or comp change and nothing for a non-paying tenant, and a few writers
 * never called it at all, so the 10-12 deactivations went unseen. Every create, and every update that changes
 * `active`, `priceSnapshot`, `isComp` or `quantity`, now writes ONE `addon.state_changed` BillingEvent in the
 * writer's own transaction, ALWAYS (a $0 row, a comp, a non-paying tenant, a test class). The event carries
 * `amountDelta: null`, so it is never part of MRR; the MRR events (`addon.enabled` / `addon.disabled`) are untouched.
 *
 * `actor` is a REQUIRED parameter: a caller cannot write a row without saying who acted and from which of a
 * closed list of call sites (`AddonChangeSource`, one value per site). `tenant-addon-writer.pin.spec.ts` (P3)
 * fails the build for any `tenantAddon.<write>` outside this file.
 *
 * Lock order is the house order: the caller already holds the Tenant row lock; each row is then locked
 * `FOR UPDATE` here before it is read and written.
 */

/** One value per call site (P3 pins the count at 15, so a new writer is a conscious edit). */
export const ADDON_CHANGE_SOURCES = [
  "tenant.enable",
  "tenant.disable",
  "admin.enable",
  "admin.comp",
  "admin.uncomp",
  "admin.disable",
  "subscribe.pick",
  "subscribe.drop",
  "checkout.adopt",
  "plan.stop_billing",
  "plan.reprice",
  "plan_change.revert",
  "manual_activation.price",
  "lock.cancel_clear_item",
  "profile.apply",
] as const;
export type AddonChangeSource = (typeof ADDON_CHANGE_SOURCES)[number];

export type AddonActorKind = "TENANT_USER" | "PLATFORM_ADMIN" | "SYSTEM";

/** Who acted and from where. Required on every write. */
export interface AddonActor {
  kind: AddonActorKind;
  id: string | null;
  source: AddonChangeSource;
}

/** The fields whose change is a record of its own. */
export const TRACKED_ADDON_FIELDS = ["active", "priceSnapshot", "isComp", "quantity"] as const;
/** Fields that ride in `changes` when they changed, but never trigger a record alone. */
export const RIDER_ADDON_FIELDS = ["stripeItemId", "stripePriceId", "sku"] as const;

type Field = (typeof TRACKED_ADDON_FIELDS)[number] | (typeof RIDER_ADDON_FIELDS)[number];
type Snapshot = Partial<Record<Field, unknown>> & {
  id: string;
  tenantId: string;
  addonKey: string;
  sku?: string | null;
};

/** One field as a JSON-safe scalar (a Decimal price becomes a number; null stays null). */
function scalar(field: Field, value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (field === "priceSnapshot") return Number(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  return Number(value);
}

/** Per-field `[before, after]` for every tracked or rider field that differs (all non-null fields on a create). */
export function addonChanges(
  before: Snapshot | null,
  after: Snapshot,
): Record<string, [string | number | boolean | null, string | number | boolean | null]> {
  const out: Record<string, [string | number | boolean | null, string | number | boolean | null]> =
    {};
  for (const field of [...TRACKED_ADDON_FIELDS, ...RIDER_ADDON_FIELDS] as Field[]) {
    const b = before ? scalar(field, before[field]) : null;
    const a = scalar(field, after[field]);
    if (b !== a) out[field] = [b, a];
  }
  return out;
}

const triggers = (changes: Record<string, unknown>) =>
  TRACKED_ADDON_FIELDS.some((f) => f in changes);

async function record(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  before: Snapshot | null,
  after: Snapshot,
  actor: AddonActor,
  isCreate: boolean,
): Promise<void> {
  const changes = addonChanges(before, after);
  // Two AUTOMATIC pointer-only writes are still recorded (the audit exists to see what no person did): the
  // compensating revert pointer of a failed plan change, and the cancellation lock clearing dead Stripe items.
  const always =
    isCreate || actor.source === "plan_change.revert" || actor.source === "lock.cancel_clear_item";
  if (!always && !triggers(changes)) return;
  await events.emit(
    after.tenantId,
    BILLING_EVENTS.ADDON_STATE_CHANGED,
    {
      rowId: after.id,
      addonKey: after.addonKey,
      sku: (after.sku ?? null) as string | null,
      changes,
      actor: { kind: actor.kind, id: actor.id },
      source: actor.source,
    } as Prisma.InputJsonObject,
    { amountDelta: null, actorId: actor.kind === "SYSTEM" ? null : actor.id, tx },
  );
}

async function lockRow(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "TenantAddon" WHERE id = ${id} FOR UPDATE`;
}

/** Create a row and record it. */
export async function createAddonRowTx(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  a: { data: Prisma.TenantAddonUncheckedCreateInput; actor: AddonActor },
) {
  const row = await tx.tenantAddon.create({ data: a.data });
  await record(tx, events, null, row as unknown as Snapshot, a.actor, true);
  return row;
}

/** Update one row (locked `FOR UPDATE`, read first) and record the change. */
export async function updateAddonRowTx(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  a: { id: string; data: Prisma.TenantAddonUncheckedUpdateInput; actor: AddonActor },
) {
  await lockRow(tx, a.id);
  const before = (await tx.tenantAddon.findUnique({ where: { id: a.id } })) as Snapshot | null;
  const row = await tx.tenantAddon.update({ where: { id: a.id }, data: a.data });
  await record(tx, events, before, row as unknown as Snapshot, a.actor, false);
  return row;
}

/**
 * Update the row keyed (tenantId, addonKey) in place, else create it, as ONE native `upsert` (atomic against the
 * unique key), and record the result: a create records every non-null field, an update records what changed. The
 * pre-read only decides which of the two it was.
 */
export async function upsertAddonRowTx(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  a: {
    tenantId: string;
    addonKey: string;
    create: Prisma.TenantAddonUncheckedCreateInput;
    update: Prisma.TenantAddonUncheckedUpdateInput;
    actor: AddonActor;
  },
) {
  const where = { tenantId_addonKey: { tenantId: a.tenantId, addonKey: a.addonKey } };
  const before = (await tx.tenantAddon.findUnique({ where })) as Snapshot | null;
  if (before) await lockRow(tx, before.id);
  const row = await tx.tenantAddon.upsert({ where, create: a.create, update: a.update });
  await record(tx, events, before, row as unknown as Snapshot, a.actor, before == null);
  return row;
}

/**
 * A multi-row write: the rows the `where` matches are locked `FOR UPDATE`, then RE-READ under the lock with the same
 * `where` (a row a concurrent transaction changed between the first read and the lock no longer matches the guard and
 * is dropped, never recorded: SA-815 B5, a phantom record would blame this actor for another transaction's change and
 * corrupt the invariant job's evidence). ONE `updateMany` over exactly those locked ids, with the SAME `where`, writes
 * them, and each written row gets its own record from a re-read. A tenant holds a handful of rows. Returns how many
 * rows the write changed.
 */
export async function updateAddonRowsTx(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  a: {
    where: Prisma.TenantAddonWhereInput;
    data: Prisma.TenantAddonUncheckedUpdateInput;
    actor: AddonActor;
  },
): Promise<{ count: number }> {
  const candidates = (await tx.tenantAddon.findMany({ where: a.where })) as unknown as Snapshot[];
  if (candidates.length === 0) return { count: 0 };
  for (const c of candidates) await lockRow(tx, c.id);
  // Under the lock nothing can change these rows, so the re-read is the exact `before` and the write below touches
  // exactly this set.
  const before = (await tx.tenantAddon.findMany({
    where: { AND: [a.where, { id: { in: candidates.map((c) => c.id) } }] },
  })) as unknown as Snapshot[];
  if (before.length === 0) return { count: 0 };
  const { count } = await tx.tenantAddon.updateMany({
    where: { AND: [a.where, { id: { in: before.map((b) => b.id) } }] },
    data: a.data,
  });
  if (count === 0) return { count: 0 };
  const after = (await tx.tenantAddon.findMany({
    where: { id: { in: before.map((b) => b.id) } },
  })) as unknown as Snapshot[];
  for (const row of after) {
    const was = before.find((b) => b.id === row.id) ?? null;
    if (was) await record(tx, events, was, row, a.actor, false);
  }
  return { count };
}
