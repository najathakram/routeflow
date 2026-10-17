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
  /** What the customer lookup returns as names; a customer missing here gets the business name "Unnamed business". */
  customerNames: Record<string, { display?: string | null; business: string }>;
  deletedCustomers: string[];
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
    customerNames: { c1: { display: "Northside", business: "Northside Market LLC" } },
    deletedCustomers: ["c3"],
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
        [...w.customers, ...w.deletedCustomers]
          .filter((c) => where.id.in.includes(c))
          .filter((c) => where.deletedAt !== null || !w.deletedCustomers.includes(c))
          .map((id) => ({
            id,
            displayName: w.customerNames[id]?.display ?? null,
            businessName: w.customerNames[id]?.business ?? "Unnamed business",
          })),
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
        Object.assign(
          w.cups.find((r) => r.id === where.id)!,
          data,
        );
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

    it("a duplicate customerId + ref pair is 400 PRICE_EDIT_INVALID naming the customer and unit, nothing written", async () => {
      const { world, tx, service, grid } = build();
      const r = await req(grid, {
        customerMoves: [
          { customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 },
          { customerId: "c1", ref: "pack", tier: 2, from: 12, to: 14 },
        ],
      });
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      // The customer's display name and the unit's label, never the row id or the internal ref.
      expect(err.getResponse().problems).toEqual([
        "The customer price for Northside on Box is listed twice in this change.",
      ]);
      // The name came from the live-customer lookup that was already running: one customer query, no extra.
      expect(tx.customer.findMany).toHaveBeenCalledTimes(1);
      expect(world.writes).toEqual([]);
    });

    it("a duplicate pair for a customer without a display name falls back to the business name", async () => {
      const { service, grid } = build();
      const r = await req(grid, {
        customerMoves: [
          { customerId: "c2", ref: "pack", tier: 1, from: null, to: 13 },
          { customerId: "c2", ref: "pack", tier: 2, from: null, to: 14 },
        ],
      });
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().problems).toEqual([
        "The customer price for Unnamed business on Box is listed twice in this change.",
      ]);
    });

    it('a duplicate pair for a customer the lookup does not find says "a customer", never the id or the internal ref', async () => {
      const { world, service, grid } = build();
      const r = await req(grid, {
        customerMoves: [
          { customerId: "c3", ref: "pack", tier: 1, from: null, to: 13 },
          { customerId: "c3", ref: "pack", tier: 2, from: null, to: 14 },
        ],
      });
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      const problems: string[] = err.getResponse().problems;
      expect(problems).toContain(
        "The customer price for a customer on Box is listed twice in this change.",
      );
      for (const line of problems) {
        expect(line).not.toMatch(/\bc3\b/);
        expect(line).not.toMatch(/\bpack\b/);
      }
      expect(world.writes).toEqual([]);
    });

    it("a soft-deleted customer is refused as a move target (400), nothing written", async () => {
      const { world, service, grid } = build();
      const r = await req(grid, {
        customerMoves: [{ customerId: "c3", ref: "pack", tier: 1, from: null, to: 5 }],
      });
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
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

  describe("concurrent unit edits", () => {
    it("takes the product-units advisory lock FIRST, after the lock timeout, then the product row", async () => {
      const { tx, service, grid } = build();
      await service.save(PRODUCT_ID, await req(grid), null);
      const sqls = tx.$executeRaw.mock.calls.map((c: any[]) => (c[0] as string[]).join("?"));
      const at = (needle: string) => sqls.findIndex((q: string) => q.includes(needle));
      expect(at("lock_timeout")).toBe(0);
      expect(at("pg_advisory_xact_lock(hashtext('product-units')")).toBe(1);
      expect(at('FROM "Product"')).toBeGreaterThan(1);
    });

    it.each([
      ["a unit price", (w: World) => (w.units[0].price = "70.00")],
      ["a unit size", (w: World) => (w.units[0].factorToBase = 60)],
      ["a unit name", (w: World) => (w.units[0].label = "Carton")],
      ["the pack size", (w: World) => (w.product!.unitsPerBox = 24)],
      ["the pack name", (w: World) => (w.product!.packLabel = "Tray")],
      ["a unit deleted", (w: World) => w.units.splice(0, 1)],
    ])(
      "%s between the client read and the save is 409 LADDER_REVISION_STALE",
      async (_n, change) => {
        const { world, service, grid } = build();
        const r = await req(grid);
        change(world);
        const err = await rejection(service.save(PRODUCT_ID, r, null));
        expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
        expect(world.writes).toEqual([]);
      },
    );

    it("a row that vanishes mid-write (P2025) is 409, never a 500", async () => {
      const { tx, service, grid } = build();
      const r = await req(grid, { patches: [{ ref: "u-case", tier: 1, to: 66 }] });
      tx.productUnit.update.mockRejectedValueOnce(
        Object.assign(new Error("gone"), { code: "P2025" }),
      );
      const err = await rejection(service.save(PRODUCT_ID, r, null));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
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

  describe("the implicit base row (no Piece unit yet)", () => {
    const refused = async (over: Partial<SavePricesRequest>) => {
      const ctx = build({ units: [] });
      const err = await rejection(ctx.service.save(PRODUCT_ID, await req(ctx.grid, over), null));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      expect(err.getResponse().problems.join(" ")).toContain("Add the Piece unit first");
      expect(ctx.world.writes).toEqual([]);
      expect(ctx.world.units).toHaveLength(0);
      expect(ctx.world.audits).toHaveLength(0);
    };

    it("a price on it is 400 and no unit is minted", async () => {
      await refused({ patches: [{ ref: "base", tier: 1, to: 1.2 }] });
    });

    it("a customer price on it is 400 and nothing is written", async () => {
      await refused({
        customerMoves: [{ customerId: "c1", ref: "base", tier: 1, from: null, to: 1.2 }],
      });
    });

    it("the reviewer scenario: Box(12), no Piece, patch base + customer move on base -> 400, nothing written", async () => {
      await refused({
        patches: [{ ref: "base", tier: 1, to: 1.2 }],
        customerMoves: [{ customerId: "c1", ref: "base", tier: 1, from: null, to: 1.1 }],
      });
    });

    it("a keep on it is 400 too; the other rows still save", async () => {
      await refused({
        patches: [{ ref: "pack", tier: 3, to: 10 }],
        keeps: [{ ref: "base", tier: 2, value: 0.92 }],
      });
      const ok = build({ units: [] });
      await expect(ok.service.save(PRODUCT_ID, await req(ok.grid), null)).resolves.toMatchObject({
        revision: 4,
      });
    });
  });

  describe("a Piece (factor-1) unit backs the base level (SA-809)", () => {
    const pieceRow = {
      id: "u-piece",
      label: "Piece",
      factorToBase: 1,
      price: null,
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      isDefaultSelling: false,
      sortOrder: 1,
      parentUnitId: null,
      perParent: null,
      sku: "PIECE-1",
    };
    const withPiece = () => build({ units: [{ ...pieceRow }] });

    it('a patch on "base" prices that row (200), and the stored refs are the level', async () => {
      const { world, service, grid } = withPiece();
      const res = await service.save(
        PRODUCT_ID,
        await req(grid, { patches: [{ ref: "base", tier: 1, to: 1.25 }] }),
        null,
      );
      const piece = world.units.find((u) => u.id === "u-piece")!;
      expect(Number(piece.price)).toBe(1.25);
      expect(world.writes).toContain("productUnit.update");
      expect(world.writes).not.toContain("productUnit.create");
      expect(res.revision).toBe(4);
      const row = res.grid.rows.find((r) => r.ref === "base")!;
      expect(row.code).toBe("PIECE-1");
      expect(row.cells[0]).toEqual({ tier: 1, source: "set", value: 1.25 });
      expect(res.undo?.patches).toEqual([{ ref: "base", tier: 1, to: null }]);
      expect(world.audits[0].meta.request.patches).toEqual([{ ref: "base", tier: 1, to: 1.25 }]);
    });

    it('the factor-1 row\'s own id is canonicalized to "base" before it is planned or stored', async () => {
      const { world, service, grid } = withPiece();
      await service.save(
        PRODUCT_ID,
        await req(grid, {
          patches: [{ ref: "u-piece", tier: 1, to: 1.3 }],
          customerMoves: [{ customerId: "c2", ref: "u-piece", tier: 1, from: null, to: 1.1 }],
        }),
        null,
      );
      expect(Number(world.units[0].price)).toBe(1.3);
      expect(world.cups.find((c) => c.customerId === "c2")!.unitRef).toBe("base");
      expect(world.audits[0].meta.request.patches[0].ref).toBe("base");
      expect(world.audits[0].meta.request.customerMoves[0].ref).toBe("base");
    });

    it('a customer move on "base" stores unitRef "base" (and undo removes it)', async () => {
      const { world, service, grid } = withPiece();
      const saved = await service.save(
        PRODUCT_ID,
        await req(grid, {
          patches: [],
          customerMoves: [{ customerId: "c1", ref: "base", tier: 1, from: null, to: 1.1 }],
        }),
        null,
      );
      expect(
        world.cups.filter((c) => c.customerId === "c1").map((c) => [c.unitRef, c.price]),
      ).toEqual([
        ["pack", 12],
        ["base", 1.1],
      ]);
      const g = await grid.get(PRODUCT_ID);
      await service.undo(
        PRODUCT_ID,
        { auditId: saved.auditId, expectedRevision: g.revision, expectedPriceState: g.priceState },
        null,
      );
      expect(world.cups.find((c) => c.unitRef === "base")).toBeUndefined();
    });

    it('a customer cell stored under the factor-1 row\'s id is the "base" cell, and is rewritten as "base"', async () => {
      const { world, service, grid } = withPiece();
      world.cups.push({
        id: "cup-legacy",
        customerId: "c2",
        productId: PRODUCT_ID,
        unitRef: "u-piece",
        price: 1,
      });
      await service.save(
        PRODUCT_ID,
        await req(grid, {
          patches: [],
          customerMoves: [{ customerId: "c2", ref: "base", tier: 1, from: 1, to: 1.5 }],
        }),
        null,
      );
      expect(world.cups.find((c) => c.id === "cup-legacy")).toMatchObject({
        unitRef: "base",
        price: 1.5,
      });
    });
  });

  describe("undo skip on a cell that changed back (N2)", () => {
    it("is 409 LADDER_REVISION_STALE (re-preview), nothing written, never 400 SKIP_NOT_REPORTED", async () => {
      const ctx = build();
      const saved = await ctx.service.save(
        PRODUCT_ID,
        await req(ctx.grid, {
          customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 }],
        }),
        null,
      );
      const cell = ctx.world.cups.find((c) => c.customerId === "c1")!;
      cell.price = 15;
      cell.price = 13; // changed again, then back to what the save left
      const g = await ctx.grid.get(PRODUCT_ID);
      const before = ctx.world.writes.length;
      const err = await rejection(
        ctx.service.undo(
          PRODUCT_ID,
          {
            auditId: saved.auditId,
            expectedRevision: g.revision,
            expectedPriceState: g.priceState,
            skip: [{ customerId: "c1", ref: "pack", seen: 15 }],
          },
          null,
        ),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
      expect(ctx.world.writes).toHaveLength(before);
    });
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

  it("a customer cell changed since the save refuses the WHOLE undo: 409 with conflicts, nothing written", async () => {
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
    const before = ctx.world.writes.length;
    const err = await rejection(
      ctx.service.undo(
        PRODUCT_ID,
        {
          auditId: saveRes.auditId,
          expectedRevision: g.revision,
          expectedPriceState: g.priceState,
        },
        null,
      ),
    );
    expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    expect(err.getResponse().conflicts).toEqual([
      { customerId: "c1", ref: "pack", tier: 1, expected: 13, current: 15 },
    ]);
    expect(ctx.world.cups[0].price).toBe(15);
    expect(ctx.world.writes).toHaveLength(before);
    expect(ctx.world.audits).toHaveLength(1);
    expect(JSON.stringify(ctx.world.audits)).not.toContain("skippedCustomerMoves");
  });

  describe("undo skip list (SA-809 section 2)", () => {
    /** One save that moved c1 (12 -> 13) and created c2's Case price (70). */
    async function twoCells() {
      const ctx = build();
      const saveRes = await ctx.service.save(
        PRODUCT_ID,
        await req(ctx.grid, {
          customerMoves: [
            { customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 },
            { customerId: "c2", ref: "u-case", tier: 1, from: null, to: 70 },
          ],
        }),
        null,
      );
      const undo = async (skip?: { customerId: string; ref: string; seen: number | null }[]) => {
        const g = await ctx.grid.get(PRODUCT_ID);
        return ctx.service.undo(
          PRODUCT_ID,
          {
            auditId: saveRes.auditId,
            expectedRevision: g.revision,
            expectedPriceState: g.priceState,
            ...(skip ? { skip } : {}),
          },
          null,
        );
      };
      return { ...ctx, undo, auditId: saveRes.auditId };
    }
    const c1 = (seen: number | null) => ({ customerId: "c1", ref: "pack", seen });

    it("U1: 409 lists the changed cell; undo with the right seen restores the rest in ONE write and keeps that cell", async () => {
      const { world, undo } = await twoCells();
      world.cups.find((c) => c.customerId === "c1")!.price = 15;

      const err = await rejection(undo());
      expect(err.getResponse().conflicts).toEqual([
        { customerId: "c1", ref: "pack", tier: 1, expected: 13, current: 15 },
      ]);

      const res = await undo([c1(15)]);
      expect(world.cups.find((c) => c.customerId === "c1")!.price).toBe(15);
      expect(world.cups.find((c) => c.customerId === "c2")).toBeUndefined();
      expect(world.product!.priceTier3).toBe("0.00");
      expect(res.skipped).toEqual([{ customerId: "c1", ref: "pack", tier: 1, current: 15 }]);
      expect(world.writes.filter((x) => x === "product.update")).toHaveLength(2);
      const undone = world.audits.filter((a) => a.action === AUDIT_ACTIONS.PRODUCT_PRICES_UNDONE);
      expect(undone).toHaveLength(1);
      expect(undone[0].meta.skipped).toEqual(res.skipped);
      expect(res.revision).toBe(5);
    });

    it("U2: the skipped cell changed again before the confirm -> 409 again with the new value, nothing written", async () => {
      const { world, undo } = await twoCells();
      const cell = world.cups.find((c) => c.customerId === "c1")!;
      cell.price = 15;
      await rejection(undo());
      cell.price = 16; // changes again before the confirm
      const before = world.writes.length;
      const err = await rejection(undo([c1(15)]));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
      expect(err.getResponse().conflicts).toEqual([
        { customerId: "c1", ref: "pack", tier: 1, expected: 13, current: 16 },
      ]);
      expect(world.writes).toHaveLength(before);
    });

    it("U3: skipping a cell that was not reported, or one that is not a restored customer cell, is 400", async () => {
      const { world, undo } = await twoCells();
      world.cups.find((c) => c.customerId === "c1")!.price = 15;
      const before = world.writes.length;
      // A restored cell that is not in conflict now is stale (N2, 409), not malformed.
      const stale = await rejection(undo([c1(15), { customerId: "c2", ref: "u-case", seen: 70 }]));
      expect(stale.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
      for (const bad of [
        [{ customerId: "c1", ref: "u-case", seen: 15 }], // not a cell this undo restores
        [{ customerId: "nobody", ref: "pack", seen: null }],
      ]) {
        const err = await rejection(undo(bad));
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      }
      expect(world.writes).toHaveLength(before);
    });

    it("a duplicate skip item is 400; a skip with nothing in conflict is 409 stale", async () => {
      const { world, undo } = await twoCells();
      world.cups.find((c) => c.customerId === "c1")!.price = 15;
      const dup = await rejection(undo([c1(15), c1(15)]));
      expect(dup.getResponse().code).toBe(API_ERROR_CODES.PRICE_EDIT_INVALID);
      world.cups.find((c) => c.customerId === "c1")!.price = 13; // back to what the save left
      const none = await rejection(undo([c1(13)]));
      expect(none.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
    });

    it("a cell whose row was deleted since is skipped by seen null", async () => {
      const { world, undo } = await twoCells();
      world.cups = world.cups.filter((c) => c.customerId !== "c1");
      const res = await undo([c1(null)]);
      expect(res.skipped).toEqual([{ customerId: "c1", ref: "pack", tier: 1, current: null }]);
      expect(world.cups.find((c) => c.customerId === "c1")).toBeUndefined();
    });

    it("product cells are never skippable: a changed product price is the plain stale 409", async () => {
      const { world, service, grid, auditId } = await twoCells();
      const g = await grid.get(PRODUCT_ID);
      world.product!.priceTier4 = "9.00";
      const err = await rejection(
        service.undo(
          PRODUCT_ID,
          {
            auditId,
            expectedRevision: g.revision,
            expectedPriceState: g.priceState,
            skip: [c1(13)],
          },
          null,
        ),
      );
      expect(err.getResponse().code).toBe(API_ERROR_CODES.LADDER_REVISION_STALE);
      expect(err.getResponse().conflicts).toBeUndefined();
    });
  });

  it("an undo still works when a customer was soft-deleted and its cell is untouched", async () => {
    const ctx = build();
    const saveRes = await ctx.service.save(
      PRODUCT_ID,
      await req(ctx.grid, {
        customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 }],
      }),
      null,
    );
    ctx.world.customers = ctx.world.customers.filter((c) => c !== "c1");
    ctx.world.deletedCustomers.push("c1");
    const g = await ctx.grid.get(PRODUCT_ID);
    await ctx.service.undo(
      PRODUCT_ID,
      { auditId: saveRes.auditId, expectedRevision: g.revision, expectedPriceState: g.priceState },
      null,
    );
    expect(ctx.world.cups[0].price).toBe(12);
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
