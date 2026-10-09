/**
 * An in-memory stand-in for the three tables the catch-up claim touches (TenantSubscription, RfInvoice,
 * AuditLog), with Prisma-shaped `findUnique` / `findFirst` / `findMany` / `updateMany` / `create` and a
 * `$transaction` that runs its callback against the same store and records the `FOR UPDATE` lock calls. It
 * supports the `where` shapes the service uses: scalar equality (incl. null), `{ not }`, `{ in }`.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    const cur = row[k];
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v && (v.not === null ? cur == null : cur === v.not)) return false;
      if ("in" in v && !v.in.includes(cur)) return false;
      if ("not" in v || "in" in v) continue;
    }
    if (v === null ? cur != null : cur !== v) return false;
  }
  return true;
}

export interface FakeCatchupDb {
  subs: Row[];
  invoices: Row[];
  audits: Row[];
  locks: string[];
  prisma: any;
}

export function fakeCatchupDb(seed: { subs?: Row[]; invoices?: Row[] } = {}): FakeCatchupDb {
  const subs: Row[] = (seed.subs ?? []).map((s) => ({
    stripeSubId: null,
    externalPayment: true,
    catchupState: null,
    catchupSessionId: null,
    catchupInvoiceId: null,
    updatedAt: new Date("2026-10-09T00:00:00Z"),
    ...s,
  }));
  const invoices: Row[] = (seed.invoices ?? []).map((i) => ({
    periodKey: null,
    number: i.id,
    ...i,
  }));
  const audits: Row[] = [];
  const locks: string[] = [];

  const table = (rows: Row[], touch = false) => {
    const pick = (r: Row, select?: Row) =>
      select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r };
    return {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const r = rows.find((x) => matches(x, where));
        return r ? pick(r, select) : null;
      }),
      findFirst: jest.fn(async ({ where, select }: any = {}) => {
        const r = rows.find((x) => matches(x, where));
        return r ? pick(r, select) : null;
      }),
      findMany: jest.fn(async ({ where, select }: any = {}) =>
        rows.filter((x) => matches(x, where)).map((r) => pick(r, select)),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((x) => matches(x, where));
        for (const r of hit) {
          Object.assign(r, data);
          if (touch) r.updatedAt = new Date();
        }
        return { count: hit.length };
      }),
    };
  };

  const tx: any = {
    tenantSubscription: table(subs, false),
    rfInvoice: table(invoices),
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        audits.push({ ...data });
        return {};
      }),
      /** tenantId / entityType / action equality plus `AND: [{ meta: { path: [k], equals } }]` (the noticeOnce shape). */
      findFirst: jest.fn(async ({ where = {} }: any = {}) => {
        const hit = audits.find((a) => {
          if (where.tenantId !== undefined && a.tenantId !== where.tenantId) return false;
          if (where.entityType !== undefined && a.entityType !== where.entityType) return false;
          if (where.action !== undefined && a.action !== where.action) return false;
          return (where.AND ?? []).every(
            (c: any) => c.meta?.path && a.meta?.[c.meta.path[0]] === c.meta.equals,
          );
        });
        return hit ? { id: "audit-hit" } : null;
      }),
    },
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, ...v: unknown[]) => {
      locks.push(String(v[0]));
      return [];
    }),
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return { subs, invoices, audits, locks, prisma };
}
