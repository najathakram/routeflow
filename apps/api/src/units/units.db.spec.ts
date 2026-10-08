/**
 * Units U-1 — DB lane for the pieces a mocked prisma cannot prove: the single productCount query
 * (DISTINCT across ProductUnit.label via tenantUnitId and the three Product text columns, matched by
 * nameKey) and the rename transaction through the REAL tenant-wrapped `tenantTransaction` proxy,
 * including the all-or-nothing collision refusal and tenant isolation.
 *
 * Run via `npm run local:test:db` against the compose Postgres. Every tenant is a throwaway
 * `qa-unit-<run>-*` slug approved by `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { UnitsService } from "./units.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const user = { sub: "u-db-spec", username: "db-spec" } as JwtPayload;

describeDb("tenant units against real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: UnitsService;

  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-unit-${run}-a`, "units.db.spec.ts");
  const slugB = assertTestTenant(`qa-unit-${run}-b`, "units.db.spec.ts");
  let A: string;
  let B: string;

  const asA = <T>(fn: () => Promise<T>) => ctx.run(A, fn);
  const asB = <T>(fn: () => Promise<T>) => ctx.run(B, fn);

  const product = (
    tenantId: string,
    name: string,
    over: { baseUnitLabel?: string | null; packLabel?: string | null; unit?: string } = {},
  ) =>
    raw.product.create({
      data: { name, unit: over.unit ?? "Each", pricePerUnit: "1.00", tenantId, ...over },
    });
  const level = (
    tenantId: string,
    productId: string,
    label: string,
    factorToBase: number,
    tenantUnitId: string | null,
  ) => raw.productUnit.create({ data: { tenantId, productId, label, factorToBase, tenantUnitId } });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new UnitsService(prisma, new AuditService(prisma));
    A = (await raw.tenant.create({ data: { slug: slugA, name: `Units spec ${slugA}` } })).id;
    B = (await raw.tenant.create({ data: { slug: slugB, name: `Units spec ${slugB}` } })).id;
  }, 120_000);

  afterAll(async () => {
    for (const t of [A, B].filter(Boolean)) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.productUnit.deleteMany({ where: { tenantId: t } });
      await raw.product.deleteMany({ where: { tenantId: t } });
      await raw.tenantUnit.deleteMany({ where: { tenantId: t } });
      await raw.tenant.deleteMany({ where: { id: t } });
    }
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  beforeEach(async () => {
    for (const t of [A, B]) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.productUnit.deleteMany({ where: { tenantId: t } });
      await raw.product.deleteMany({ where: { tenantId: t } });
      await raw.tenantUnit.deleteMany({ where: { tenantId: t } });
    }
  });

  it("productCount is DISTINCT across the level label and the base / pack / unit text, matched by nameKey", async () => {
    const caseUnit = await asA(() => service.create({ name: "Case" }, user));
    const p1 = await product(A, "P1", { packLabel: " CASE ", unit: "case" }); // pack + unit: ONE product
    const p2 = await product(A, "P2", { baseUnitLabel: "Case" });
    const p3 = await product(A, "P3"); // reached only through a linked level
    await product(A, "P4", { unit: "Box" }); // not a Case product
    await level(A, p3.id, "Case", 12, caseUnit.id);
    await level(A, p3.id, "Case2", 24, null); // unlinked level never counts
    await product(B, "Other tenant", { unit: "Case" }); // another tenant's text never counts
    void p1;
    void p2;
    const [row] = (await asA(() => service.list(false))).filter((u) => u.id === caseUnit.id);
    expect(row.productCount).toBe(3);
  });

  it("a unit named Div keys as div: the SQL trim never eats the letter v (E-strings have no \\v)", async () => {
    const div = await asA(() => service.create({ name: "Div" }, user));
    const p1 = await product(A, "P1", { unit: "Div" });
    const p2 = await product(A, "P2", { packLabel: " div " });
    await product(A, "P3", { unit: "Di" }); // what a v-eating trim would match
    const [row] = (await asA(() => service.list(false))).filter((u) => u.id === div.id);
    expect(row.productCount).toBe(2);
    const out = await asA(() => service.update(div.id, { name: "Dive" }, user));
    expect(out.productsUpdated).toBe(2);
    expect((await raw.product.findUnique({ where: { id: p1.id } }))?.unit).toBe("Dive");
    expect((await raw.product.findUnique({ where: { id: p2.id } }))?.packLabel).toBe("Dive");
  });

  it("an NFD and an NFC spelling of one word are ONE unit, counted and renamed through the SQL NFC fold", async () => {
    const nfc = "Caf\u00e9";
    const nfd = "Cafe\u0301";
    const unit = await asA(() => service.create({ name: nfc }, user));
    const again = await asA(() => service.create({ name: nfd }, user));
    expect(again.id).toBe(unit.id);
    expect(await raw.tenantUnit.count({ where: { tenantId: A } })).toBe(1);
    const p1 = await product(A, "P1", { unit: nfd }); // stored NFD, unit stored NFC
    const p2 = await product(A, "P2", { packLabel: ` ${nfc} ` });
    const [row] = (await asA(() => service.list(false))).filter((u) => u.id === unit.id);
    expect(row.productCount).toBe(2);
    const out = await asA(() => service.update(unit.id, { name: "Carton" }, user));
    expect(out.productsUpdated).toBe(2);
    expect((await raw.product.findUnique({ where: { id: p1.id } }))?.unit).toBe("Carton");
    expect((await raw.product.findUnique({ where: { id: p2.id } }))?.packLabel).toBe("Carton");
  });

  it("rename rewrites level labels and the three text columns in one go and returns the distinct count", async () => {
    const caseUnit = await asA(() => service.create({ name: "Case" }, user));
    const p1 = await product(A, "P1", { packLabel: "case", unit: "Case" });
    const p2 = await product(A, "P2", { baseUnitLabel: "Case" });
    const p3 = await product(A, "P3");
    await level(A, p3.id, "Case", 12, caseUnit.id);
    const out = await asA(() => service.update(caseUnit.id, { name: "Carton" }, user));
    expect(out.productsUpdated).toBe(3);
    expect(out.unit.name).toBe("Carton");
    expect(await raw.product.findUnique({ where: { id: p1.id } })).toMatchObject({
      packLabel: "Carton",
      unit: "Carton",
    });
    expect((await raw.product.findUnique({ where: { id: p2.id } }))?.baseUnitLabel).toBe("Carton");
    expect((await raw.productUnit.findFirst({ where: { productId: p3.id } }))?.label).toBe(
      "Carton",
    );
    expect(
      await raw.auditLog.count({ where: { tenantId: A, action: "tenant_unit.renamed" } }),
    ).toBe(1);
  });

  it("a collision refuses the whole rename: nothing at all changes", async () => {
    const caseUnit = await asA(() => service.create({ name: "Case" }, user));
    const ok = await product(A, "Fine", { packLabel: "Case" });
    const bad = await product(A, "Gift Box");
    await level(A, bad.id, "Case", 12, caseUnit.id);
    await level(A, bad.id, "Carton", 24, null);
    const err = await asA(() => service.update(caseUnit.id, { name: "Carton" }, user)).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().products).toEqual([{ id: bad.id, name: "Gift Box" }]);
    expect((await raw.product.findUnique({ where: { id: ok.id } }))?.packLabel).toBe("Case");
    expect((await raw.tenantUnit.findUnique({ where: { id: caseUnit.id } }))?.name).toBe("Case");
    expect(await raw.productUnit.count({ where: { productId: bad.id, label: "Case" } })).toBe(1);
  });

  it("renaming onto an existing name (archived too) is 409; a case-only change is allowed", async () => {
    const a = await asA(() => service.create({ name: "Case" }, user));
    const b = await asA(() => service.create({ name: "Box" }, user));
    await asA(() => service.update(b.id, { archived: true }, user));
    await expect(asA(() => service.update(a.id, { name: "BOX" }, user))).rejects.toBeInstanceOf(
      ConflictException,
    );
    const out = await asA(() => service.update(a.id, { name: "CASE" }, user));
    expect(out.unit.name).toBe("CASE");
  });

  it("archive and restore touch no product row; adding an archived name restores the SAME row", async () => {
    const u = await asA(() => service.create({ name: "Pallet" }, user));
    const p = await product(A, "P", { unit: "Pallet" });
    const before = await raw.product.findUnique({ where: { id: p.id } });
    await asA(() => service.update(u.id, { archived: true }, user));
    expect(await raw.product.findUnique({ where: { id: p.id } })).toEqual(before);
    expect(await asA(() => service.list(false))).toEqual([]);
    const again = await asA(() => service.create({ name: "pallet" }, user));
    expect(again.id).toBe(u.id);
    expect(again.archivedAt).toBeNull();
    expect(await raw.tenantUnit.count({ where: { tenantId: A } })).toBe(1);
  });

  it("two concurrent adds of one name end as one row", async () => {
    const [x, y] = await Promise.all([
      asA(() => service.create({ name: "Tray" }, user)),
      asA(() => service.create({ name: "tray" }, user)),
    ]);
    expect(x.id).toBe(y.id);
    expect(await raw.tenantUnit.count({ where: { tenantId: A } })).toBe(1);
  });

  it("another tenant's unit is a 404 and stays untouched", async () => {
    const mine = await asB(() => service.create({ name: "Case" }, user));
    await expect(asA(() => service.update(mine.id, { name: "X" }, user))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      asA(() => service.update(mine.id, { archived: true }, user)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await raw.tenantUnit.findUnique({ where: { id: mine.id } }))?.archivedAt).toBeNull();
    expect(await asA(() => service.list(true))).toEqual([]);
  });
});
