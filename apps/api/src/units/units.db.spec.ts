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
import { unitNameKey } from "./piece-words";
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

  /** A customer of `tenantId` (orders and invoices need one). */
  const customerOf = async (tenantId: string) => {
    const tag = randomUUID().slice(0, 8);
    const u = await raw.user.create({
      data: { email: `${tag}@example.test`, username: `u-${tag}`, role: "CUSTOMER", tenantId },
    });
    return raw.customer.create({
      data: { userId: u.id, businessName: `Units ${tag}`, contactName: "T", tenantId },
    });
  };
  /**
   * One sold line: `kind` order puts it on an OrderItem under a new order of `orderTenantId`, invoice on an
   * InvoiceItem under a new invoice. The item carries the SAME tenantId as its parent (the T6 NOT NULL
   * guards refuse a NULL one); the production check joins through the parent either way. `productId` may
   * belong to ANOTHER tenant (isolation case).
   */
  const line = async (
    kind: "order" | "invoice",
    orderTenantId: string,
    productId: string,
    unitLabel: string,
    unitsPerBox: number | null,
  ) => {
    const c = await customerOf(orderTenantId);
    if (kind === "order") {
      const order = await raw.order.create({
        data: {
          customerId: c.id,
          status: "PENDING",
          subtotal: "1.00",
          total: "1.00",
          tenantId: orderTenantId,
        },
      });
      return raw.orderItem.create({
        data: {
          orderId: order.id,
          tenantId: orderTenantId,
          productId,
          qty: "1",
          // The unitLine split CHECK: a unit line with a pack size > 1 and qty > 0 must say boxes/pieces.
          boxes: 1,
          unitPrice: "1.00",
          unitLabel,
          unitsPerBox,
        },
      });
    }
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-UNITS-${randomUUID().slice(0, 8)}`,
        customerId: c.id,
        subtotal: "1.00",
        total: "1.00",
        tenantId: orderTenantId,
      },
    });
    return raw.invoiceItem.create({
      data: {
        invoiceId: invoice.id,
        tenantId: orderTenantId,
        productId,
        description: "line",
        qty: "1",
        boxes: 1,
        unitPrice: "1.00",
        subtotal: "1.00",
        unitLabel,
        unitsPerBox,
      },
    });
  };

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
    const tenants = [A, B].filter(Boolean);
    // Sold lines first, for BOTH tenants: the isolation case seeds a tenant-B line that points at a
    // tenant-A product, so A's products cannot be deleted while B's lines still exist.
    for (const t of tenants) {
      await raw.invoiceItem.deleteMany({ where: { invoice: { tenantId: t } } });
      await raw.orderItem.deleteMany({ where: { order: { tenantId: t } } });
    }
    for (const t of tenants) {
      await raw.auditLog.deleteMany({ where: { tenantId: t } });
      await raw.invoice.deleteMany({ where: { tenantId: t } });
      await raw.order.deleteMany({ where: { tenantId: t } });
      await raw.customer.deleteMany({ where: { tenantId: t } });
      await raw.user.deleteMany({ where: { tenantId: t } });
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
      await raw.invoiceItem.deleteMany({ where: { invoice: { tenantId: t } } });
      await raw.invoice.deleteMany({ where: { tenantId: t } });
      await raw.orderItem.deleteMany({ where: { order: { tenantId: t } } });
      await raw.order.deleteMany({ where: { tenantId: t } });
      await raw.customer.deleteMany({ where: { tenantId: t } });
      await raw.user.deleteMany({ where: { tenantId: t } });
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

  it("the SQL key trims every character JS trim() does: an ideographic space (U+3000) around Case still counts and renames", async () => {
    const u = await asA(() => service.create({ name: "Case" }, user));
    const p1 = await product(A, "P1", { unit: "Case\u3000" });
    const p2 = await product(A, "P2", { packLabel: "\ufeff\u2003Case\u202f" });
    const [row] = (await asA(() => service.list(false))).filter((x) => x.id === u.id);
    expect(row.productCount).toBe(2);
    const out = await asA(() => service.update(u.id, { name: "Carton" }, user));
    expect(out.productsUpdated).toBe(2);
    expect((await raw.product.findUnique({ where: { id: p1.id } }))?.unit).toBe("Carton");
    expect((await raw.product.findUnique({ where: { id: p2.id } }))?.packLabel).toBe("Carton");
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
  describe("rename vs sold lines (LINES_AT_OTHER_SIZE), through the parent order / invoice", () => {
    const caseAt12 = async () => {
      const caseUnit = await asA(() => service.create({ name: "Case" }, user));
      const p = await product(A, "Mug");
      await level(A, p.id, "Case", 12, caseUnit.id);
      return { caseUnit, p };
    };
    const refusal = (caseUnitId: string, name: string) =>
      asA(() => service.update(caseUnitId, { name }, user)).catch((e) => e);

    it.each(["order", "invoice"] as const)(
      "a %s line already saying Crate at size 6 refuses Case(12) -> Crate (409, nothing changed)",
      async (kind) => {
        const { caseUnit, p } = await caseAt12();
        await line(kind, A, p.id, "Crate", 6);
        const err = await refusal(caseUnit.id, "Crate");
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toEqual(
          expect.objectContaining({
            code: "UNIT_RENAME_COLLISION",
            reason: "LINES_AT_OTHER_SIZE",
            products: [{ id: p.id, name: "Mug" }],
          }),
        );
        expect((await raw.tenantUnit.findUnique({ where: { id: caseUnit.id } }))?.name).toBe(
          "Case",
        );
        expect((await raw.productUnit.findFirst({ where: { productId: p.id } }))?.label).toBe(
          "Case",
        );
      },
    );

    it.each(["order", "invoice"] as const)(
      "a %s line saying Crate at the SAME size 12 agrees with the level: the rename goes through",
      async (kind) => {
        const { caseUnit, p } = await caseAt12();
        await line(kind, A, p.id, "crate", 12);
        const out = await asA(() => service.update(caseUnit.id, { name: "Crate" }, user));
        expect(out.unit.name).toBe("Crate");
        expect((await raw.productUnit.findFirst({ where: { productId: p.id } }))?.label).toBe(
          "Crate",
        );
      },
    );

    it("a line with no size snapshot counts as a different size", async () => {
      const { caseUnit, p } = await caseAt12();
      await line("order", A, p.id, "Crate", null);
      expect((await refusal(caseUnit.id, "Crate")).getResponse().reason).toBe(
        "LINES_AT_OTHER_SIZE",
      );
    });

    it("the NFD spelling of the new name on a line is found through the NFC key", async () => {
      const { caseUnit, p } = await caseAt12();
      await line("invoice", A, p.id, "Cafe\u0301", 6);
      expect((await refusal(caseUnit.id, "Caf\u00e9")).getResponse().reason).toBe(
        "LINES_AT_OTHER_SIZE",
      );
    });

    it("tenant isolation: a same-named line under ANOTHER tenant's order / invoice never blocks", async () => {
      const { caseUnit, p } = await caseAt12();
      await line("order", B, p.id, "Crate", 6);
      await line("invoice", B, p.id, "Crate", 6);
      const out = await asA(() => service.update(caseUnit.id, { name: "Crate" }, user));
      expect(out.unit.name).toBe("Crate");
    });
  });

  describe("sold lines snapshot their unit text (S6) and Postgres lower() agrees with unitNameKey (S7)", () => {
    it.each(["order", "invoice"] as const)(
      "a rename leaves unitLabel and unitsPerBox on an existing %s line exactly as sold",
      async (kind) => {
        const caseUnit = await asA(() => service.create({ name: "Case" }, user));
        const p = await product(A, "Mug", { unit: "Case" });
        await level(A, p.id, "Case", 12, caseUnit.id);
        const sold = await line(kind, A, p.id, "Case", 12);
        await asA(() => service.update(caseUnit.id, { name: "Carton" }, user));
        const after =
          kind === "order"
            ? await raw.orderItem.findUnique({ where: { id: sold.id } })
            : await raw.invoiceItem.findUnique({ where: { id: sold.id } });
        expect(after).toMatchObject({ unitLabel: "Case", unitsPerBox: 12 });
        // ...while the product and its level did move.
        expect((await raw.productUnit.findFirst({ where: { productId: p.id } }))?.label).toBe(
          "Carton",
        );
      },
    );

    it("Postgres lower(normalize(x, NFC)) equals unitNameKey for ÉTUI (NFC and NFD)", async () => {
      for (const word of ["\u00c9TUI", "E\u0301TUI"]) {
        const rows = await raw.$queryRaw<
          Array<{ k: string }>
        >`SELECT lower(normalize(${word}, NFC)) AS k`;
        expect(rows[0].k).toBe(unitNameKey(word));
      }
    });

    it("a product holding ÉTUI in capitals is counted and renamed under the unit Étui", async () => {
      const unit = await asA(() => service.create({ name: "\u00c9tui" }, user));
      const p = await product(A, "P1", { unit: "\u00c9TUI", packLabel: "E\u0301TUI" });
      const [row] = (await asA(() => service.list(false))).filter((u) => u.id === unit.id);
      expect(row.productCount).toBe(1);
      const out = await asA(() => service.update(unit.id, { name: "Carton" }, user));
      expect(out.productsUpdated).toBe(1);
      expect(await raw.product.findUnique({ where: { id: p.id } })).toMatchObject({
        unit: "Carton",
        packLabel: "Carton",
      });
    });
  });
});
