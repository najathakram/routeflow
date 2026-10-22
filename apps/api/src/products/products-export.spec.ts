import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { INSIGHT_MAX_WINDOW_MONTHS } from "../analytics/demand-range";
import { SalesFactsService } from "../sales-facts/sales-facts.service";
import { CSV_BOM } from "../common/csv";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductsController } from "./products.controller";
import { ProductsExportService, PRODUCTS_EXPORT_HEADER } from "./products-export.service";

/**
 * Step 2 — `GET /products/export.csv`. A fake tenant-scoped delegate (what `forTenant()` hands a
 * service) sits next to a deliberately LEAKY root delegate, so a service that forgets
 * `forTenant()` shows tenant B's rows and fails the isolation test.
 */

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

interface P {
  id: string;
  tenantId: string;
  name: string;
  sku?: string | null;
  unitSku?: string | null;
  barcode?: string | null;
  category?: string | null;
  unit?: string;
  pricePerUnit?: number;
  averageCost?: number | null;
  unitsPerBox?: number | null;
  currentStock?: number;
  isActive?: boolean;
  isTobacco?: boolean;
  parent?: { name: string; tenantId?: string } | null;
}

const product = (p: P) => ({
  sku: null,
  unitSku: null,
  barcode: null,
  category: null,
  unit: "each",
  pricePerUnit: 1,
  averageCost: null,
  unitsPerBox: null,
  currentStock: 0,
  isActive: true,
  isTobacco: false,
  parent: null,
  ...p,
});

interface Line {
  productId: string;
  tenantId: string;
  status: string;
  issueDate: string;
  qty: number;
  subtotal: number;
}
const line = (l: Line) => ({
  productId: l.productId,
  qty: l.qty,
  subtotal: l.subtotal,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  invoice: { tenantId: l.tenantId, status: l.status, issueDate: day(l.issueDate) },
});

/** Evaluates the slice of a Prisma where the export uses: AND / OR and name|id equality or gt. */
function matches(where: any, p: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries<any>(where)) {
    if (k === "AND") {
      if (!(v as any[]).every((w) => matches(w, p))) return false;
    } else if (k === "OR") {
      if (!(v as any[]).some((w) => matches(w, p))) return false;
    } else if (k === "name" || k === "id") {
      if (typeof v === "string") {
        if (p[k] !== v) return false;
      } else if (v && typeof v === "object" && "gt" in v) {
        if (!(p[k] > v.gt)) return false;
      }
    }
  }
  return true;
}
function compareBy(orderBy: any, a: any, b: any): number {
  for (const o of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    const [k] = Object.keys(o);
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

function build(opts: {
  products: ReturnType<typeof product>[];
  lines?: ReturnType<typeof line>[];
  creditNotes?: any[];
  refunds?: any[];
  lineOwners?: any[];
  cap?: number;
  batch?: number;
}) {
  const prisma: any = createMockPrisma();
  prisma.getTenantId.mockReturnValue(TENANT_A);
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "UTC" });
  const productCalls: any[] = [];
  const itemCalls: any[] = [];
  const scoped = {
    product: {
      findMany: jest.fn(async (args: any) => {
        productCalls.push(args);
        return opts.products
          .filter((p) => p.tenantId === TENANT_A && matches(args.where, p))
          .sort((a, b) => compareBy(args.orderBy, a, b))
          .slice(0, args.take);
      }),
    },
    invoiceItem: {
      findMany: jest.fn(async (args: any) => {
        itemCalls.push(args);
        const w = args.where;
        return (opts.lines ?? []).filter(
          (l) =>
            w.productId.in.includes(l.productId) &&
            l.invoice.tenantId === w.invoice.tenantId &&
            !w.invoice.status.notIn.includes(l.invoice.status) &&
            l.invoice.issueDate >= w.invoice.issueDate.gte &&
            l.invoice.issueDate < w.invoice.issueDate.lt,
        );
      }),
    },
    creditNote: { findMany: jest.fn().mockResolvedValue(opts.creditNotes ?? []) },
    return: { findMany: jest.fn().mockResolvedValue(opts.refunds ?? []) },
    invoice: { findMany: jest.fn().mockResolvedValue(opts.lineOwners ?? []) },
    order: { findMany: jest.fn().mockResolvedValue([]) },
  };
  prisma.forTenant = jest.fn().mockReturnValue(scoped);
  // The leak: an unscoped read returns every tenant's rows.
  prisma.product.findMany.mockImplementation(async () => opts.products);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const facts = new SalesFactsService(prisma);
  const svc = new ProductsExportService(prisma, facts, audit as any, opts.cap, opts.batch);
  return { svc, prisma, scoped, audit, productCalls, itemCalls };
}

