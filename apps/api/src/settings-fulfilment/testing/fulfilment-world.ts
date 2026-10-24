/**
 * An in-memory tenant "world" for the fulfilment-settings specs: a stateful Prisma stand-in
 * (TenantFeatureConfig rows, AuditLog rows, orders, templates, users) wired to the REAL
 * `FeatureConfigService` / `FeatureConfigStore`, so the specs prove what is stored, audited and
 * counted, not just which calls were made. `tenantTransaction` really rolls back: a throw inside
 * it restores the rows and audits as they were. Real-Postgres proof is the DB lane's
 * (`settings-fulfilment.db.spec.ts`), not this fake's.
 */
import { FeatureConfigService } from "../../billing/feature-config.service";
import { FeatureConfigStore } from "../../billing/feature-config.store";
import { lockState } from "./lock-mock";

export const TENANT_ID = "tenant-acme";
export const OTHER_TENANT_ID = "tenant-globex";

export type FulfilmentKey = "fulfilment_model" | "counter_sales";

export interface WorldRow {
  tenantId: string;
  featureKey: string;
  mode: string;
  reason: string;
  updatedById: string | null;
  updatedAt: Date;
}
export interface WorldAudit {
  tenantId: string | null;
  userId: string | null;
  impersonatedBy: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  meta: Record<string, any>;
}
export interface WorldOrder {
  tenantId: string;
  fulfillPath: "ROUTE" | "SHIP" | "PICKUP";
  status: string;
  shippedAt?: Date | null;
}
export interface WorldUser {
  id: string;
  tenantId: string | null;
  role: string;
  username: string;
}

export interface WorldOptions {
  tenantId?: string | null;
  fleet?: boolean;
  /** Active add-on keys; overrides `fleet`. */
  activeAddons?: string[];
  rows?: Array<{
    tenantId?: string;
    featureKey: FulfilmentKey;
    mode: string;
    updatedById?: string | null;
    updatedAt?: Date;
  }>;
  orders?: WorldOrder[];
  /** Active standing-order templates of the tenant. */
  templates?: number;
  users?: WorldUser[];
  /** Make the audit insert throw (to prove the write rolls back). */
  failAudit?: boolean;
  /** Make the fleet read throw (addon service down). */
  failFleet?: boolean;
}

const matchesStatus = (status: string, cond: any): boolean => {
  if (cond === undefined) return true;
  if (typeof cond === "string") return status === cond;
  if (cond.notIn) return !cond.notIn.includes(status);
  if (cond.in) return cond.in.includes(status);
  return true;
};

