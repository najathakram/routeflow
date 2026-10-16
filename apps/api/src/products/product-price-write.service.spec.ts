import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { SavePricesRequest } from "@routeflow/types";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ProductPriceGridService } from "./product-price-grid.service";
import { ProductPriceWriteService } from "./product-price-write.service";

/**
 * Units v2 price writes (SA-796 R-1, SA-799 b). Prisma is mocked at the module boundary by a small in-memory
 * transaction client, so the specs assert what a real transaction would have committed.
 */

const PRODUCT_ID = "prod-1";
const TENANT = "t1";

interface World {
  product: Record<string, any> | null;
  units: Record<string, any>[];
  tierUnits: Record<string, any>[];
  cups: { id: string; customerId: string; productId: string; unitRef: string; price: number }[];
  customers: string[];
  audits: Record<string, any>[];
  writes: string[];
}

function makeWorld(over: Partial<World> = {}): World {
  return {
    product: {
      id: PRODUCT_ID,
      unit: "Box",
      baseUnitLabel: null,
      packLabel: null,
      unitsPerBox: 12,
      pricePerUnit: "12.00",
      priceTier2: "11.00",
      priceTier3: "0.00",
      priceTier4: "0.00",
      priceTier5: "0.00",
      packAuto: 0,
      priceRevision: 3,
      orderUnitRef: "pack",
      sku: "SKU-1",
      barcode: "BC-1",
      unitSku: "PC-1",
    },
    units: [
      {
        id: "u-case",
        label: "Case",
        factorToBase: 72,
        price: null,
        priceTier2: null,
        priceTier3: null,
        priceTier4: null,
        priceTier5: null,
        isDefaultSelling: false,
        sortOrder: 0,
        parentUnitId: null,
        perParent: null,
        sku: "CASE-1",
      },
    ],
    tierUnits: [],
    cups: [{ id: "cup-1", customerId: "c1", productId: PRODUCT_ID, unitRef: "pack", price: 12 }],
    customers: ["c1", "c2"],
    audits: [],
    writes: [],
    ...over,
  };
}

const matches = (row: Record<string, any>, where: Record<string, any>): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === "meta") return row.meta?.[(v as any).path[0]] === (v as any).equals;
    return row[k] === v;
  });

function makeTx(w: World) {
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    product: {
      findFirst: jest.fn(async () => (w.product ? { ...w.product } : null)),
      update: jest.fn(async ({ data }: any) => {
        w.writes.push("product.update");
        for (const [k, v] of Object.entries(data)) {
          if (k === "priceRevision") w.product![k] = w.product![k] + (v as any).increment;
          else if (typeof v === "number" && k !== "packAuto") w.product![k] = v.toFixed(2);
          else w.product![k] = v;
        }
      }),
    },
    productUnit: {
      findMany: jest.fn(async () => w.units.map((u) => ({ ...u }))),
      update: jest.fn(async ({ where, data }: any) => {
        w.writes.push("productUnit.update");
        Object.assign(
          w.units.find((u) => u.id === where.id)!,
          data,
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        w.writes.push("productUnit.create");
        const row = { id: "u-new", sku: null, sortOrder: 0, isDefaultSelling: false, ...data };
        w.units.push(row);
        return { id: row.id };
      }),
    },
    productTierUnit: { findMany: jest.fn(async () => w.tierUnits) },
    customer: {
      findMany: jest.fn(async ({ where }: any) =>
        w.customers.filter((c) => where.id.in.includes(c)).map((id) => ({ id })),
      ),
    },
    customerUnitPrice: {
      findMany: jest.fn(async ({ where }: any) =>
        w.cups.filter(
          (r) => r.productId === where.productId && where.customerId.in.includes(r.customerId),
        ),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        w.writes.push("cup.update");
        w.cups.find((r) => r.id === where.id)!.price = data.price;
      }),
      create: jest.fn(async ({ data }: any) => {
        w.writes.push("cup.create");
        w.cups.push({ id: `cup-${w.cups.length + 1}`, ...data });
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        w.writes.push("cup.delete");
        w.cups = w.cups.filter((r) => r.id !== where.id);
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        w.writes.push("audit.create");
        const row = { id: `audit-${w.audits.length + 1}`, tenantId: TENANT, ...data };
        w.audits.push(row);
        return { id: row.id };
      }),
      findFirst: jest.fn(async ({ where }: any) => w.audits.find((a) => matches(a, where)) ?? null),
    },
  };
  return tx;
}

