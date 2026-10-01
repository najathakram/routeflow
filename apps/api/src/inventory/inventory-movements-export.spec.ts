import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { CSV_BOM } from "../common/csv";
import { createMockPrisma } from "../testing/prisma-mock";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import {
  InventoryMovementsExportService,
  MOVEMENTS_EXPORT_HEADER,
} from "./inventory-movements-export.service";
import { buildMovementsWhere } from "./movements-where";

/**
 * CSV-3 (a): `GET /inventory/movements/export.csv`. A fake tenant-scoped StockMovement delegate (what
 * `forTenant()` hands a service) evaluates the real Prisma where/orderBy slice the list and the export
 * use, next to a deliberately LEAKY root delegate so a service that forgets `forTenant()` shows tenant
 * B's rows.
 */

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

interface M {
  id: string;
  tenantId: string;
  productId: string;
  type: string;
  quantity: number;
  unitCost?: number | null;
  stockAfter?: number | null;
  reference?: string | null;
  notes?: string | null;
  effectiveAt: Date;
  createdAt: Date;
}
const t = (s: string) => new Date(s);
const mv = (m: Partial<M> & Pick<M, "id">): M => ({
  tenantId: TENANT_A,
  productId: "p1",
  type: "PURCHASE",
  quantity: 1,
  unitCost: null,
  stockAfter: null,
  reference: null,
  notes: null,
  effectiveAt: t("2026-09-10T12:00:00Z"),
  createdAt: t("2026-09-10T12:00:00Z"),
  ...m,
});

const cmp = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);
const val = (v: any) => (v instanceof Date ? v.getTime() : v);
/** The slice of a Prisma where the list and the export use. */
function matches(where: any, r: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries<any>(where)) {
    if (k === "AND") {
      if (!(v as any[]).every((w) => matches(w, r))) return false;
    } else if (k === "OR") {
      if (!(v as any[]).some((w) => matches(w, r))) return false;
    } else if (v && typeof v === "object" && !(v instanceof Date)) {
      const x = val(r[k]);
      if ("gte" in v && !(x >= val(v.gte))) return false;
      if ("lte" in v && !(x <= val(v.lte))) return false;
      if ("lt" in v && !(x < val(v.lt))) return false;
      if ("gt" in v && !(x > val(v.gt))) return false;
    } else if (val(r[k]) !== val(v)) return false;
  }
  return true;
}
function order(orderBy: any, a: any, b: any): number {
  for (const o of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    const [k, dir] = Object.entries<any>(o)[0];
    const c = cmp(val(a[k]), val(b[k]));
    if (c !== 0) return dir === "desc" ? -c : c;
  }
  return 0;
}

function build(opts: { movements: M[]; cap?: number; batch?: number; failOnCall?: number }) {
  const prisma: any = createMockPrisma();
  prisma.getTenantId.mockReturnValue(TENANT_A);
  let calls = 0;
  const findMany = jest.fn(async (args: any) => {
    calls += 1;
    if (opts.failOnCall && calls === opts.failOnCall) throw new Error("db went away");
    return opts.movements
      .filter((m) => m.tenantId === TENANT_A && matches(args.where, m))
      .sort((a, b) => order(args.orderBy, a, b))
      .slice(args.skip ?? 0, (args.skip ?? 0) + args.take)
      .map((m) => ({
        ...m,
        product: {
          id: m.productId,
          name: `Product ${m.productId}`,
          sku: `SKU-${m.productId}`,
          unit: "each",
        },
        supplier: null,
        performedBy: { id: "u1", username: "alice" },
      }));
  });
  const scoped = {
    stockMovement: {
      findMany,
      count: jest.fn(
        async (args: any) =>
          opts.movements.filter((m) => m.tenantId === TENANT_A && matches(args.where, m)).length,
      ),
    },
  };
  prisma.forTenant = jest.fn().mockReturnValue(scoped);
  // The leak: an unscoped read returns every tenant's rows.
  prisma.stockMovement.findMany.mockImplementation(async () => opts.movements);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const exporter = new InventoryMovementsExportService(prisma, audit as any, opts.cap, opts.batch);
  return { exporter, prisma, scoped, findMany, audit };
}

async function run(exporter: InventoryMovementsExportService, query: any = {}) {
  const { csv, filename } = await exporter.prepare(query, { userId: "u1", ip: "1.2.3.4" });
  let out = "";
  for await (const chunk of csv) out += chunk;
  return { out, filename };
}
const rows = (out: string) =>
  out
    .replace(CSV_BOM, "")
    .split("\r\n")
    .filter((r) => r !== "");
const ids = (out: string) =>
  rows(out)
    .slice(1)
    .filter((r) => !r.startsWith("#"))
    .map((r) => r.split(",")[0]);