async function run(svc: ProductsExportService, query: any = {}) {
  const { csv, filename } = await svc.prepare(query, { userId: "u1", ip: "1.2.3.4" });
  let out = "";
  for await (const chunk of csv) out += chunk;
  return { out, filename };
}

const rows = (out: string) =>
  out
    .replace(CSV_BOM, "")
    .split("\r\n")
    .filter((r) => r !== "");

const WINDOW = { from: "2026-09-01", to: "2026-09-29" };

describe("products export.csv", () => {
  afterEach(() => jest.useRealTimers());

  it("writes the BOM first, then the header columns in the spec order", async () => {
    const { svc } = build({ products: [] });
    const { out } = await run(svc, WINDOW);
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(rows(out)[0]).toBe(
      [
        "Name",
        "SKU",
        "Unit SKU",
        "Barcode",
        "Category",
        "Unit",
        "Price per unit",
        "Avg cost",
        "Units per case",
        "Stock",
        "Active",
        "Tobacco",
        "Family / Variant of (parent product name)",
        "Units sold",
        "Net sales",
        "Last sold date",
        "Product ID",
      ].join(","),
    );
    expect(PRODUCTS_EXPORT_HEADER).toHaveLength(17);
  });

  it("an empty result is header-only (no truncation or failure row)", async () => {
    const { svc } = build({ products: [] });
    const { out } = await run(svc, WINDOW);
    expect(rows(out)).toHaveLength(1);
  });

  it("emits one row per product with the catalog columns and stats", async () => {
    const { svc } = build({
      products: [
        product({
          id: "p1",
          tenantId: TENANT_A,
          name: "Cola 12pk",
          sku: "C-1",
          category: "Drinks",
          pricePerUnit: 24.5,
          averageCost: 10.12345,
          unitsPerBox: null,
          currentStock: 7,
          isTobacco: true,
        }),
        product({
          id: "p2",
          tenantId: TENANT_A,
          name: "Cola Diet",
          parent: { name: "Cola 12pk", tenantId: TENANT_A },
          isActive: false,
        }),
      ],
      lines: [
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "SENT",
          issueDate: "2026-09-10",
          qty: 5,
          subtotal: 50,
        }),
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "PAID",
          issueDate: "2026-09-20",
          qty: 3,
          subtotal: 30,
        }),
      ],
    });
    const { out } = await run(svc, WINDOW);
    const [, r1, r2] = rows(out);
    expect(r1).toBe("Cola 12pk,C-1,,,Drinks,each,24.5,10.1235,,7,Yes,Yes,,8,80,2026-09-20,p1");
    expect(r2).toBe("Cola Diet,,,,,each,1,,,0,No,No,Cola 12pk,0,0,,p2");
  });

  it("leaves the parent column empty for a parent that belongs to another tenant (B1211)", async () => {
    const { svc, productCalls } = build({
      products: [
        product({
          id: "p1",
          tenantId: TENANT_A,
          name: "Cola Cherry",
          parent: { name: "Foreign Family", tenantId: TENANT_B },
        }),
        product({
          id: "p2",
          tenantId: TENANT_A,
          name: "Cola Diet",
          parent: { name: "Own Family", tenantId: TENANT_A },
        }),
      ],
    });
    const { out } = await run(svc, WINDOW);
    const [, r1, r2] = rows(out);
    expect(r1.split(",")[12]).toBe("");
    expect(r2.split(",")[12]).toBe("Own Family");
    expect(out).not.toContain("Foreign Family");
    expect(productCalls[0].select.parent).toEqual({ select: { name: true, tenantId: true } });
  });

  it("Avg cost uses @routeflow/pricing round4 (half away from zero; L-248), not a local Math.round nudge", async () => {
    // A local `Math.round((n + EPSILON) * 1e4) / 1e4` rounds a negative half (-2.00005) toward +inf -> -2.
    const { svc } = build({
      products: [
        product({ id: "p1", tenantId: TENANT_A, name: "Credit cost", averageCost: -2.00005 }),
      ],
      lines: [],
    });
    const { out } = await run(svc, WINDOW);
    const [, r1] = rows(out);
    expect(r1.split(",")[7]).toBe("-2.0001");
  });

  it("products-export.service imports round4 from @routeflow/pricing and declares no local copy (L-248)", () => {
    const src = readFileSync(join(__dirname, "products-export.service.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*\bround4\b[^}]*\} from "@routeflow\/pricing"/);
    expect(src).not.toMatch(/(const|function)\s+round4\b/);
  });

  it("the export honours the list's portalVisible filter through the shared where builder (N1, #2856)", async () => {
    const { svc, productCalls } = build({
      products: [product({ id: "p1", tenantId: TENANT_A, name: "Cola" })],
    });
    await run(svc, { ...WINDOW, portalVisible: false });
    const hidden = { OR: [{ portalVisible: false }, { parent: { portalVisible: false } }] };
    expect(productCalls[0].where.AND).toContainEqual(hidden);
    productCalls.length = 0;
    await run(svc, { ...WINDOW, portalVisible: true });
    expect(productCalls[0].where.AND).toContainEqual({ NOT: hidden });
    productCalls.length = 0;
    await run(svc, WINDOW);
    expect(JSON.stringify(productCalls[0].where)).not.toContain("portalVisible");
  });

  it("stats come from accrual invoices only: DRAFT/VOID, other tenants and out-of-window lines never count, a PAID invoice does, and no order is read", async () => {
    const { svc, itemCalls, scoped } = build({
      products: [product({ id: "p1", tenantId: TENANT_A, name: "Cola" })],
      lines: [
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "SENT",
          issueDate: "2026-09-10",
          qty: 2,
          subtotal: 20,
        }),
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "PAID",
          issueDate: "2026-09-11",
          qty: 1,
          subtotal: 10.005,
        }),
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "WRITTEN_OFF",
          issueDate: "2026-09-12",
          qty: 1,
          subtotal: 5,
        }),
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "DRAFT",
          issueDate: "2026-09-13",
          qty: 100,
          subtotal: 1000,
        }),
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "VOID",
          issueDate: "2026-09-14",
          qty: 50,
          subtotal: 500,
        }),
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "SENT",
          issueDate: "2026-08-01",
          qty: 9,
          subtotal: 90,
        }),
        line({
          productId: "p1",
          tenantId: TENANT_B,
          status: "SENT",
          issueDate: "2026-09-15",
          qty: 7,
          subtotal: 70,
        }),
      ],
    });
    const { out } = await run(svc, WINDOW);
    expect(rows(out)[1]).toBe("Cola,,,,,each,1,,,0,Yes,No,,4,35.01,2026-09-12,p1");
    expect(itemCalls).toHaveLength(1); // one grouped read per batch
    const where = itemCalls[0].where;
    expect(where.invoice.tenantId).toBe(TENANT_A);
    expect(where.invoice.status).toEqual({ notIn: ["DRAFT", "VOID"] });
    expect(JSON.stringify(where)).not.toMatch(/PAID|paid/);
    expect(scoped.order.findMany).not.toHaveBeenCalled();
  });

  it("Net sales = gross minus the credit notes and external refunds attributed to the product (same as insights)", async () => {
    const { svc } = build({
      products: [
        product({ id: "p1", tenantId: TENANT_A, name: "Cola" }),
        product({ id: "p2", tenantId: TENANT_A, name: "Diet" }),
      ],
      lines: [
        line({
          productId: "p1",
          tenantId: TENANT_A,
          status: "SENT",
          issueDate: "2026-09-10",
          qty: 10,
          subtotal: 100,
        }),
      ],
      // A 30.00 note pointing at p1's invoice line, and a 12.50 note on p2's (sold before the window).
      creditNotes: [
        {
          id: "cn1",
          amount: 30,
          status: "APPLIED",
          createdAt: day("2026-09-12"),
          items: [{ invoiceItemId: "li1", amount: 30 }],
        },
        {
          id: "cn2",
          amount: 12.5,
          status: "ISSUED",
          createdAt: day("2026-09-13"),
          items: [{ invoiceItemId: "li2", amount: 12.5 }],
        },
      ],
      lineOwners: [
        {
          items: [
            { id: "li1", productId: "p1" },
            { id: "li2", productId: "p2" },
          ],
        },
      ],
      // An inline external refund of 5.00 on p1 (5.40 with tax: the 0.40 stays unattributed).
      refunds: [{ kind: "INLINE", refundAmount: 5.4, items: [{ productId: "p1", subtotal: 5 }] }],
    });
    const { out } = await run(svc, WINDOW);
    const [, cola, diet] = rows(out);
    expect(cola.split(",")[14]).toBe("65"); // 100 - 30 - 5
    expect(diet.split(",")[14]).toBe("-12.5"); // no sales, one credit
  });

  it("only reads through forTenant(): tenant B products never appear", async () => {
    const { svc, prisma } = build({
      products: [
        product({ id: "a1", tenantId: TENANT_A, name: "Mine" }),
        product({ id: "b1", tenantId: TENANT_B, name: "Leaked Widget" }),
      ],
    });
    const { out } = await run(svc, WINDOW);
    expect(out).toContain("Mine");
    expect(out).not.toContain("Leaked Widget");
    expect(prisma.forTenant).toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("neutralises a formula-leading name and keeps the file UTF-8", async () => {
    const { svc } = build({
      products: [product({ id: "p1", tenantId: TENANT_A, name: '=HYPERLINK("x")' })],
    });
    const { out } = await run(svc, WINDOW);
    expect(rows(out)[1].startsWith("\"'=HYPERLINK(")).toBe(true);
  });

  it("honours the list filters in the where clause and ignores paging", async () => {
    const { svc, productCalls } = build({ products: [] });
    await run(svc, {
      ...WINDOW,
      search: "cola",
      category: "Drinks",
      isActive: true,
      isTobacco: false,
      stockStatus: "LOW",
      section: "any",
      page: 3,
      limit: 5,
    });
    const w = productCalls[0].where;
    const s = JSON.stringify(w);
    expect(s).toContain("cola");
    expect(s).toContain("Drinks");
    expect(w.isActive).toBe(true); // LOW also pins isActive true
    expect(w.isTobacco).toBe(false);
    expect(w.currentStock).toEqual({ lte: 5 });
    expect(w.trackedCategoryId).toEqual({ not: null });
    expect(productCalls[0].skip).toBeUndefined();
    expect(productCalls[0].take).toBeGreaterThan(5);
  });

  it("rows follow the list's order (name asc, id as the tie-break) across batches", async () => {
    const products = [
      product({ id: "p5", tenantId: TENANT_A, name: "Banana", sku: "p5" }),
      product({ id: "p1", tenantId: TENANT_A, name: "Cherry", sku: "p1" }),
      product({ id: "p4", tenantId: TENANT_A, name: "Apple", sku: "p4" }),
      product({ id: "p2", tenantId: TENANT_A, name: "Banana", sku: "p2" }),
      product({ id: "p3", tenantId: TENANT_A, name: "Apple", sku: "p3" }),
      product({ id: "p6", tenantId: TENANT_A, name: "Banana", sku: "p6" }),
    ];
    const { svc, productCalls, itemCalls } = build({ products, batch: 2 });
    const { out } = await run(svc, WINDOW);
    const seen = rows(out)
      .slice(1)
      .map((r) => r.split(",").slice(0, 2).join("/"));
    expect(seen).toEqual([
      "Apple/p3",
      "Apple/p4",
      "Banana/p2",
      "Banana/p5",
      "Banana/p6",
      "Cherry/p1",
    ]);
    expect(productCalls[0].orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    expect(itemCalls).toHaveLength(Math.ceil(6 / 2)); // still one grouped stats read per batch
  });

  it("truncates at the cap with a trailing marker row", async () => {
    const products = Array.from({ length: 5 }, (_, i) =>
      product({ id: `p${i}`, tenantId: TENANT_A, name: `Item ${i}` }),
    );
    const { svc } = build({ products, cap: 3, batch: 2 });
    const { out } = await run(svc, WINDOW);
    const r = rows(out);
    expect(r).toHaveLength(1 + 3 + 1);
    expect(r[r.length - 1]).toBe("# truncated at 3 rows");
  });

  it("does not mark truncated when the rows exactly fill the cap", async () => {
    const products = Array.from({ length: 3 }, (_, i) =>
      product({ id: `p${i}`, tenantId: TENANT_A, name: `Item ${i}` }),
    );
    const { svc } = build({ products, cap: 3, batch: 2 });
    const { out } = await run(svc, WINDOW);
    expect(out).not.toContain("# truncated");
    expect(rows(out)).toHaveLength(4);
  });

  it("a mid-stream failure ends the file with the incomplete row", async () => {
    const { svc, scoped, audit } = build({
      products: [product({ id: "p1", tenantId: TENANT_A, name: "One" })],
    });
    scoped.invoiceItem.findMany.mockRejectedValueOnce(new Error("db went away"));
    const { out } = await run(svc, WINDOW);
    expect(rows(out).pop()).toBe("# export failed: the file is incomplete");
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][0].meta.failed).toBe(true);
  });

  it("writes one audit row with who, what, rowCount, filters, window and truncation", async () => {
    const products = Array.from({ length: 4 }, (_, i) =>
      product({ id: `p${i}`, tenantId: TENANT_A, name: `Item ${i}` }),
    );
    const { svc, audit } = build({ products, cap: 3, batch: 2 });
    await run(svc, { ...WINDOW, category: "Drinks" });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        userId: "u1",
        ip: "1.2.3.4",
        action: "PRODUCTS_EXPORT_CSV",
        entityType: "Product",
        meta: expect.objectContaining({
          rowCount: 3,
          truncated: true,
          from: "2026-09-01",
          to: "2026-09-29",
          filters: expect.objectContaining({ category: "Drinks" }),
        }),
      }),
    );
  });

  it("defaults to the last 30 days (inclusive) and dates the file by today", async () => {
    jest.useFakeTimers({
      now: new Date("2026-09-29T12:00:00Z"),
      doNotFake: ["nextTick", "setImmediate"],
    });
    const { svc, itemCalls } = build({
      products: [product({ id: "p1", tenantId: TENANT_A, name: "Cola" })],
    });
    const { filename } = await run(svc, {});
    expect(filename).toBe("products-2026-09-29.csv");
    const w = itemCalls[0].where.invoice.issueDate;
    expect(w.gte.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(w.lt.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });

  it("rejects an impossible window with a 400", async () => {
    const { svc } = build({ products: [] });
    await expect(
      svc.prepare({ from: "2026-13-40", to: "2026-09-29" }, { userId: "u1" }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("B987-E (d): the export's window refusals carry a code and a reason (status and message unchanged)", () => {
  const window = (q: { from?: string; to?: string }) => {
    const { svc } = build({ products: [] });
    return svc.prepare(q, { userId: "u1" }).catch((e) => e);
  };

  it.each([
    [{ from: "2026-09-01", to: "2026-9-29" }, "TO_NOT_A_DAY", {}],
    [{ from: "2026-13-40", to: "2026-09-29" }, "FROM_NOT_A_DAY", {}],
    [{ to: "2026-02-30" }, "NOT_A_DAY", {}],
    [{ from: "2026-09-29", to: "2026-09-01" }, "TO_BEFORE_FROM", {}],
    [
      { from: "2020-01-01", to: "2026-09-29" },
      "WINDOW_TOO_LONG",
      { maxMonths: INSIGHT_MAX_WINDOW_MONTHS },
    ],
  ])("%j -> INSIGHT_WINDOW_INVALID / %s", async (q, reason, extra) => {
    const err: any = await window(q);
    expect(err.getStatus()).toBe(400);
    const body = err.getResponse();
    expect(body).toMatchObject({ code: "INSIGHT_WINDOW_INVALID", reason, ...extra });
    expect(typeof body.message).toBe("string"); // unchanged server sentence
    expect(Object.keys(body).sort()).toEqual(
      ["code", "message", "reason", ...Object.keys(extra)].sort(),
    );
  });
});

describe("ProductsController.exportCsv — route contract", () => {
  const handler = ProductsController.prototype.exportCsv;
  const guard = new RolesGuard(new Reflector());
  const ctx = (role: UserRole) =>
    ({
      getHandler: () => handler,
      getClass: () => ProductsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  it("is OPERATOR-only: tenant admin and operator pass, driver and customer do not", () => {
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.OPERATOR]);
    expect(guard.canActivate(ctx(UserRole.OPERATOR))).toBe(true);
    expect(guard.canActivate(ctx(UserRole.TENANT_ADMIN))).toBe(true);
    expect(guard.canActivate(ctx(UserRole.DRIVER))).toBe(false);
    expect(guard.canActivate(ctx(UserRole.CUSTOMER))).toBe(false);
  });

  it("is throttled per client (a few per minute)", () => {
    expect(Reflect.getMetadata("THROTTLER:LIMIT" + "default", handler)).toBeLessThanOrEqual(10);
    expect(Reflect.getMetadata("THROTTLER:TTL" + "default", handler)).toBe(60_000);
  });

  it("is declared before every :id route so it is not captured as an id", () => {
    const proto = ProductsController.prototype as any;
    const paths = Object.getOwnPropertyNames(proto)
      .filter((n) => n !== "constructor")
      .map((n) => ({ n, path: Reflect.getMetadata("path", proto[n]) as string }));
    const exportIdx = paths.findIndex((p) => p.path === "export.csv");
    const firstId = paths.findIndex((p) => typeof p.path === "string" && p.path.startsWith(":id"));
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeLessThan(firstId);
  });

  it("streams with csv headers, no-store, attachment filename, and a BOM first chunk", async () => {
    const exporter = {
      prepare: jest.fn().mockResolvedValue({
        filename: "products-2026-09-29.csv",
        csv: (async function* () {
          yield CSV_BOM + "Name\r\n";
          yield "x\r\n";
        })(),
      }),
    };
    const ctl = new ProductsController({} as any, exporter as any);
    const res: any = {
      headers: {} as Record<string, string>,
      body: "",
      destroyed: false,
      status: () => res,
      setHeader: (k: string, v: string) => (res.headers[k.toLowerCase()] = v),
      write: (c: string) => ((res.body += c), true),
      end: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
    };
    await ctl.exportCsv(
      { category: "a" } as any,
      { sub: "u1" } as any,
      { ip: "9.9.9.9" } as any,
      res,
    );
    expect(exporter.prepare).toHaveBeenCalledWith(
      { category: "a" },
      { userId: "u1", ip: "9.9.9.9" },
    );
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="products-2026-09-29.csv"',
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.startsWith(CSV_BOM)).toBe(true);
    expect(res.end).toHaveBeenCalled();
  });
});