function build(over: Partial<World> = {}, tenantId: string | null = TENANT) {
  const world = makeWorld(over);
  const tx = makeTx(world);
  const prisma = {
    getTenantId: () => tenantId,
    forTenant: () => tx,
    tenantTransaction: jest.fn(async (fn: (t: any) => Promise<unknown>) => fn(tx)),
  };
  const grid = new ProductPriceGridService(prisma as never);
  const service = new ProductPriceWriteService(prisma as never, grid);
  return { world, tx, prisma, grid, service };
}

const cellOf = (grid: any, label: string, tier: number) =>
  grid.rows.find((r: any) => r.label === label).cells.find((c: any) => c.tier === tier);

async function req(
  grid: ProductPriceGridService,
  over: Partial<SavePricesRequest> = {},
): Promise<SavePricesRequest> {
  const g = await grid.get(PRODUCT_ID);
  return {
    expectedRevision: g.revision,
    expectedPriceState: g.priceState,
    patches: [{ ref: "pack", tier: 3, to: 10.5 }],
    ...over,
  };
}

async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("ProductPriceWriteService.save", () => {
  it("writes the cells in one transaction: pack columns, revision + 1, ONE audit row", async () => {
    const { world, service, grid, prisma } = build();
    const res = await service.save(PRODUCT_ID, await req(grid), "user-1");

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(world.product!.priceTier3).toBe("10.50");
    expect(world.product!.priceRevision).toBe(4);
    expect(res.revision).toBe(4);
    expect(world.audits).toHaveLength(1);
    expect(world.audits[0]).toMatchObject({
      action: AUDIT_ACTIONS.PRODUCT_PRICES_SAVED,
      entityType: "Product",
      entityId: PRODUCT_ID,
      userId: "user-1",
    });
    expect(res.auditId).toBe(world.audits[0].id);
    expect(world.writes.filter((x) => x === "product.update")).toHaveLength(1);
    expect(cellOf(res.grid, "Box", 3)).toEqual({ tier: 3, source: "set", value: 10.5 });
    expect(res.grid.revision).toBe(4);
    expect(res.undo?.patches).toEqual([{ ref: "pack", tier: 3, to: null }]);
  });

  it("locks the product row first, through the house helper", async () => {
    const { tx, service, grid } = build();
    await service.save(PRODUCT_ID, await req(grid), null);
    expect(tx.$executeRaw).toHaveBeenCalled();
    const reads = tx.product.findFirst.mock.invocationCallOrder;
    expect(reads[reads.length - 1]).toBeGreaterThan(tx.$executeRaw.mock.invocationCallOrder[0]);
  });

  it("null clears a set price back to Auto and sets the pack's Auto bit", async () => {
    const { world, service, grid } = build();
    const res = await service.save(
      PRODUCT_ID,
      await req(grid, { patches: [{ ref: "pack", tier: 2, to: null }] }),
      null,
    );
    expect(world.product!.packAuto & 2).toBe(2);
    expect(cellOf(res.grid, "Box", 2).source).toBe("auto");
    expect(res.undo?.patches).toEqual([{ ref: "pack", tier: 2, to: 11 }]);
  });

  it("rounds every money write to cents", async () => {
    const { world, service, grid } = build();
    await service.save(
      PRODUCT_ID,
      await req(grid, { patches: [{ ref: "u-case", tier: 1, to: 66.666 }] }),
      null,
    );
    expect(world.units[0].price).toBe(66.67);
  });

  it("a stale revision is 409 LADDER_REVISION_STALE and nothing is written", async () => {
    const { world, service, grid } = build();
    const r = await req(grid, { expectedRevision: 2 });
    const err = await rejection(service.save(PRODUCT_ID, r, null));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.LADDER_REVISION_STALE,
      revision: 3,
    });
    expect(err.getResponse().grid.productId).toBe(PRODUCT_ID);
    expect(world.writes).toEqual([]);
    expect(world.audits).toHaveLength(0);
  });

  it("T28b: a legacy price write that skipped the revision bump is caught by the state token", async () => {
    const { world, service, grid } = build();
    const r = await req(grid);
    world.product!.priceTier4 = "9.00"; // a legacy writer: same revision, different price
    const err = await rejection(service.save(PRODUCT_ID, r, null));
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    expect(world.writes).toEqual([]);
  });

  it("a legacy write to a unit's price is caught too", async () => {
    const { world, service, grid } = build();
    const r = await req(grid);
    world.units[0].price = "70.00";
    const err = await rejection(service.save(PRODUCT_ID, r, null));
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    expect(world.writes).toEqual([]);
  });

  describe("keeps", () => {
    it("pins a follower at the value it shows now, taken from the fresh view", async () => {
      const { world, service, grid } = build();
      const before = await grid.get(PRODUCT_ID);
      const shown = cellOf(before, "Case", 1).value;
      const r = await req(grid, {
        patches: [{ ref: "pack", tier: 1, to: 24 }],
        keeps: [{ ref: "u-case", tier: 1, value: shown }],
      });
      const res = await service.save(PRODUCT_ID, r, null);
      expect(world.units[0].price).toBe(shown);
      expect(cellOf(res.grid, "Case", 1)).toEqual({ tier: 1, source: "set", value: shown });
      expect(res.undo?.patches).toContainEqual({ ref: "u-case", tier: 1, to: null });
      expect(world.audits).toHaveLength(1);
    });

    it("refuses a keep whose value is not what the cell shows (never trusts the client)", async () => {
      const { world, service, grid } = build();
      const r = await req(grid, {
        patches: [{ ref: "pack", tier: 1, to: 24 }],
        keeps: [{ ref: "u-case", tier: 1, value: 1.23 }],
      });
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      expect(world.writes).toEqual([]);
    });

    it("a keep on a cell that is already set is a no-op", async () => {
      const { world, service, grid } = build();
      const r = await req(grid, {
        patches: [{ ref: "pack", tier: 3, to: 10 }],
        keeps: [{ ref: "pack", tier: 2, value: 11 }],
      });
      await service.save(PRODUCT_ID, r, null);
      expect(world.product!.priceTier2).toBe("11.00");
    });
  });

  describe("customerMoves", () => {
    it("moves a customer cell with the product write, in the same transaction and audit row", async () => {
      const { world, service, grid } = build();
      const r = await req(grid, {
        customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 }],
      });
      const res = await service.save(PRODUCT_ID, r, null);
      expect(world.cups[0].price).toBe(13);
      expect(world.audits).toHaveLength(1);
      expect(world.audits[0].meta.undo.customerMoves).toEqual([
        { customerId: "c1", ref: "pack", tier: 1, from: 13, to: 12 },
      ]);
      expect(res.revision).toBe(4);
    });

    it("a customer cell that moved since it was read is 409 and NOTHING is written", async () => {
      const { world, service, grid } = build();
      const r = await req(grid, {
        customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: 11, to: 13 }],
      });
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
      expect(world.writes).toEqual([]);
      expect(world.cups[0].price).toBe(12);
    });

    it("a customer Keep (from null) creates the row; a row that exists since is 409", async () => {
      const { world, service, grid } = build();
      await service.save(
        PRODUCT_ID,
        await req(grid, {
          customerMoves: [{ customerId: "c2", ref: "u-case", tier: 1, from: null, to: 70 }],
        }),
        null,
      );
      expect(world.cups.find((c) => c.customerId === "c2")?.price).toBe(70);

      const second = build();
      const r = await req(second.grid, {
        customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: null, to: 13 }],
      });
      const err = await rejection(second.service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    });

    it("a duplicate customerId + ref pair is 400 PRICE_EDIT_INVALID naming the duplicate, nothing written", async () => {
      const { world, service, grid } = build();
      const r = await req(grid, {
        customerMoves: [
          { customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 },
          { customerId: "c1", ref: "pack", tier: 2, from: 12, to: 14 },
        ],
      });
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      expect(err.getResponse().problems.join(" ")).toContain("c1");
      expect(err.getResponse().problems.join(" ")).toContain("pack");
      expect(world.writes).toEqual([]);
    });

    it("a customer outside the tenant is refused (400) before any write", async () => {
      const { world, service, grid } = build();
      const r = await req(grid, {
        customerMoves: [{ customerId: "other-tenant", ref: "pack", tier: 1, from: null, to: 5 }],
      });
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      expect(world.writes).toEqual([]);
    });

    it("an insert race on the unique key surfaces as 409, not a 500", async () => {
      const { service, grid, tx } = build();
      const r = await req(grid, {
        customerMoves: [{ customerId: "c2", ref: "pack", tier: 1, from: null, to: 5 }],
      });
      tx.customerUnitPrice.create.mockRejectedValueOnce(
        Object.assign(new Error("dup"), { code: "P2002" }),
      );
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    });
  });

  describe("PRICE_EDIT_INVALID", () => {
    it.each([
      ["a zero price", { patches: [{ ref: "pack", tier: 3, to: 0 }] }],
      ["a negative price", { patches: [{ ref: "pack", tier: 3, to: -2 }] }],
      ["clearing the anchor's Retail", { patches: [{ ref: "pack", tier: 1, to: null }] }],
      ["a label ref", { patches: [{ ref: "label:Case", tier: 1, to: 5 }] }],
      ["an unknown unit", { patches: [{ ref: "nope", tier: 1, to: 5 }] }],
      [
        "the same cell twice",
        {
          patches: [
            { ref: "pack", tier: 3, to: 5 },
            { ref: "pack", tier: 3, to: 6 },
          ],
        },
      ],
      ["an empty change", { patches: [] }],
    ] as const)("%s is 400 with the core's problems and nothing written", async (_n, over) => {
      const { world, service, grid } = build();
      const err = await rejection(service.save(PRODUCT_ID, await req(grid, over as never), null));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.PRICE_EDIT_INVALID });
      expect(err.getResponse().problems.length).toBeGreaterThan(0);
      expect(world.writes).toEqual([]);
    });
  });

  describe("orderUnit", () => {
    it("a changed order unit is 409 PRICING_RULES_NOT_READY until U-1", async () => {
      const { world, service, grid } = build();
      const err = await rejection(
        service.save(PRODUCT_ID, await req(grid, { orderUnit: "u-case" }), null),
      );
      expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICING_RULES_NOT_READY);
      expect(world.writes).toEqual([]);
    });

    it("the current order unit passes", async () => {
      const { service, grid } = build();
      await expect(
        service.save(PRODUCT_ID, await req(grid, { orderUnit: "pack" }), null),
      ).resolves.toMatchObject({ revision: 4 });
    });
  });

  it("the piece row is created by its first price, and the inverse names the new row", async () => {
    const { world, service, grid } = build({ units: [] });
    const res = await service.save(
      PRODUCT_ID,
      await req(grid, { patches: [{ ref: "base", tier: 1, to: 1.2 }] }),
      null,
    );
    expect(world.units).toHaveLength(1);
    expect(world.units[0]).toMatchObject({ label: "Piece", factorToBase: 1, price: 1.2 });
    expect(res.undo?.patches).toEqual([{ ref: "u-new", tier: 1, to: null }]);
  });

  it("a variant is 409 FAMILY_PRICE_AUTHORITY and a family or recipe row is 400, nothing written", async () => {
    const variant = build();
    variant.world.product!.parentProductId = "fam-1";
    const g1 = await variant.grid.get(PRODUCT_ID);
    const e1 = await rejection(
      variant.service.save(
        PRODUCT_ID,
        {
          expectedRevision: g1.revision,
          expectedPriceState: g1.priceState,
          patches: [{ ref: "pack", tier: 3, to: 5 }],
        },
        null,
      ),
    );
    expect(e1.getResponse().code).toBe(API_ERROR_CODES.FAMILY_PRICE_AUTHORITY);
    expect(variant.world.writes).toEqual([]);

    for (const kind of ["FAMILY", "RECIPE"]) {
      const other = build();
      other.world.product!.kind = kind;
      const g = await other.grid.get(PRODUCT_ID);
      const e = await rejection(
        other.service.save(
          PRODUCT_ID,
          {
            expectedRevision: g.revision,
            expectedPriceState: g.priceState,
            patches: [{ ref: "pack", tier: 3, to: 5 }],
          },
          null,
        ),
      );
      expect(e.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      expect(other.world.writes).toEqual([]);
    }
  });

  it("a product outside the tenant is a 404 and nothing is written", async () => {
    const { world, service } = build({ product: null });
    const err = await rejection(
      service.save(
        PRODUCT_ID,
        {
          expectedRevision: 0,
          expectedPriceState: "x",
          patches: [{ ref: "pack", tier: 3, to: 5 }],
        },
        null,
      ),
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect(world.writes).toEqual([]);
  });

  it("refuses to run without a tenant", async () => {
    const { service } = build({}, null);
    const err = await rejection(
      service.save(PRODUCT_ID, { expectedRevision: 0, expectedPriceState: "x", patches: [] }, null),
    );
    expect(err).toBeInstanceOf(BadRequestException);
  });
});