describe("movements export.csv", () => {
  it("BOM first, then the header; one row per movement, newest first (effectiveAt, createdAt, id desc)", async () => {
    const { exporter } = build({
      movements: [
        mv({ id: "a", effectiveAt: t("2026-09-01T00:00:00Z") }),
        mv({ id: "b", effectiveAt: t("2026-09-05T00:00:00Z") }),
      ],
    });
    const { out, filename } = await run(exporter);
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(rows(out)[0]).toBe(MOVEMENTS_EXPORT_HEADER.join(","));
    expect(ids(out)).toEqual(["2026-09-05T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
    expect(filename).toMatch(/^inventory-movements-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("the list and the export share ONE where builder: same filters -> the same rows", async () => {
    const movements = [
      mv({ id: "1", productId: "p1", type: "PURCHASE", effectiveAt: t("2026-09-01T10:00:00Z") }),
      mv({ id: "2", productId: "p1", type: "ADJUSTMENT", effectiveAt: t("2026-09-02T10:00:00Z") }),
      mv({ id: "3", productId: "p2", type: "PURCHASE", effectiveAt: t("2026-09-03T10:00:00Z") }),
      mv({ id: "4", productId: "p1", type: "PURCHASE", effectiveAt: t("2026-09-03T23:30:00Z") }),
      mv({ id: "5", productId: "p1", type: "PURCHASE", effectiveAt: t("2026-09-04T00:00:01Z") }),
    ];
    for (const filters of [
      {},
      { productId: "p1" },
      { type: "PURCHASE" },
      { productId: "p1", type: "PURCHASE", from: "2026-09-01", to: "2026-09-03" },
      { from: "2026-09-03", to: "2026-09-03" },
    ]) {
      const { exporter, prisma, scoped } = build({ movements });
      const svc = new InventoryService(prisma, {} as any);
      const list = await svc.listMovements({ ...filters, limit: "100" } as any);
      const { out } = await run(exporter, filters);
      const listed = list.data.map((m: any) => m.effectiveAt.toISOString());
      expect(ids(out)).toEqual(listed);
      // Both handed the delegate a where built by the one builder.
      const listWhere = scoped.stockMovement.findMany.mock.calls[0][0].where;
      expect(listWhere).toEqual(buildMovementsWhere(filters as any));
    }
  });

  it("buildMovementsWhere: productId/type, effectiveAt from..to with the end day inclusive to 23:59:59.999Z", () => {
    expect(
      buildMovementsWhere({
        productId: "p",
        type: "PURCHASE" as any,
        from: "2026-09-01",
        to: "2026-09-03",
      }),
    ).toEqual({
      productId: "p",
      type: "PURCHASE",
      effectiveAt: { gte: new Date("2026-09-01"), lte: new Date("2026-09-03T23:59:59.999Z") },
    });
    expect(buildMovementsWhere({})).toEqual({});
  });

  it("role: OPERATOR only — the list admits DRIVER, the export must not", () => {
    const reflector = new Reflector();
    const proto = InventoryController.prototype as Record<string, any>;
    expect(typeof proto.exportMovementsCsv).toBe("function");
    const effective = reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      proto.exportMovementsCsv,
      InventoryController,
    ]);
    expect(effective).toEqual([UserRole.OPERATOR]);
  });

  it("an inverted window is a JSON 400 BEFORE any byte is produced", async () => {
    const { exporter, findMany } = build({ movements: [mv({ id: "a" })] });
    await expect(
      exporter.prepare({ from: "2026-09-10", to: "2026-09-01" } as any, { userId: "u1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("cursor across chunks: equal effectiveAt and createdAt never duplicates or skips (batch 2)", async () => {
    const same = t("2026-09-10T12:00:00Z");
    const movements = ["a", "b", "c", "d", "e"].map((id) =>
      mv({ id, effectiveAt: same, createdAt: same, quantity: Number(id.charCodeAt(0)) }),
    );
    const { exporter, findMany } = build({ movements, batch: 2 });
    const { out } = await run(exporter);
    const qtys = rows(out)
      .slice(1)
      .map((r) => r.split(",")[5]);
    expect(qtys).toEqual(["101", "100", "99", "98", "97"]); // e d c b a — id desc
    expect(findMany.mock.calls.length).toBeGreaterThan(1);
  });

  it("the cap writes a truncation row and audits truncated:true", async () => {
    const movements = [1, 2, 3].map((i) =>
      mv({ id: `m${i}`, effectiveAt: t(`2026-09-0${i}T00:00:00Z`) }),
    );
    const { exporter, audit } = build({ movements, cap: 2, batch: 10 });
    const { out } = await run(exporter);
    expect(ids(out)).toHaveLength(2);
    expect(rows(out).at(-1)).toBe("# truncated at 2 rows");
    expect(audit.log.mock.calls[0][0].meta).toMatchObject({ rowCount: 2, truncated: true });
  });

  it("a mid-stream failure ends the file with '# export failed' and audits failed:true", async () => {
    const movements = [1, 2, 3].map((i) =>
      mv({ id: `m${i}`, effectiveAt: t(`2026-09-0${i}T00:00:00Z`) }),
    );
    const { exporter, audit } = build({ movements, batch: 2, failOnCall: 2 });
    const { out } = await run(exporter);
    expect(rows(out).at(-1)).toBe("# export failed: the file is incomplete");
    expect(audit.log.mock.calls[0][0].meta).toMatchObject({ failed: true });
  });

  it("cells opening with = + - @ are neutralised (formula injection), commas/quotes are escaped", async () => {
    const { exporter } = build({
      movements: [mv({ id: "x", reference: '=HYPERLINK("http://x")', notes: '+1,"hi"' })],
    });
    const { out } = await run(exporter);
    const line = rows(out)[1];
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(line).toContain(`"'+1,""hi"""`);
  });

  it("tenant isolation: reads go through forTenant(), never the unscoped delegate", async () => {
    const { exporter, prisma, scoped } = build({
      movements: [mv({ id: "mine" }), mv({ id: "theirs", tenantId: TENANT_B })],
    });
    const { out } = await run(exporter);
    expect(rows(out).slice(1)).toHaveLength(1);
    expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
    expect(scoped.stockMovement.findMany).toHaveBeenCalled();
  });

  it("one audit row per export: action INVENTORY_MOVEMENTS_EXPORT_CSV, filters without paging fields", async () => {
    const { exporter, audit } = build({ movements: [mv({ id: "a" })] });
    await run(exporter, { productId: "p1", page: "3", limit: "5" });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT_A,
      userId: "u1",
      action: "INVENTORY_MOVEMENTS_EXPORT_CSV",
      entityType: "StockMovement",
      meta: { rowCount: 1, filters: { productId: "p1" } },
    });
  });
});
