/**
 * K1 DB-lane proof for the units v2 price write (real Postgres, throwaway `qa-*` tenants). Collected only by
 * `jest.db.config.js` (`npm run local:test:db`); `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * Proves what the mocks cannot: the product row lock serialises two saves, T28b (a legacy write that skips the
 * revision bump is caught by the state token), the customer-cell compare-and-set rolls the product write back,
 * revision + 1 exactly once, ONE audit row, undo once, the CustomerUnitPrice price > 0 CHECK, and tenant isolation.
 * The PLAN_GATE 403 is the controller-level RequirePlanFlag (units-prices-v2-flag.spec.ts and
 * product-pricing.controller.spec.ts pin it).
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ProductPriceGridService } from "./product-price-grid.service";
import { ProductPriceWriteService } from "./product-price-write.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "product-price-write.db.spec.ts";
const run = randomUUID().slice(0, 8);
let seq = 0;

type Seed = { tenantId: string; customerId: string; productId: string; unitId: string };

describeDb("units v2 price write - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let grid: ProductPriceGridService;
  let writes: ProductPriceWriteService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductPriceGridService,
        ProductPriceWriteService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    grid = module.get(ProductPriceGridService);
    writes = module.get(ProductPriceWriteService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.customerUnitPrice.deleteMany({ where: { tenantId } });
        await prisma.productUnit.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.customer.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch(() => {
        // Best-effort cleanup must never mask a test's own result.
      });
    }
    await prisma?.$disconnect();
  });

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function seed(label: string): Promise<Seed> {
    seq += 1;
    const slug = assertTestTenant(`qa-pwrite-${run}-${seq}-${label}`, FILE);
    const tenant = await prisma.tenant.create({ data: { slug, name: `pwrite ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `buyer-${run}-${seq}@example.test`,
        username: `buyer-${run}-${seq}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "Acme Wholesale",
        contactName: "Acme Buyer",
        tenantId: tenant.id,
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        name: "Write Box",
        sku: `WR-${randomUUID().slice(0, 6)}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: "12.00",
        priceTier2: "11.00",
      },
    });
    const unit = await prisma.productUnit.create({
      data: { tenantId: tenant.id, productId: product.id, label: "Case", factorToBase: 72 },
    });
    return { tenantId: tenant.id, customerId: customer.id, productId: product.id, unitId: unit.id };
  }

  const readGrid = (t: Seed) => inTenant(t.tenantId, () => grid.get(t.productId));
  const stateOf = (g: { revision: number; priceState: string }) => ({
    expectedRevision: g.revision,
    expectedPriceState: g.priceState,
  });
  const auditRows = (t: Seed) =>
    prisma.auditLog.findMany({
      where: { tenantId: t.tenantId, entityType: "Product", entityId: t.productId },
    });
  const seedCustomerPrice = (t: Seed, price: string) =>
    prisma.customerUnitPrice.create({
      data: {
        tenantId: t.tenantId,
        customerId: t.customerId,
        productId: t.productId,
        unitRef: "pack",
        price,
      },
    });

  it("saves in one transaction: columns written, revision + 1 exactly once, ONE audit row", async () => {
    const t = await seed("save");
    const g = await readGrid(t);
    const res = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g), patches: [{ ref: "pack", tier: 3, to: 10.5 }] },
        null,
      ),
    );
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(row.priceTier3)).toBe(10.5);
    expect(row.priceRevision).toBe(g.revision + 1);
    expect(res.revision).toBe(g.revision + 1);
    const audits = await auditRows(t);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe(AUDIT_ACTIONS.PRODUCT_PRICES_SAVED);
    expect(res.auditId).toBe(audits[0].id);
  });

  it("T28b: a legacy price write that skips the revision bump is 409 and nothing is written", async () => {
    const t = await seed("t28b");
    const g = await readGrid(t);
    await prisma.product.update({ where: { id: t.productId }, data: { priceTier4: "9.00" } });
    const err = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g), patches: [{ ref: "pack", tier: 3, to: 10.5 }] },
        null,
      ),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(row.priceTier3)).toBe(0);
    expect(row.priceRevision).toBe(g.revision);
    expect(await auditRows(t)).toHaveLength(0);
  });

  it("two saves from the same grid: the row lock lets exactly one win", async () => {
    const t = await seed("race");
    const g = await readGrid(t);
    const attempt = (tier: number, to: number) =>
      inTenant(t.tenantId, () =>
        writes.save(t.productId, { ...stateOf(g), patches: [{ ref: "pack", tier, to }] }, null),
      ).then(
        () => "ok",
        (e) => e.getResponse?.().code ?? String(e),
      );
    const out = await Promise.all([attempt(3, 10), attempt(4, 9)]);
    expect([...out].sort()).toEqual([API_ERROR_CODES.LADDER_REVISION_STALE, "ok"].sort());
    expect(await auditRows(t)).toHaveLength(1);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(row.priceRevision).toBe(g.revision + 1);
  });

  it("customer moves: a cell that moved is 409 and the product write rolls back with it", async () => {
    const t = await seed("cust");
    await seedCustomerPrice(t, "12.00");
    const g = await readGrid(t);
    const body = (from: number) => ({
      ...stateOf(g),
      patches: [{ ref: "pack", tier: 3, to: 10.5 }],
      customerMoves: [{ customerId: t.customerId, ref: "pack", tier: 1, from, to: 13 }],
    });
    const err = await inTenant(t.tenantId, () => writes.save(t.productId, body(11), null)).catch(
      (e) => e,
    );
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(row.priceTier3)).toBe(0);
    expect(await auditRows(t)).toHaveLength(0);

    await inTenant(t.tenantId, () => writes.save(t.productId, body(12), null));
    const cup = await prisma.customerUnitPrice.findFirstOrThrow({
      where: { customerId: t.customerId },
    });
    expect(Number(cup.price)).toBe(13);
  });

  it("undo restores product and customer cells once; a second undo is PRICE_UNDO_UNAVAILABLE", async () => {
    const t = await seed("undo");
    await seedCustomerPrice(t, "12.00");
    const g = await readGrid(t);
    const saved = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        {
          ...stateOf(g),
          patches: [{ ref: "pack", tier: 3, to: 10.5 }],
          customerMoves: [{ customerId: t.customerId, ref: "pack", tier: 1, from: 12, to: 13 }],
        },
        null,
      ),
    );
    const g2 = await readGrid(t);
    await inTenant(t.tenantId, () =>
      writes.undo(t.productId, { auditId: saved.auditId, ...stateOf(g2) }, null),
    );
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(row.priceTier3)).toBe(0);
    expect(row.priceRevision).toBe(g.revision + 2);
    const cup = await prisma.customerUnitPrice.findFirstOrThrow({
      where: { customerId: t.customerId },
    });
    expect(Number(cup.price)).toBe(12);
    expect((await auditRows(t)).map((a) => a.action).sort()).toEqual(
      [AUDIT_ACTIONS.PRODUCT_PRICES_SAVED, AUDIT_ACTIONS.PRODUCT_PRICES_UNDONE].sort(),
    );

    const g3 = await readGrid(t);
    const again = await inTenant(t.tenantId, () =>
      writes.undo(t.productId, { auditId: saved.auditId, ...stateOf(g3) }, null),
    ).catch((e) => e);
    expect(again.getResponse().code).toBe(API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE);
  });

  it("the CustomerUnitPrice CHECK refuses a price of 0 even past the service", async () => {
    const t = await seed("check");
    await expect(seedCustomerPrice(t, "0.00")).rejects.toThrow();
  });

  it("a unit edited between the client read and the save is 409 and nothing is written", async () => {
    const t = await seed("unit-edit");
    const g = await readGrid(t);
    await prisma.productUnit.update({ where: { id: t.unitId }, data: { price: "70.00" } });
    const err = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g), patches: [{ ref: "pack", tier: 3, to: 10.5 }] },
        null,
      ),
    ).catch((e) => e);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(row.priceTier3)).toBe(0);
    expect(row.priceRevision).toBe(g.revision);
    expect(await auditRows(t)).toHaveLength(0);
  });

  it("a unit deleted between the client read and the save is 409, never a 500", async () => {
    const t = await seed("unit-del");
    const g = await readGrid(t);
    await prisma.productUnit.delete({ where: { id: t.unitId } });
    const err = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g), patches: [{ ref: t.unitId, tier: 1, to: 66 }] },
        null,
      ),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    expect(await auditRows(t)).toHaveLength(0);
  });

  it("a save waits for a concurrent unit write that holds the product-units advisory lock", async () => {
    const t = await seed("adv-lock");
    const g = await readGrid(t);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    // The same lock ProductUnitsService.locked takes, held while it edits the unit.
    const unitWriter = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext(${t.productId}))`;
      locked();
      await held;
      await tx.productUnit.update({ where: { id: t.unitId }, data: { price: "70.00" } });
    });
    await lockTaken;
    const save = inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g), patches: [{ ref: "pack", tier: 3, to: 10.5 }] },
        null,
      ),
    ).catch((e) => e);
    const early = await Promise.race([
      save.then(() => "done"),
      new Promise((r) => setTimeout(() => r("waiting"), 800)),
    ]);
    expect(early).toBe("waiting");
    release();
    await unitWriter;
    const err = await save;
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(row.priceTier3)).toBe(0);
  });

  it("a failure AFTER a partial write rolls everything back (P2002 after product.update)", async () => {
    const t = await seed("rollback");
    const g = await readGrid(t);
    const real = prisma.tenantTransaction.bind(prisma);
    const spy = jest.spyOn(prisma, "tenantTransaction").mockImplementationOnce(((
      fn: (tx: any) => Promise<unknown>,
      opts?: unknown,
    ) =>
      real(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === "customerUnitPrice") {
                  return {
                    findMany: target.customerUnitPrice.findMany.bind(target.customerUnitPrice),
                    create: async () => {
                      throw Object.assign(new Error("unique"), { code: "P2002" });
                    },
                  };
                }
                const v = target[key];
                return typeof v === "function" ? v.bind(target) : v;
              },
            }),
          ),
        opts as never,
      )) as never);
    const err = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        {
          ...stateOf(g),
          patches: [{ ref: "pack", tier: 3, to: 10.5 }],
          customerMoves: [{ customerId: t.customerId, ref: "pack", tier: 1, from: null, to: 13 }],
        },
        null,
      ),
    ).catch((e) => e);
    spy.mockRestore();
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(row.priceTier3)).toBe(0);
    expect(row.priceRevision).toBe(g.revision);
    expect(await auditRows(t)).toHaveLength(0);
    expect(await prisma.customerUnitPrice.count({ where: { customerId: t.customerId } })).toBe(0);
  });

  it("an undo refused for a changed customer cell lists the conflict and writes nothing", async () => {
    const t = await seed("undo-conflict");
    await seedCustomerPrice(t, "12.00");
    const g = await readGrid(t);
    const saved = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        {
          ...stateOf(g),
          patches: [{ ref: "pack", tier: 3, to: 10.5 }],
          customerMoves: [{ customerId: t.customerId, ref: "pack", tier: 1, from: 12, to: 13 }],
        },
        null,
      ),
    );
    await prisma.customerUnitPrice.updateMany({
      where: { customerId: t.customerId },
      data: { price: "15.00" },
    });
    const g2 = await readGrid(t);
    const err = await inTenant(t.tenantId, () =>
      writes.undo(t.productId, { auditId: saved.auditId, ...stateOf(g2) }, null),
    ).catch((e) => e);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    expect(err.getResponse().conflicts).toEqual([
      { customerId: t.customerId, ref: "pack", tier: 1, expected: 13, current: 15 },
    ]);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(row.priceTier3)).toBe(10.5);
    expect(await auditRows(t)).toHaveLength(1);

    // SA-809 U1/U2/U3: the confirm skips the reported cell by value and restores the rest in one write.
    const skip = [{ customerId: t.customerId, ref: "pack", seen: 15 }];
    const bad = await inTenant(t.tenantId, () =>
      writes.undo(
        t.productId,
        { auditId: saved.auditId, ...stateOf(g2), skip: [{ ...skip[0], ref: "u-nope" }] },
        null,
      ),
    ).catch((e) => e);
    expect(bad.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
    const done = await inTenant(t.tenantId, () =>
      writes.undo(t.productId, { auditId: saved.auditId, ...stateOf(g2), skip }, null),
    );
    expect(done.skipped).toEqual([{ customerId: t.customerId, ref: "pack", tier: 1, current: 15 }]);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(Number(after.priceTier3)).toBe(0);
    const cup = await prisma.customerUnitPrice.findFirstOrThrow({
      where: { customerId: t.customerId },
    });
    expect(Number(cup.price)).toBe(15);
  });

  it("a price on the implicit base row is 400 and mints no unit", async () => {
    const t = await seed("base");
    await prisma.productUnit.delete({ where: { id: t.unitId } });
    const g = await readGrid(t);
    const err = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g), patches: [{ ref: "base", tier: 1, to: 1.2 }] },
        null,
      ),
    ).catch((e) => e);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
    expect(await prisma.productUnit.count({ where: { productId: t.productId } })).toBe(0);
    expect(await auditRows(t)).toHaveLength(0);
  });

  it('SA-809: a Piece (factor-1) unit backs base: a patch on "base" prices that row, a customer move stores "base"', async () => {
    const t = await seed("piece");
    const piece = await prisma.productUnit.create({
      data: { tenantId: t.tenantId, productId: t.productId, label: "Piece", factorToBase: 1 },
    });
    const g = await readGrid(t);
    const res = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        {
          ...stateOf(g),
          patches: [{ ref: "base", tier: 1, to: 1.25 }],
          customerMoves: [{ customerId: t.customerId, ref: "base", tier: 1, from: null, to: 1.1 }],
        },
        null,
      ),
    );
    expect(res.revision).toBe(g.revision + 1);
    const row = await prisma.productUnit.findUniqueOrThrow({ where: { id: piece.id } });
    expect(Number(row.price)).toBe(1.25);
    const cup = await prisma.customerUnitPrice.findFirstOrThrow({
      where: { productId: t.productId, customerId: t.customerId },
    });
    expect(cup.unitRef).toBe("base");
    expect(Number(cup.price)).toBe(1.1);
    // The same patch sent with the row's own id is the same level: canonicalized, one cell.
    const g2 = await readGrid(t);
    await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g2), patches: [{ ref: piece.id, tier: 1, to: 1.3 }] },
        null,
      ),
    );
    expect(
      Number((await prisma.productUnit.findUniqueOrThrow({ where: { id: piece.id } })).price),
    ).toBe(1.3);
    expect(await prisma.productUnit.count({ where: { productId: t.productId } })).toBe(2);
  });

  it("a product of another tenant is a 404 and nothing is written", async () => {
    const a = await seed("iso-a");
    const b = await seed("iso-b");
    const g = await readGrid(a);
    const err = await inTenant(b.tenantId, () =>
      writes.save(
        a.productId,
        { ...stateOf(g), patches: [{ ref: "pack", tier: 3, to: 10.5 }] },
        null,
      ),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: a.productId } });
    expect(Number(row.priceTier3)).toBe(0);
  });
});
