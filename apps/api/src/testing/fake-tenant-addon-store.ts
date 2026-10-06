/**
 * #2188 / SA-385: a stateful in-memory `tenantAddon` delegate for unit specs that must prove ROW
 * COUNTS (one row, re-activated in place) rather than call shapes. It honours the (tenantId,
 * addonKey) compound unique for findUnique/upsert/update and evaluates the `findAddonRow` predicate
 * (`OR` of addonKey / sku / addonKey IN) plus its orderBy for findFirst. Real-Postgres proof of the
 * same behaviour is the DB lane's (F2), not this fake's.
 */
export interface FakeAddonRow {
  id: string;
  tenantId: string;
  addonKey: string;
  sku: string | null;
  active: boolean;
  quantity: number;
  priceSnapshot: number | null;
  stripePriceId?: string | null;
  stripeItemId?: string | null;
  isComp?: boolean;
  createdAt: Date;
}

type Cond = { addonKey?: string | { in: string[] }; sku?: string };

function condMatches(row: FakeAddonRow, c: Cond): boolean {
  if (c.addonKey !== undefined)
    return typeof c.addonKey === "string"
      ? row.addonKey === c.addonKey
      : c.addonKey.in.includes(row.addonKey);
  if (c.sku !== undefined) return row.sku === c.sku;
  return false;
}

function whereMatches(row: FakeAddonRow, where: any): boolean {
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  if (where.active !== undefined && row.active !== where.active) return false;
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.isComp !== undefined && (row.isComp ?? false) !== where.isComp) return false;
  if (where.OR && !where.OR.some((c: Cond) => condMatches(row, c))) return false;
  return true;
}

function defined<T extends object>(data: T): Partial<T> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function fakeTenantAddonStore(seed: Array<Partial<FakeAddonRow>> = []) {
  let n = 0;
  const make = (r: Partial<FakeAddonRow>): FakeAddonRow => ({
    id: `row${++n}`,
    tenantId: "t1",
    addonKey: "",
    sku: null,
    active: true,
    quantity: 1,
    priceSnapshot: null,
    createdAt: new Date(Date.UTC(2026, 0, n)),
    ...r,
  });
  const rows: FakeAddonRow[] = seed.map(make);
  const byKey = (w: any) => {
    if (w.id) return rows.find((r) => r.id === w.id);
    const k = w.tenantId_addonKey;
    return rows.find((r) => r.tenantId === k.tenantId && r.addonKey === k.addonKey);
  };
  const copy = (r: FakeAddonRow | undefined) => (r ? { ...r } : null);

  return {
    rows,
    findUnique: jest.fn(async ({ where }: any) => copy(byKey(where))),
    findFirst: jest.fn(async ({ where, orderBy }: any) => {
      const hits = rows.filter((r) => whereMatches(r, where));
      if (orderBy)
        hits.sort(
          (a, b) =>
            Number(b.active) - Number(a.active) || a.createdAt.getTime() - b.createdAt.getTime(),
        );
      return copy(hits[0]);
    }),
    findMany: jest.fn(async ({ where }: any) =>
      rows.filter((r) => whereMatches(r, where)).map(copy),
    ),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const hit = byKey(where);
      if (hit) {
        Object.assign(hit, defined(update));
        return { ...hit };
      }
      const row = make(create);
      rows.push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const hit = byKey(where);
      if (!hit) throw new Error("fakeTenantAddonStore.update: no row");
      Object.assign(hit, defined(data));
      return { ...hit };
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = make(data);
      rows.push(row);
      return { ...row };
    }),
  };
}
