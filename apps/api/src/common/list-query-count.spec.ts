import { ProductsService } from "../products/products.service";
import { InventoryService } from "../inventory/inventory.service";
import { CustomersService } from "../customers/customers.service";
import { InvoicesService } from "../invoices/invoices.service";

/**
 * P-64 query-count ratchet. Four list reads must run a FIXED number of database calls whatever the row
 * count (no N+1): the number of calls with 1 row equals the number with 200 rows, and is pinned below.
 * A per-row read inside any of them (a `findUnique` per product, per customer, per invoice) turns the
 * 200-row figure into n + 200 and fails here. Prisma is mocked at the module boundary and counts EVERY
 * delegate call (any model, any method, plus raw queries); no database.
 *
 * Budgets are NOT set here (P-60 owns them): this spec pins what the code does today.
 */

type Row = Record<string, unknown>;

/** Every call on any model delegate or raw query is counted; only `primary` ever returns more than 0 rows. */
function countingPrisma(primary: string, rows: Row[]) {
  const calls: string[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          calls.push(`${name}.${method}`);
          if (method === "findMany") return name === primary ? rows : [];
          if (method === "count") return name === primary ? rows.length : 0;
          if (method === "aggregate") return { _sum: {}, _count: 0 };
          if (method === "groupBy") return [];
          return null;
        },
      },
    );
  const models = new Map<string, unknown>();
  const prisma: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get: (_t, prop: string | symbol) => {
        if (typeof prop !== "string") return undefined;
        if (prop === "getTenantId") return () => "tenant-1";
        if (prop === "forTenant") return () => prisma;
        if (prop === "then") return undefined;
        if (prop.startsWith("$")) {
          return async () => {
            calls.push(prop);
            return [];
          };
        }
        if (!models.has(prop)) models.set(prop, model(prop));
        return models.get(prop);
      },
    },
  );
  return { prisma, calls };
}

const productRow = (i: number): Row => ({
  id: `p${i}`,
  name: `Acme Item ${i}`,
  sku: `ACME-${i}`,
  imageKeys: [`p${i}/front.jpg`],
  barcode: null,
  unitsPerBox: 24,
  parent: {
    id: "fam",
    name: "Acme Family",
    kind: "FAMILY",
    portalVisible: true,
    category: null,
    tenantId: "tenant-1",
  },
  barcodes: [{ id: `b${i}`, level: "unit", code: `100${i}` }],
});
const stockRow = (i: number): Row => ({
  id: `p${i}`,
  name: `Acme Item ${i}`,
  currentStock: 5,
  averageCost: 2,
  standardCost: null,
  costingMethod: "AVCO",
});
const customerRow = (i: number): Row => ({
  id: `c${i}`,
  businessName: `Acme Store ${i}`,
  addresses: [{ id: `a${i}` }],
  tagAssignments: [{ id: `t${i}`, tag: { id: "tag", name: "Acme" } }],
  user: null,
  _count: { authorizations: 0 },
});
const invoiceRow = (i: number): Row => ({
  id: `i${i}`,
  invoiceNumber: `INV-${i}`,
  status: "SENT",
  total: 100,
  subtotal: 100,
  discount: 0,
  issueDate: new Date("2026-11-01T00:00:00Z"),
  dueDate: new Date("2026-12-01T00:00:00Z"),
  payments: [
    {
      id: `pay${i}`,
      status: "PAID",
      method: "CASH",
      amount: 10,
      createdAt: new Date("2026-11-02T00:00:00Z"),
    },
  ],
  customer: { id: "c1", businessName: "Acme Store" },
  order: null,
});

const make = (n: number, row: (i: number) => Row) =>
  Array.from({ length: n }, (_v, i) => row(i + 1));

async function callsFor(
  primary: string,
  row: (i: number) => Row,
  build: (prisma: unknown) => (() => Promise<unknown>) | Promise<() => Promise<unknown>>,
  n: number,
) {
  const { prisma, calls } = countingPrisma(primary, make(n, row));
  const run = await build(prisma);
  await run();
  return calls.length;
}

const READS = [
  {
    name: "ProductsService.findAll",
    primary: "product",
    row: productRow,
    pinned: 2,
    build: (prisma: unknown) => {
      const svc = Object.create(ProductsService.prototype) as ProductsService;
      Object.assign(svc, { prisma, storage: { presignedUrl: async () => null } });
      return () => svc.findAll({ page: 1, limit: 200 } as never);
    },
  },
  {
    name: "InventoryService.getStockOverview",
    primary: "product",
    row: stockRow,
    pinned: 1,
    build: (prisma: unknown) => {
      const svc = Object.create(InventoryService.prototype) as InventoryService;
      Object.assign(svc, { prisma });
      return () => svc.getStockOverview();
    },
  },
  {
    name: "CustomersService.findAll",
    primary: "customer",
    row: customerRow,
    pinned: 6,
    build: (prisma: unknown) => {
      const svc = Object.create(CustomersService.prototype) as CustomersService;
      Object.assign(svc, { prisma });
      return () => svc.findAll({ page: 1, limit: 200 } as never);
    },
  },
  {
    name: "InvoicesService.findAll",
    primary: "invoice",
    row: invoiceRow,
    pinned: 4,
    build: (prisma: unknown) => {
      const svc = Object.create(InvoicesService.prototype) as InvoicesService;
      Object.assign(svc, { prisma });
      return () => svc.findAll({ page: 1, limit: 200 } as never);
    },
  },
];

describe("list reads run a fixed number of database calls (query-count ratchet)", () => {
  for (const r of READS) {
    describe(r.name, () => {
      it("makes the same number of calls for 1 row and for 200 rows", async () => {
        const one = await callsFor(r.primary, r.row, r.build, 1);
        const many = await callsFor(r.primary, r.row, r.build, 200);
        expect(many).toBe(one);
      });

      it("makes exactly the pinned number of calls", async () => {
        expect(await callsFor(r.primary, r.row, r.build, 200)).toBe(r.pinned);
      });
    });
  }
});
