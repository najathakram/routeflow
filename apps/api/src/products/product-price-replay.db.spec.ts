/**
 * SA-845 (W-662, B1247) DB-lane proof: a price save or undo whose reply was lost is replayed as the SAME write when the
 * client retries it, decided by the server from the audit row it already stores. Real Postgres, throwaway `qa-*`
 * tenants; collected only by `jest.db.config.js` (`npm run local:test:db`). The JSON-path read on the audit meta is
 * proven only by executing it (the mocks accept any filter).
 */
import { ConflictException } from "@nestjs/common";
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

const FILE = "product-price-replay.db.spec.ts";
const run = randomUUID().slice(0, 8);
let seq = 0;

type Seed = { tenantId: string; productId: string; staffA: string; staffB: string };

describeDb("units v2 price write replay (SA-845) - real Postgres", () => {
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
        await prisma.productUnit.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
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
    const slug = assertTestTenant(`qa-preplay-${run}-${seq}-${label}`, FILE);
    const tenant = await prisma.tenant.create({ data: { slug, name: `preplay ${slug}` } });
    tenantIds.push(tenant.id);
    const staff = (who: string) =>
      prisma.user.create({
        data: {
          email: `${who}-${run}-${seq}@example.test`,
          username: `${who}-${run}-${seq}`,
          role: "OPERATOR",
          tenantId: tenant.id,
        },
      });
    const [a, b] = [await staff("staff-a"), await staff("staff-b")];
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        name: "Replay Box",
        sku: `RP-${randomUUID().slice(0, 6)}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: "12.00",
        priceTier2: "11.00",
      },
    });
    await prisma.productUnit.create({
      data: { tenantId: tenant.id, productId: product.id, label: "Case", factorToBase: 72 },
    });
    return { tenantId: tenant.id, productId: product.id, staffA: a.id, staffB: b.id };
  }

  const readGrid = (t: Seed) => inTenant(t.tenantId, () => grid.get(t.productId));
  const stateOf = (g: { revision: number; priceState: string }) => ({
    expectedRevision: g.revision,
    expectedPriceState: g.priceState,
  });
  const audits = (t: Seed, action: string) =>
    prisma.auditLog.findMany({
      where: { tenantId: t.tenantId, entityType: "Product", entityId: t.productId, action },
    });
  const revisionOf = async (t: Seed) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: t.productId } })).priceRevision;
  const codeOf = (e: unknown) =>
    e instanceof ConflictException ? (e.getResponse() as { code?: string }).code : String(e);

  async function firstSave(t: Seed, actor: string) {
    const g = await readGrid(t);
    const body = { ...stateOf(g), patches: [{ ref: "pack", tier: 3, to: 10.5 }] };
    const res = await inTenant(t.tenantId, () => writes.save(t.productId, body, actor));
    return { g, body, res };
  }

  it("R1: a lost save reply re-sent by the same actor is 200 replayed with the same auditId; nothing written", async () => {
    const t = await seed("r1");
    const { g, body, res } = await firstSave(t, t.staffA);
    const again = await inTenant(t.tenantId, () => writes.save(t.productId, body, t.staffA));
    expect(again).toMatchObject({ replayed: true, auditId: res.auditId, revision: g.revision + 1 });
    expect(again.undo).toEqual(res.undo);
    expect(again.grid.revision).toBe(g.revision + 1);
    expect(await audits(t, AUDIT_ACTIONS.PRODUCT_PRICES_SAVED)).toHaveLength(1);
    expect(await revisionOf(t)).toBe(g.revision + 1);
  });

  it("R2: a double click (two concurrent identical POSTs) gives one write and one replay; ONE audit row", async () => {
    const t = await seed("r2");
    const g = await readGrid(t);
    const body = { ...stateOf(g), patches: [{ ref: "pack", tier: 3, to: 10.5 }] };
    const send = () => inTenant(t.tenantId, () => writes.save(t.productId, body, t.staffA));
    const [x, y] = await Promise.all([send(), send()]);
    expect([x.replayed ?? false, y.replayed ?? false].sort()).toEqual([false, true]);
    expect(x.auditId).toBe(y.auditId);
    expect(await audits(t, AUDIT_ACTIONS.PRODUCT_PRICES_SAVED)).toHaveLength(1);
    expect(await revisionOf(t)).toBe(g.revision + 1);
  });

  it("R3: another actor's identical body stays 409 LADDER_REVISION_STALE", async () => {
    const t = await seed("r3");
    const { body } = await firstSave(t, t.staffA);
    const err = await inTenant(t.tenantId, () => writes.save(t.productId, body, t.staffB)).catch(
      (e) => e,
    );
    expect(codeOf(err)).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    expect(await audits(t, AUDIT_ACTIONS.PRODUCT_PRICES_SAVED)).toHaveLength(1);
  });

  it("R4: a second save landed after it, so the retry stays 409", async () => {
    const t = await seed("r4");
    const { body } = await firstSave(t, t.staffA);
    const g2 = await readGrid(t);
    await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g2), patches: [{ ref: "pack", tier: 4, to: 9 }] },
        t.staffB,
      ),
    );
    const err = await inTenant(t.tenantId, () => writes.save(t.productId, body, t.staffA)).catch(
      (e) => e,
    );
    expect(codeOf(err)).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    expect(await audits(t, AUDIT_ACTIONS.PRODUCT_PRICES_SAVED)).toHaveLength(2);
  });

  it("R5: a legacy writer changed the prices after it without a revision bump, so the retry stays 409", async () => {
    const t = await seed("r5");
    const { body } = await firstSave(t, t.staffA);
    await prisma.product.update({ where: { id: t.productId }, data: { priceTier4: "9.00" } });
    const err = await inTenant(t.tenantId, () => writes.save(t.productId, body, t.staffA)).catch(
      (e) => e,
    );
    expect(codeOf(err)).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
  });

  it("R6: the retry differs in one patch `to`, so it stays 409", async () => {
    const t = await seed("r6");
    const { body } = await firstSave(t, t.staffA);
    const err = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...body, patches: [{ ref: "pack", tier: 3, to: 10.51 }] },
        t.staffA,
      ),
    ).catch((e) => e);
    expect(codeOf(err)).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
  });

  it("R7: an audit row written before this change (no priceStateAfter) never replays", async () => {
    const t = await seed("r7");
    const { body } = await firstSave(t, t.staffA);
    const [row] = await audits(t, AUDIT_ACTIONS.PRODUCT_PRICES_SAVED);
    const {
      priceStateAfter: _a,
      priceStateBefore: _b,
      ...legacy
    } = row.meta as Record<string, unknown>;
    await prisma.auditLog.update({ where: { id: row.id }, data: { meta: legacy as object } });
    const err = await inTenant(t.tenantId, () => writes.save(t.productId, body, t.staffA)).catch(
      (e) => e,
    );
    expect(codeOf(err)).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
  });

  it("the save's audit meta stores priceStateBefore and priceStateAfter (the live states around the write)", async () => {
    const t = await seed("meta");
    const { g } = await firstSave(t, t.staffA);
    const after = await readGrid(t);
    const [row] = await audits(t, AUDIT_ACTIONS.PRODUCT_PRICES_SAVED);
    expect(row.meta).toMatchObject({
      priceStateBefore: g.priceState,
      priceStateAfter: after.priceState,
    });
  });

  it("R8: a lost undo reply re-sent by the same actor is 200 replayed with the undo's auditId; ONE UNDONE row", async () => {
    const t = await seed("r8");
    const { g, res } = await firstSave(t, t.staffA);
    const g2 = await readGrid(t);
    const undoBody = { auditId: res.auditId, ...stateOf(g2) };
    const undone = await inTenant(t.tenantId, () => writes.undo(t.productId, undoBody, t.staffA));
    const again = await inTenant(t.tenantId, () => writes.undo(t.productId, undoBody, t.staffA));
    expect(again).toMatchObject({
      replayed: true,
      auditId: undone.auditId,
      revision: g.revision + 2,
    });
    expect(await audits(t, AUDIT_ACTIONS.PRODUCT_PRICES_UNDONE)).toHaveLength(1);
    expect(await revisionOf(t)).toBe(g.revision + 2);
  });

  it("R8b: another actor re-sending that undo stays 409 PRICE_UNDO_UNAVAILABLE", async () => {
    const t = await seed("r8b");
    const { res } = await firstSave(t, t.staffA);
    const g2 = await readGrid(t);
    const undoBody = { auditId: res.auditId, ...stateOf(g2) };
    await inTenant(t.tenantId, () => writes.undo(t.productId, undoBody, t.staffA));
    const err = await inTenant(t.tenantId, () =>
      writes.undo(t.productId, undoBody, t.staffB),
    ).catch((e) => e);
    expect(codeOf(err)).toBe(API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE);
  });

  it("R8c: an undo retry after a later write (live revision moved) stays 409 PRICE_UNDO_UNAVAILABLE", async () => {
    const t = await seed("r8c");
    const { res } = await firstSave(t, t.staffA);
    const g2 = await readGrid(t);
    const undoBody = { auditId: res.auditId, ...stateOf(g2) };
    await inTenant(t.tenantId, () => writes.undo(t.productId, undoBody, t.staffA));
    const g3 = await readGrid(t);
    await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...stateOf(g3), patches: [{ ref: "pack", tier: 4, to: 9 }] },
        t.staffB,
      ),
    );
    const err = await inTenant(t.tenantId, () =>
      writes.undo(t.productId, undoBody, t.staffA),
    ).catch((e) => e);
    expect(codeOf(err)).toBe(API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE);
  });

  it("R8d: an undo retry with a different skip list stays 409 PRICE_UNDO_UNAVAILABLE", async () => {
    const t = await seed("r8d");
    const { res } = await firstSave(t, t.staffA);
    const g2 = await readGrid(t);
    const undoBody = { auditId: res.auditId, ...stateOf(g2) };
    await inTenant(t.tenantId, () => writes.undo(t.productId, undoBody, t.staffA));
    const err = await inTenant(t.tenantId, () =>
      writes.undo(
        t.productId,
        { ...undoBody, skip: [{ customerId: randomUUID(), ref: "pack", seen: 1 }] },
        t.staffA,
      ),
    ).catch((e) => e);
    expect(codeOf(err)).toBe(API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE);
  });

  it('R1b: a retry naming the factor-1 unit by its row id (stored as "base") is still the same write', async () => {
    const t = await seed("r1b");
    const piece = await prisma.productUnit.create({
      data: { tenantId: t.tenantId, productId: t.productId, label: "Piece", factorToBase: 1 },
    });
    const g = await readGrid(t);
    const body = { ...stateOf(g), patches: [{ ref: piece.id, tier: 1, to: 1.25 }] };
    const res = await inTenant(t.tenantId, () => writes.save(t.productId, body, t.staffA));
    const again = await inTenant(t.tenantId, () => writes.save(t.productId, body, t.staffA));
    expect(again).toMatchObject({ replayed: true, auditId: res.auditId });
    const asBase = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        { ...body, patches: [{ ref: "base", tier: 1, to: 1.25 }] },
        t.staffA,
      ),
    );
    expect(asBase).toMatchObject({ replayed: true, auditId: res.auditId });
    expect(await audits(t, AUDIT_ACTIONS.PRODUCT_PRICES_SAVED)).toHaveLength(1);
  });
});