export function createWorld(opts: WorldOptions = {}) {
  const tenantId = opts.tenantId === undefined ? TENANT_ID : opts.tenantId;
  const addons = opts.activeAddons ?? (opts.fleet === false ? [] : ["recurring_routes"]);
  const state = {
    rows: new Map<string, WorldRow>(),
    audits: [] as WorldAudit[],
    orders: [...(opts.orders ?? [])],
    templates: opts.templates ?? 0,
    users: [...(opts.users ?? [])],
  };
  const rowId = (t: string, k: string) => `${t}:${k}`;
  for (const r of opts.rows ?? []) {
    const t = r.tenantId ?? TENANT_ID;
    state.rows.set(rowId(t, r.featureKey), {
      tenantId: t,
      featureKey: r.featureKey,
      mode: r.mode,
      reason: "seed",
      updatedById: r.updatedById ?? null,
      updatedAt: r.updatedAt ?? new Date("2026-10-01T10:00:00.000Z"),
    });
  }

  const calls = {
    count: [] as Array<{ model: string; where: any }>,
    txOpened: 0,
    bareTransaction: 0,
    writes: [] as string[],
  };

  // ONE set of delegates serves both the bare client and the transaction client, so a spec can
  // assert on / reject a call whichever way the service reaches it; only the event log knows
  // whether a transaction is open.
  let inTx = false;
  function makeDelegates() {
    const log = (e: string) => {
      if (inTx) lockState.events.push(e);
    };
    return {
      tenant: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id })) },
      tenantFeatureConfig: {
        findUnique: jest.fn(async ({ where }: any) => {
          const w = where.tenantId_featureKey;
          const row = state.rows.get(rowId(w.tenantId, w.featureKey));
          return row ? { ...row } : null;
        }),
        findMany: jest.fn(async ({ where }: any) =>
          [...state.rows.values()]
            .filter(
              (r) =>
                (where.tenantId === undefined || r.tenantId === where.tenantId) &&
                (!where.featureKey?.in || where.featureKey.in.includes(r.featureKey)),
            )
            .map((r) => ({ ...r })),
        ),
        deleteMany: jest.fn(async ({ where }: any) => {
          const id = rowId(where.tenantId, where.featureKey);
          const had = state.rows.delete(id);
          return { count: had ? 1 : 0 };
        }),
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const w = where.tenantId_featureKey;
          const id = rowId(w.tenantId, w.featureKey);
          const existing = state.rows.get(id);
          const next: WorldRow = existing
            ? { ...existing, ...update, updatedAt: new Date("2026-10-07T12:00:00.000Z") }
            : { ...create, updatedAt: new Date("2026-10-07T12:00:00.000Z") };
          state.rows.set(id, next);
          calls.writes.push(`upsert:${w.featureKey}`);
          log(`tx:upsert:${w.featureKey}`);
          return { ...next };
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: any) => {
          if (opts.failAudit) throw new Error("audit insert failed");
          state.audits.push({
            tenantId: data.tenantId ?? null,
            userId: data.userId ?? null,
            impersonatedBy: data.impersonatedBy ?? null,
            action: data.action,
            entityType: data.entityType,
            entityId: data.entityId ?? null,
            meta: data.meta,
          });
          log(`tx:audit:${data.entityId}`);
          return {};
        }),
      },
      order: {
        count: jest.fn(async ({ where }: any) => {
          calls.count.push({ model: "order", where });
          return state.orders.filter(
            (o) =>
              (where.tenantId === undefined || o.tenantId === where.tenantId) &&
              (where.fulfillPath === undefined || o.fulfillPath === where.fulfillPath) &&
              matchesStatus(o.status, where.status) &&
              (where.shippedAt === undefined ||
                (where.shippedAt?.not === null ? o.shippedAt != null : o.shippedAt == null)),
          ).length;
        }),
      },
      orderTemplate: {
        count: jest.fn(async ({ where }: any) => {
          calls.count.push({ model: "orderTemplate", where });
          return where.tenantId === tenantId ? state.templates : 0;
        }),
      },
      user: {
        findFirst: jest.fn(
          async ({ where }: any) =>
            state.users.find(
              (u) =>
                u.id === where.id &&
                (where.tenantId === undefined || u.tenantId === where.tenantId),
            ) ?? null,
        ),
      },
    };
  }

  const base = makeDelegates();
  const prisma: any = {
    ...base,
    getTenantId: jest.fn(() => tenantId),
    forTenant: jest.fn(() => prisma),
    $transaction: jest.fn(async () => {
      calls.bareTransaction += 1;
      throw new Error("a bare $transaction is not tenant scoped: use tenantTransaction");
    }),
    tenantTransaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
      calls.txOpened += 1;
      inTx = true;
      lockState.events.push("tx:open");
      const rowsBefore = new Map([...state.rows].map(([k, v]) => [k, { ...v }]));
      const auditsBefore = [...state.audits];
      try {
        const out = await fn(base);
        lockState.events.push("tx:commit");
        return out;
      } catch (e) {
        state.rows = rowsBefore;
        state.audits = auditsBefore;
        lockState.events.push("tx:rollback");
        throw e;
      } finally {
        inTx = false;
      }
    }),
  };

  const addonService: any = {
    getActiveAddons: jest.fn(async () => {
      if (opts.failFleet) throw new Error("addon read failed");
      return addons;
    }),
    hasAddon: jest.fn(async (_t: string, k: string) => addons.includes(k)),
    // Anything that would CHANGE what the tenant owns: must never be called by this feature.
    enableAddon: jest.fn(),
    disableAddon: jest.fn(),
    setAddon: jest.fn(),
  };
  const featureOverrides: any = {
    get: jest.fn(async () => null),
    allActive: jest.fn(async () => new Map()),
    grant: jest.fn(),
    deny: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
    create: jest.fn(),
  };
  const entitlements: any = { hasFlag: jest.fn(async () => true) };
  const audit: any = { log: jest.fn(async () => undefined) };

  const store = new FeatureConfigStore(prisma);
  const featureConfig = new FeatureConfigService(
    prisma,
    store,
    audit,
    addonService,
    entitlements,
    featureOverrides,
  );

  return {
    tenantId,
    prisma,
    state,
    calls,
    store,
    featureConfig,
    addonService,
    featureOverrides,
    audit,
    row: (key: FulfilmentKey, t: string = TENANT_ID) => state.rows.get(rowId(t, key)),
    rowCount: () => state.rows.size,
  };
}

export type World = ReturnType<typeof createWorld>;