describe("ProductPriceWriteService.undo", () => {
  async function saved() {
    const ctx = build();
    const res = await ctx.service.save(PRODUCT_ID, await req(ctx.grid), "user-1");
    return { ...ctx, res };
  }

  it("is one inverse write: values restored, revision + 1, one UNDONE audit row", async () => {
    const { world, service, grid, res } = await saved();
    const g = await grid.get(PRODUCT_ID);
    const out = await service.undo(
      PRODUCT_ID,
      { auditId: res.auditId, expectedRevision: g.revision, expectedPriceState: g.priceState },
      "user-1",
    );
    expect(cellOf(out.grid, "Box", 3).source).toBe("auto");
    expect(out.revision).toBe(5);
    expect(world.audits).toHaveLength(2);
    expect(world.audits[1]).toMatchObject({
      action: AUDIT_ACTIONS.PRODUCT_PRICES_UNDONE,
      meta: expect.objectContaining({ undoes: res.auditId }),
    });
    expect(out.auditId).toBe(world.audits[1].id);
  });

  it("also puts back the customer cells the save moved", async () => {
    const ctx = build();
    const saveRes = await ctx.service.save(
      PRODUCT_ID,
      await req(ctx.grid, {
        customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 }],
      }),
      null,
    );
    const g = await ctx.grid.get(PRODUCT_ID);
    await ctx.service.undo(
      PRODUCT_ID,
      { auditId: saveRes.auditId, expectedRevision: g.revision, expectedPriceState: g.priceState },
      null,
    );
    expect(ctx.world.cups[0].price).toBe(12);
  });

  it("an audit row is undoable once: the second undo is 409 PRICE_UNDO_UNAVAILABLE", async () => {
    const { service, grid, res } = await saved();
    let g = await grid.get(PRODUCT_ID);
    await service.undo(
      PRODUCT_ID,
      { auditId: res.auditId, expectedRevision: g.revision, expectedPriceState: g.priceState },
      null,
    );
    g = await grid.get(PRODUCT_ID);
    const err = await rejection(
      service.undo(
        PRODUCT_ID,
        { auditId: res.auditId, expectedRevision: g.revision, expectedPriceState: g.priceState },
        null,
      ),
    );
    expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE);
  });

  it("an unknown audit id is PRICE_UNDO_UNAVAILABLE", async () => {
    const { service, grid, world } = await saved();
    const g = await grid.get(PRODUCT_ID);
    const before = world.writes.length;
    const err = await rejection(
      service.undo(
        PRODUCT_ID,
        { auditId: "nope", expectedRevision: g.revision, expectedPriceState: g.priceState },
        null,
      ),
    );
    expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE);
    expect(world.writes).toHaveLength(before);
  });

  it("stale revision: 409 LADDER_REVISION_STALE carrying the current grid for the preview; nothing written", async () => {
    const { world, service, res } = await saved();
    world.product!.priceRevision = 9; // someone saved again
    const before = world.writes.length;
    const err = await rejection(
      service.undo(
        PRODUCT_ID,
        {
          auditId: res.auditId,
          expectedRevision: res.revision,
          expectedPriceState: res.grid.priceState,
        },
        null,
      ),
    );
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.LADDER_REVISION_STALE,
      revision: 9,
    });
    expect(err.getResponse().grid.productId).toBe(PRODUCT_ID);
    expect(world.writes).toHaveLength(before);
  });

  it("a confirmed undo on the fresh state applies the stored inverse on top of the newer prices", async () => {
    const { world, service, grid, res } = await saved();
    world.product!.priceTier4 = "8.00";
    world.product!.packAuto &= ~8; // the legacy writer made tier 4 a set price
    world.product!.priceRevision = 9;
    const g = await grid.get(PRODUCT_ID);
    await service.undo(
      PRODUCT_ID,
      { auditId: res.auditId, expectedRevision: g.revision, expectedPriceState: g.priceState },
      null,
    );
    expect(world.product!.priceTier4).toBe("8.00");
    expect(world.product!.priceRevision).toBe(10);
  });

  it("a customer cell changed since the save is left alone by the undo", async () => {
    const ctx = build();
    const saveRes = await ctx.service.save(
      PRODUCT_ID,
      await req(ctx.grid, {
        customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 }],
      }),
      null,
    );
    ctx.world.cups[0].price = 15;
    const g = await ctx.grid.get(PRODUCT_ID);
    await ctx.service.undo(
      PRODUCT_ID,
      { auditId: saveRes.auditId, expectedRevision: g.revision, expectedPriceState: g.priceState },
      null,
    );
    expect(ctx.world.cups[0].price).toBe(15);
    expect(ctx.world.audits[1].meta.skippedCustomerMoves).toBe(1);
  });

  it("an audit row of another product is not undoable here (cross-tenant/product isolation)", async () => {
    const { world, service, grid } = await saved();
    world.audits[0].entityId = "other-product";
    const g = await grid.get(PRODUCT_ID);
    const err = await rejection(
      service.undo(
        PRODUCT_ID,
        {
          auditId: world.audits[0].id,
          expectedRevision: g.revision,
          expectedPriceState: g.priceState,
        },
        null,
      ),
    );
    expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE);
  });
});
