/**
 * An in-memory stand-in for the slice of Prisma the day-close service touches: the close table (with its unique key), the audit
 * log, the Z report send claim (BillingNotificationLog), the delivery log, the tenant's admins and zone. A transaction snapshots
 * the stores and RESTORES them when the callback throws, so a spec can prove an audit failure rolls the reopen back. Every call is
 * appended to `events`, in order, so a spec can prove the lock precedes the clock read. Placeholders only (acme).
 */
export const TENANT = "t-acme";
export const OTHER_TENANT = "t-globex";

export type Json = Record<string, any>;

export interface FakeOptions {
  tenantId?: string | null;
  /** the database clock: each read returns the next instant (the last one repeats) */
  clock?: Date[];
  timezone?: string | null;
  admins?: Array<{ email: string; status?: string; role?: string }>;
  users?: Record<string, string>;
  auditFails?: boolean;
}

const p2002 = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

const matchDate = (cond: any, v: Date | null): boolean => {
  if (cond === undefined) return true;
  if (cond === null) return v == null;
  if (cond && typeof cond === "object" && "not" in cond) {
    return cond.not === null ? v != null : v?.getTime() !== cond.not?.getTime();
  }
  return v?.getTime() === cond?.getTime();
};

export function makeFakeDayCloseDb(opts: FakeOptions = {}) {
  const events: string[] = [];
  const sql: Array<{ text: string; values: unknown[] }> = [];
  let closes: Json[] = [];
  let audits: Json[] = [];
  let claims: Json[] = [];
  const deliveries: Json[] = [];
  const clockQueue = [...(opts.clock ?? [new Date("2026-10-08T22:00:00.000Z")])];
  let seq = 0;
  const users = opts.users ?? { "u-op": "op-acme" };
  const tenantId = opts.tenantId === undefined ? TENANT : opts.tenantId;

  const withCloser = (row: Json | null, include: any) =>
    row && include?.closedBy
      ? { ...row, closedBy: row.closedById ? { username: users[row.closedById] ?? null } : null }
      : row;

  const counterDayClose = {
    findFirst: async (args: any) => {
      const w = args.where ?? {};
      const rows = closes
        .filter(
          (r) =>
            (w.id === undefined || r.id === w.id) &&
            (w.tenantId === undefined || r.tenantId === w.tenantId) &&
            (w.registerKey === undefined || r.registerKey === w.registerKey),
        )
        .sort(
          (a, b) =>
            b.windowEnd.getTime() - a.windowEnd.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
      const row = rows[0] ?? null;
      events.push(`close.findFirst`);
      if (!row) return null;
      return args.select
        ? { registerKey: row.registerKey, id: row.id }
        : withCloser({ ...row }, args.include);
    },
    create: async (args: any) => {
      const d = args.data;
      if (
        closes.some(
          (r) =>
            r.tenantId === d.tenantId &&
            r.registerKey === d.registerKey &&
            r.windowStart.getTime() === d.windowStart.getTime(),
        )
      ) {
        throw p2002();
      }
      const row = {
        reopenedAt: null,
        reopenedById: null,
        notes: null,
        ...d,
        id: `close-${++seq}`,
      };
      closes.push(row);
      events.push("close.create");
      return withCloser({ ...row }, args.include);
    },
    updateMany: async (args: any) => {
      const w = args.where;
      const hit = closes.filter(
        (r) =>
          (w.id === undefined || r.id === w.id) &&
          (w.tenantId === undefined || r.tenantId === w.tenantId) &&
          matchDate(w.reopenedAt, r.reopenedAt),
      );
      for (const r of hit) Object.assign(r, args.data);
      events.push(`close.updateMany:${hit.length}`);
      return { count: hit.length };
    },
  };

  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      sql.push({ text, values });
      events.push(text.startsWith("SET LOCAL") ? "set-lock-timeout" : "lock");
      return 0;
    },
    $queryRaw: async () => {
      events.push("clock");
      return [{ now: clockQueue.length > 1 ? clockQueue.shift() : clockQueue[0] }];
    },
    counterDayClose,
    auditLog: {
      create: async (args: any) => {
        events.push("audit");
        if (opts.auditFails) throw new Error("audit write failed");
        audits.push({ ...args.data });
        return args.data;
      },
    },
  };

  const db = {
    counterDayClose,
    order: { count: jest.fn(async () => 0) },
    tenantConfig: {
      findUnique: async () =>
        opts.timezone === undefined
          ? { timezone: "UTC" }
          : opts.timezone === null
            ? null
            : { timezone: opts.timezone },
    },
    tenant: { findUnique: async () => ({ name: "Acme Wholesale" }) },
    user: {
      findMany: async (args: any) =>
        (opts.admins ?? [{ email: "owner@acme.test" }])
          .filter(
            (a) =>
              (a.role ?? "TENANT_ADMIN") === args.where.role &&
              (a.status ?? "ACTIVE") === args.where.status,
          )
          .map((a) => ({ email: a.email })),
    },
    billingNotificationLog: {
      create: async (args: any) => {
        const d = args.data;
        if (
          claims.some(
            (c) => c.tenantId === d.tenantId && c.milestone === d.milestone && c.key === d.key,
          )
        ) {
          throw p2002();
        }
        claims.push({ ...d });
        events.push("claim");
        return d;
      },
      findFirst: async (args: any) => {
        const w = args.where;
        const hit = claims.find(
          (c) => c.tenantId === w.tenantId && c.milestone === w.milestone && c.key === w.key,
        );
        return hit ? { id: "claim" } : null;
      },
      deleteMany: async (args: any) => {
        const w = args.where;
        const before = claims.length;
        claims = claims.filter(
          (c) => !(c.tenantId === w.tenantId && c.milestone === w.milestone && c.key === w.key),
        );
        events.push("release");
        return { count: before - claims.length };
      },
    },
    emailDelivery: {
      findFirst: async (args: any) => {
        const w = args.where;
        const hit = deliveries.find(
          (d) =>
            d.tenantId === w.tenantId &&
            d.entityId === w.entityId &&
            d.kind === w.kind &&
            d.createdAt.getTime() >= w.createdAt.gte.getTime(),
        );
        return hit ? { id: "delivery" } : null;
      },
    },
  };

  const prisma = {
    getTenantId: () => tenantId,
    forTenant: () => db,
    tenant: db.tenant,
    tenantConfig: db.tenantConfig,
    tenantTransaction: async (fn: (t: any) => Promise<any>) => {
      const saved = {
        closes: closes.map((r) => ({ ...r })),
        audits: [...audits],
      };
      try {
        return await fn(tx);
      } catch (e) {
        closes = saved.closes;
        audits = saved.audits;
        throw e;
      }
    },
  };

  return {
    prisma,
    events,
    sql,
    get closes() {
      return closes;
    },
    get audits() {
      return audits;
    },
    get claims() {
      return claims;
    },
    /** a delivery row the EmailService would have recorded for a failed send */
    recordDelivery(row: Json) {
      deliveries.push(row);
    },
    seedClose(row: Json) {
      closes.push({
        reopenedAt: null,
        reopenedById: null,
        notes: null,
        id: `close-${++seq}`,
        ...row,
      });
    },
  };
}
