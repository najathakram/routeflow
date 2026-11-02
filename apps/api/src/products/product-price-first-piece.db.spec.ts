/**
 * SA-1082 PR-1 DB-lane proof (real Postgres, throwaway `qa-*` tenants): the Piece row of a product with no factor-1 unit
 * opens, and the first price creates the unit in the price write's own transaction, under the house lock order. Behind
 * `flag.units_v1`; without it the row is read-only with a sentence and the write refuses the same way. VP-* are the
 * rows of the PR's test plan.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { buildLadderOptions } from "@routeflow/pricing";
import { randomUUID } from "crypto";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ProductPriceGridService } from "./product-price-grid.service";
import { ProductPriceWriteService } from "./product-price-write.service";
import { ProductUnitsService } from "./product-units.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "product-price-first-piece.db.spec.ts";
const run = randomUUID().slice(0, 8);
const NOT_SOLD = "Follows the pack price. Selling by the piece isn't on for this business.";
let seq = 0;

type Seed = { tenantId: string; customerId: string; productId: string };

describeDb("SA-1082 first Piece price - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let grid: ProductPriceGridService;
  let writes: ProductPriceWriteService;
  let flagOn = true;
  let mode: "off" | "on" = "off";
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
        ProductUnitsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn(async () => flagOn) } },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn(async () => mode) },
        },
      ],
    }).compile();
    grid = module.get(ProductPriceGridService);
    writes = module.get(ProductPriceWriteService);
  });

  beforeEach(() => {
    flagOn = true;
    mode = "off";
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.invoiceItem.deleteMany({ where: { tenantId } });
        await prisma.invoice.deleteMany({ where: { tenantId } });
        await prisma.orderItem.deleteMany({ where: { tenantId } });
        await prisma.order.deleteMany({ where: { tenantId } });
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.customerUnitPrice.deleteMany({ where: { tenantId } });
        await prisma.productUnit.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
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

  async function seed(label: string, extra: Record<string, unknown> = {}): Promise<Seed> {
    seq += 1;
    const slug = assertTestTenant(`qa-piece-${run}-${seq}-${label}`, FILE);
    const tenant = await prisma.tenant.create({ data: { slug, name: slug } });
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
        name: "Piece Box",
        sku: `PB-${randomUUID().slice(0, 6)}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: "12.00",
        priceTier2: "11.00",
        ...extra,
      } as any,
    });
    return { tenantId: tenant.id, customerId: customer.id, productId: product.id };
  }

  const readGrid = (t: Seed) => inTenant(t.tenantId, () => grid.get(t.productId));
  const pieceRow = (g: { rows: any[] }) => g.rows.find((r) => r.ref === "base");
  const stateOf = (g: { revision: number; priceState: string }) => ({
    expectedRevision: g.revision,
    expectedPriceState: g.priceState,
  });
  const firstPrice = (t: Seed, g: any, to: number | null, tier = 1) =>
    inTenant(t.tenantId, () =>
      writes.save(t.productId, { ...stateOf(g), patches: [{ ref: "base", tier, to }] }, null),
    );
  const undo = async (t: Seed, auditId: string) => {
    const g = await readGrid(t);
    return inTenant(t.tenantId, () => writes.undo(t.productId, { auditId, ...stateOf(g) }, null));
  };
  const pieces = (t: Seed) =>
    prisma.productUnit.findMany({ where: { productId: t.productId, factorToBase: 1 } });
  const productRow = (t: Seed) => prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
  const packColumns = (p: any) => ({
    pricePerUnit: Number(p.pricePerUnit),
    priceTier2: Number(p.priceTier2),
    priceTier3: Number(p.priceTier3),
    priceTier4: Number(p.priceTier4),
    priceTier5: Number(p.priceTier5),
  });
  const packFigures = (g: { rows: any[] }) => g.rows.find((r) => r.ref === "pack").cells;
  const sellerOptions = async (t: Seed) => {
    const p = await productRow(t);
    const units = await prisma.productUnit.findMany({ where: { productId: t.productId } });
    return buildLadderOptions(
      {
        ...p,
        pricePerUnit: Number(p.pricePerUnit),
        priceTier2: Number(p.priceTier2),
        priceTier3: Number(p.priceTier3),
        priceTier4: Number(p.priceTier4),
        priceTier5: Number(p.priceTier5),
      } as any,
      units.map((u) => ({
        ...u,
        price: u.price == null ? null : Number(u.price),
        priceTier2: u.priceTier2 == null ? null : Number(u.priceTier2),
        priceTier3: u.priceTier3 == null ? null : Number(u.priceTier3),
        priceTier4: u.priceTier4 == null ? null : Number(u.priceTier4),
        priceTier5: u.priceTier5 == null ? null : Number(u.priceTier5),
      })) as any,
    );
  };
  const seedLines = async (t: Seed, unitLabel: string | null) => {
    const order = await prisma.order.create({
      data: {
        tenantId: t.tenantId,
        customerId: t.customerId,
        orderNumber: `ORD-P-${randomUUID().slice(0, 8)}`,
        subtotal: 12,
        tax: 0,
        total: 12,
        status: "DELIVERED",
      } as any,
    });
    const orderLine = await prisma.orderItem.create({
      data: {
        tenantId: t.tenantId,
        orderId: order.id,
        productId: t.productId,
        qty: 1,
        unitPrice: 12,
        unitLabel,
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId: t.tenantId,
        customerId: t.customerId,
        invoiceNumber: `INV-P-${randomUUID().slice(0, 8)}`,
        status: "SENT",
        subtotal: 12,
        taxAmount: 0,
        total: 12,
      } as any,
    });
    const invoiceLine = await prisma.invoiceItem.create({
      data: {
        tenantId: t.tenantId,
        invoiceId: invoice.id,
        productId: t.productId,
        description: "Piece Box",
        qty: 1,
        unitPrice: 12,
        subtotal: 12,
        unitLabel,
      } as any,
    });
    return { orderLineId: orderLine.id, invoiceLineId: invoiceLine.id };
  };

  it("VP-1: flag on, no Piece unit: the row is editable and shows Auto figures", async () => {
    const t = await seed("vp1");
    const row = pieceRow(await readGrid(t));
    expect(row.editable).toBe(true);
    expect(row.notEditableReason).toBeUndefined();
    expect(row.unbacked).toBe(true);
    expect(row.cells[0]).toEqual({ tier: 1, source: "auto", value: 1 });
    expect(row.cells[1]).toEqual({ tier: 2, source: "auto", value: 0.92 });
    expect(await pieces(t)).toHaveLength(0);
  });

  it("VP-2: the first price creates one factor-1 row; pack columns stay; one audit row; options gain Piece", async () => {
    const t = await seed("vp2");
    const g = await readGrid(t);
    const before = packColumns(await productRow(t));
    expect((await sellerOptions(t)).map((o) => o.label)).toEqual(["Box"]);
    // packAuto may gain bits for tier columns already 0, as on any grid save: the figures below are the contract.

    const res = await firstPrice(t, g, 3);

    const rows = await pieces(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Piece");
    expect(Number(rows[0].price)).toBe(3);
    expect(rows[0].priceTier2).toBeNull();
    const after = await productRow(t);
    expect(packColumns(after)).toEqual(before);
    expect(after.priceRevision).toBe(g.revision + 1);
    const audits = await prisma.auditLog.findMany({
      where: { tenantId: t.tenantId, entityType: "Product", entityId: t.productId },
    });
    expect(audits).toHaveLength(1);
    expect((audits[0].meta as any).createdUnitId).toBe(rows[0].id);
    expect(packFigures(res.grid)).toEqual(packFigures(g));
    const piece = pieceRow(res.grid);
    expect(piece.unbacked).toBeUndefined();
    expect(piece.cells[0]).toEqual({ tier: 1, source: "set", value: 3 });
    const options = await sellerOptions(t);
    expect(options.map((o) => o.label)).toEqual(["Box", "Piece"]);
    expect(options[1].price).toBe(3);
  });

  it("VP-3: two first prices at once: one row, one wins, the other is a 409, never a 500", async () => {
    const t = await seed("vp3");
    const g = await readGrid(t);
    const results = await Promise.allSettled([firstPrice(t, g, 3), firstPrice(t, g, 4)]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    expect(await pieces(t)).toHaveLength(1);
    expect((await productRow(t)).priceRevision).toBe(g.revision + 1);
  });

  it("VP-4: flag off: figures read-only with the sentence, the write refuses the same way, no row", async () => {
    flagOn = false;
    const t = await seed("vp4");
    const g = await readGrid(t);
    const row = pieceRow(g);
    expect(row.editable).toBe(false);
    expect(row.notEditableReason).toBe(NOT_SOLD);
    expect(row.unbacked).toBe(true);
    expect(row.cells[0]).toEqual({ tier: 1, source: "auto", value: 1 });

    const err = await firstPrice(t, g, 3).catch((e) => e);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
    expect(err.getResponse().message).toBe(NOT_SOLD);
    expect(await pieces(t)).toHaveLength(0);
    expect((await productRow(t)).priceRevision).toBe(g.revision);
  });

  it("VP-5a: undo when nothing else uses the unit removes it: options back to the pack, pack unchanged", async () => {
    const t = await seed("vp5a");
    const g = await readGrid(t);
    const before = packColumns(await productRow(t));
    const saved = await firstPrice(t, g, 3);
    const res = await undo(t, saved.auditId);
    expect(await pieces(t)).toHaveLength(0);
    expect((await sellerOptions(t)).map((o) => o.label)).toEqual(["Box"]);
    expect(packColumns(await productRow(t))).toEqual(before);
    expect(packFigures(res.grid)).toEqual(packFigures(g));
    const row = pieceRow(res.grid);
    expect(row.unbacked).toBe(true);
    expect(row.editable).toBe(true);
    expect(row.cells[0]).toEqual({ tier: 1, source: "auto", value: 1 });
  });

  it("VP-5b: undo when a line carries the unit's name: price blank, the row stays", async () => {
    const t = await seed("vp5b");
    const g = await readGrid(t);
    const saved = await firstPrice(t, g, 3);
    await seedLines(t, "piece");
    await undo(t, saved.auditId);
    const rows = await pieces(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBeNull();
  });

  it("VP-5c: undo when the row gained another price, or a customer price sits on it: the undone cell blanks, the row stays", async () => {
    const priced = await seed("vp5c-priced");
    const saved = await firstPrice(priced, await readGrid(priced), 3);
    await firstPrice(priced, await readGrid(priced), 2.5, 2);
    await undo(priced, saved.auditId);
    const kept = await pieces(priced);
    expect(kept).toHaveLength(1);
    expect(kept[0].price).toBeNull();
    expect(Number(kept[0].priceTier2)).toBe(2.5);

    const customer = await seed("vp5c-customer");
    const saved2 = await firstPrice(customer, await readGrid(customer), 3);
    await prisma.customerUnitPrice.create({
      data: {
        tenantId: customer.tenantId,
        customerId: customer.customerId,
        productId: customer.productId,
        unitRef: "base",
        price: "2.75",
      },
    });
    await undo(customer, saved2.auditId);
    const kept2 = await pieces(customer);
    expect(kept2).toHaveLength(1);
    expect(kept2[0].price).toBeNull();
  });

  it("VP-6a: a Case unit and no Piece: same as VP-1 and VP-2, the Case row untouched", async () => {
    const t = await seed("vp6a");
    const unit = await prisma.productUnit.create({
      data: {
        tenantId: t.tenantId,
        productId: t.productId,
        label: "Case",
        factorToBase: 72,
        price: "60.00",
      },
    });
    const g = await readGrid(t);
    expect(pieceRow(g).editable).toBe(true);
    await firstPrice(t, g, 3);
    expect(await pieces(t)).toHaveLength(1);
    const after = await prisma.productUnit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(Number(after.price)).toBe(60);
    expect(after.factorToBase).toBe(72);
  });

  it("VP-6b: a variant in mode on stays priced by the family until PR-2: write 409, no row", async () => {
    mode = "on";
    const t = await seed("vp6b");
    const family = await prisma.product.create({
      data: {
        tenantId: t.tenantId,
        name: "Family",
        sku: `PF-${randomUUID().slice(0, 6)}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: "12.00",
        kind: "FAMILY",
      } as any,
    });
    await prisma.product.update({
      where: { id: t.productId },
      data: { kind: "VARIANT", parentProductId: family.id } as any,
    });
    const g = await readGrid(t);
    expect(pieceRow(g).editable).toBe(false);
    expect(pieceRow(g).notEditableReason).toBe("Priced by the family.");
    const err = await firstPrice(t, g, 3).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(await pieces(t)).toHaveLength(0);
  });

  it("VP-7: saved order and invoice lines do not move across the first price and its undo", async () => {
    const t = await seed("vp7");
    const { orderLineId, invoiceLineId } = await seedLines(t, null);
    const lines = async () => {
      const o = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderLineId } });
      const i = await prisma.invoiceItem.findUniqueOrThrow({ where: { id: invoiceLineId } });
      return { o, i };
    };
    const before = await lines();
    const saved = await firstPrice(t, await readGrid(t), 3);
    expect(await lines()).toEqual(before);
    await undo(t, saved.auditId);
    expect(await lines()).toEqual(before);
  });

  it("VP-8: a refusal elsewhere in the same save rolls the new row back: 400, no row, no revision bump", async () => {
    const t = await seed("vp8");
    const g = await readGrid(t);
    const err = await inTenant(t.tenantId, () =>
      writes.save(
        t.productId,
        {
          ...stateOf(g),
          patches: [
            { ref: "base", tier: 1, to: 3 },
            { ref: "pack", tier: 2, to: 0 },
          ],
        },
        null,
      ),
    ).catch((e) => e);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
    expect(await pieces(t)).toHaveLength(0);
    expect((await productRow(t)).priceRevision).toBe(g.revision);
  });

  it("VP-9: a blank box on the unbacked row creates nothing", async () => {
    const t = await seed("vp9");
    const g = await readGrid(t);
    const err = await firstPrice(t, g, null).catch((e) => e);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
    expect(await pieces(t)).toHaveLength(0);
    expect((await productRow(t)).priceRevision).toBe(g.revision);
  });
});
