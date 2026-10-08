import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { RequestMethod } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import * as locks from "../common/db-locks";
import { ProductUnitsService } from "./product-units.service";
import { ProductUnitsController } from "./product-units.controller";
import { ReplaceProductUnitsDto } from "./dto/replace-product-units.dto";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { makeDb, TENANT } from "./product-units-replace.fake";
import { syncProductBarcodesFromLegacy } from "./product-catalog-sync";

jest.mock("../common/db-locks", () => {
  const actual = jest.requireActual("../common/db-locks");
  const { makeFakeLock } = jest.requireActual("./product-units-replace.fake");
  const lock = makeFakeLock();
  return { ...actual, withAdvisoryLock: lock.withAdvisoryLock, __lock: lock };
});
const fakeLock = (
  locks as unknown as {
    __lock: ReturnType<typeof import("./product-units-replace.fake").makeFakeLock>;
  }
).__lock;

const USED_TEXT =
  '"Pack" is already used on an order or invoice at a different size, so its size cannot change. Create a new unit instead.';

const product = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  tenantId: TENANT,
  name: "Soda",
  isActive: true,
  unit: "Box",
  unitsPerBox: null,
  trackedCategoryId: null,
  sku: null,
  unitSku: null,
  barcode: null,
  baseUnitLabel: null,
  packLabel: null,
  ...over,
});
const other = (id: string, over: Record<string, unknown> = {}) =>
  product({ id, name: `Gift Box ${id}`, ...over });

const lv = (
  label: string,
  perParent: number,
  parentLabel: string | null = null,
  extra: Record<string, unknown> = {},
) => ({ label, perParent, parentLabel, isDefaultSelling: false, sortOrder: 0, ...extra });

const body = (levels: any[], over: Record<string, unknown> = {}) =>
  ({ baseUnitLabel: "Bottle", packLabel: null, packLevel: null, levels, ...over }) as any;

function setup(seed: Parameters<typeof makeDb>[0] = {}) {
  const db = makeDb({ products: [product()], ...seed });
  const service = new ProductUnitsService(db.prisma as never);
  return { service, ...db };
}
const unitRows = (state: any) =>
  state.productUnit.map((u: any) => [u.label, u.factorToBase, u.perParent ?? null]);

beforeEach(() => {
  fakeLock.taken.length = 0;
  fakeLock.withAdvisoryLock.mockClear();
});

describe("PUT /products/:id/units - ladder math and shape", () => {
  it("6 Bottle = 1 Pack, 4 Pack = 1 Case stores FLAT 1/6/24 with perParent 6,4 and the chain link", async () => {
    const { service, state } = setup();
    await service.replace("p1", body([lv("Pack", 6), lv("Case", 4, "Pack")]));
    expect(unitRows(state)).toEqual([
      ["Pack", 6, 6],
      ["Case", 24, 4],
    ]);
    const pack = state.productUnit.find((u: any) => u.label === "Pack");
    const kase = state.productUnit.find((u: any) => u.label === "Case");
    expect(pack.parentUnitId ?? null).toBeNull();
    expect(kase.parentUnitId).toBe(pack.id);
    expect(state.product[0].baseUnitLabel).toBe("Bottle");
  });

  it("a legacy flat ladder (Case 50, Inner 12 siblings under the base) saves as written", async () => {
    const { service, state } = setup();
    await service.replace("p1", body([lv("Case", 50), lv("Inner", 12)], { baseUnitLabel: null }));
    expect(unitRows(state)).toEqual([
      ["Case", 50, 50],
      ["Inner", 12, 12],
    ]);
  });

  it("refuses a factor over 1,000,000 with a 409 and writes nothing", async () => {
    const { service, state } = setup();
    await expect(
      service.replace("p1", body([lv("Pack", 1000), lv("Pallet", 1001, "Pack")])),
    ).rejects.toThrow(ConflictException);
    expect(state.productUnit).toHaveLength(0);
  });

  it("refuses perParent under 2 with a 400", async () => {
    const { service } = setup();
    await expect(service.replace("p1", body([lv("Pack", 1)]))).rejects.toThrow(BadRequestException);
  });

  it("refuses two levels of the same size (409) and keeps the old ladder", async () => {
    const { service, state } = setup({
      units: [
        {
          id: "u1",
          productId: "p1",
          tenantId: TENANT,
          label: "Pack",
          factorToBase: 6,
          perParent: 6,
        },
      ],
    });
    await expect(service.replace("p1", body([lv("Pack", 6), lv("Tray", 6)]))).rejects.toThrow(
      "Pack and Tray would both hold 6 Bottles. Change one.",
    );
    expect(unitRows(state)).toEqual([["Pack", 6, 6]]);
  });

  it("a parent edit recomputes every descendant in the same transaction", async () => {
    const { service, state } = setup({
      units: [
        {
          id: "u1",
          productId: "p1",
          tenantId: TENANT,
          label: "Pack",
          factorToBase: 6,
          perParent: 6,
          parentUnitId: null,
        },
        {
          id: "u2",
          productId: "p1",
          tenantId: TENANT,
          label: "Case",
          factorToBase: 24,
          perParent: 4,
          parentUnitId: "u1",
        },
      ],
    });
    await service.replace("p1", body([lv("Pack", 8), lv("Case", 4, "Pack")]));
    expect(unitRows(state)).toEqual([
      ["Pack", 8, 8],
      ["Case", 32, 4],
    ]);
  });

  it("swapping two sizes in one save does not trip the (product, size) unique", async () => {
    const { service, state } = setup({
      units: [
        {
          id: "u1",
          productId: "p1",
          tenantId: TENANT,
          label: "Pack",
          factorToBase: 6,
          perParent: 6,
        },
        {
          id: "u2",
          productId: "p1",
          tenantId: TENANT,
          label: "Tray",
          factorToBase: 12,
          perParent: 12,
        },
      ],
    });
    await service.replace("p1", body([lv("Pack", 12), lv("Tray", 6)]));
    expect(unitRows(state).sort()).toEqual([
      ["Pack", 12, 12],
      ["Tray", 6, 6],
    ]);
  });

  it("keeps a legacy Piece price row unless the body says otherwise", async () => {
    const { service, state } = setup({
      units: [
        {
          id: "u0",
          productId: "p1",
          tenantId: TENANT,
          label: "Piece",
          factorToBase: 1,
          price: 2.4,
        },
      ],
    });
    await service.replace("p1", body([lv("Pack", 6)]));
    expect(state.productUnit.some((u: any) => u.label === "Piece" && u.price === 2.4)).toBe(true);
  });

  it("stores the level price, tier prices, default flag and sort order", async () => {
    const { service, state } = setup();
    await service.replace(
      "p1",
      body([
        lv("Pack", 6, null, {
          price: 12,
          tiers: [11, null, 9],
          isDefaultSelling: true,
          sortOrder: 3,
        }),
      ]),
    );
    const r = state.productUnit[0];
    expect([r.price, r.priceTier2, r.priceTier3, r.priceTier4, r.priceTier5]).toEqual([
      12,
      11,
      null,
      9,
      null,
    ]);
    expect([r.isDefaultSelling, r.sortOrder]).toEqual([true, 3]);
  });

  it("only one default survives", async () => {
    const { service, state } = setup();
    await service.replace(
      "p1",
      body([
        lv("Pack", 6, null, { isDefaultSelling: true }),
        lv("Tray", 4, null, { isDefaultSelling: true }),
      ]),
    );
    expect(state.productUnit.filter((u: any) => u.isDefaultSelling)).toHaveLength(1);
  });
});

describe("PUT /products/:id/units - used sizes never change", () => {
  it("answers the existing 409 text verbatim and leaves the ladder untouched", async () => {
    const { service, state } = setup({
      units: [
        {
          id: "u1",
          productId: "p1",
          tenantId: TENANT,
          label: "Pack",
          factorToBase: 6,
          perParent: 6,
        },
      ],
      lines: [{ productId: "p1", unitLabel: "Pack", unitsPerBox: 6 }],
    });
    await expect(service.replace("p1", body([lv("Pack", 8)]))).rejects.toMatchObject({
      status: 409,
      message: USED_TEXT,
      response: expect.objectContaining({ code: "UNIT_SIZE_IN_USE", level: "Pack" }),
    });
    expect(unitRows(state)).toEqual([["Pack", 6, 6]]);
  });

  it("a used level that keeps its size saves (prices and order are free)", async () => {
    const { service, state } = setup({
      units: [
        {
          id: "u1",
          productId: "p1",
          tenantId: TENANT,
          label: "Pack",
          factorToBase: 6,
          perParent: 6,
        },
      ],
      lines: [{ productId: "p1", unitLabel: "Pack", unitsPerBox: 6 }],
    });
    await service.replace("p1", body([lv("Pack", 6, null, { price: 9 })]));
    expect(state.productUnit[0].price).toBe(9);
  });

  it("never touches order or invoice lines", async () => {
    const { service, state } = setup({
      lines: [{ productId: "p1", unitLabel: "Pack", unitsPerBox: 6, unitPrice: 3 }],
    });
    const before = JSON.stringify(state.lines);
    await service.replace("p1", body([lv("Pack", 6)]));
    expect(JSON.stringify(state.lines)).toBe(before);
  });
});

describe("PUT /products/:id/units - pack and base", () => {
  it("the pack must be one of the levels (or the base), else 400", async () => {
    const { service } = setup();
    await expect(
      service.replace("p1", body([lv("Pack", 6)], { packLevel: "Nope", packLabel: "Nope" })),
    ).rejects.toThrow(BadRequestException);
  });

  it("a pack level writes unitsPerBox + packLabel and is NOT stored as a ladder row", async () => {
    const { service, state } = setup();
    await service.replace(
      "p1",
      body([lv("Pack", 6), lv("Case", 4, "Pack")], { packLevel: "Case", packLabel: "Case" }),
    );
    expect(state.product[0].unitsPerBox).toBe(24);
    expect(state.product[0].packLabel).toBe("Case");
    expect(state.product[0].unit).toBe("Box");
    expect(state.productUnit.map((u: any) => u.label)).toEqual(["Pack"]);
  });

  it("no pack leaves the product's own pack alone", async () => {
    const { service, state } = setup({ products: [product({ unitsPerBox: 12 })] });
    await service.replace("p1", body([lv("Tray", 4)]));
    expect(state.product[0].unitsPerBox).toBe(12);
  });

  it("regulated: a level above the pack is refused (400)", async () => {
    const { service } = setup({
      products: [product({ trackedCategoryId: "cat", unitsPerBox: 6 })],
    });
    await expect(
      service.replace(
        "p1",
        body([lv("Pack", 6), lv("Case", 4, "Pack")], { packLevel: "Pack", packLabel: "Pack" }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([[null], ["Piece"], ["piece"], ["  Piece "]])(
    "base %p writes NULL (Piece is the default)",
    async (b) => {
      const { service, state } = setup({ products: [product({ baseUnitLabel: "Can" })] });
      await service.replace("p1", body([lv("Pack", 6, null)], { baseUnitLabel: b }));
      expect(state.product[0].baseUnitLabel).toBeNull();
    },
  );

  it("a custom base is stored trimmed", async () => {
    const { service, state } = setup();
    await service.replace("p1", body([lv("Pack", 6)], { baseUnitLabel: " Bottle " }));
    expect(state.product[0].baseUnitLabel).toBe("Bottle");
  });
});

describe("PUT /products/:id/units - tenant units and the transaction", () => {
  it("creates TenantUnit rows for new names in the same transaction, idempotently", async () => {
    const { service, state } = setup({
      tenantUnits: [
        { id: "t1", tenantId: TENANT, name: "Case", nameKey: "case", archivedAt: null },
      ],
    });
    await service.replace(
      "p1",
      body([lv("Case", 6), lv("Crate", 4, "Case")], { newUnits: ["Crate", "crate"] }),
    );
    expect(state.tenantUnit.map((t: any) => t.nameKey).sort()).toEqual(["bottle", "case", "crate"]);
    const crate = state.productUnit.find((u: any) => u.label === "Crate");
    expect(crate.tenantUnitId).toBe(state.tenantUnit.find((t: any) => t.nameKey === "crate").id);
    await service.replace(
      "p1",
      body([lv("Case", 6), lv("Crate", 4, "Case")], { newUnits: ["Crate"] }),
    );
    expect(state.tenantUnit).toHaveLength(3);
  });

  it("a failure AFTER the TenantUnit upsert rolls it back (no TenantUnit, old ladder kept)", async () => {
    const { service, state, failOn } = setup({
      units: [
        {
          id: "u1",
          productId: "p1",
          tenantId: TENANT,
          label: "Pack",
          factorToBase: 6,
          perParent: 6,
        },
      ],
    });
    failOn.op = "productUnit.create";
    await expect(
      service.replace("p1", body([lv("Pack", 6), lv("Crate", 4, "Pack")], { newUnits: ["Crate"] })),
    ).rejects.toThrow("boom");
    expect(state.tenantUnit).toHaveLength(0);
    expect(unitRows(state)).toEqual([["Pack", 6, 6]]);
    expect(state.product[0].baseUnitLabel).toBeNull();
  });

  it("an ARCHIVED tenant unit is refused with UNIT_ARCHIVED and is not restored", async () => {
    const { service, state } = setup({
      tenantUnits: [
        { id: "t1", tenantId: TENANT, name: "Crate", nameKey: "crate", archivedAt: new Date() },
      ],
    });
    await expect(service.replace("p1", body([lv("Crate", 6)]))).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: "UNIT_ARCHIVED" }),
    });
    expect(state.tenantUnit[0].archivedAt).not.toBeNull();
  });

  it("an archived unit already on THIS product still saves (shown as archived, not offered)", async () => {
    const { service } = setup({
      tenantUnits: [
        { id: "t1", tenantId: TENANT, name: "Crate", nameKey: "crate", archivedAt: new Date() },
      ],
      units: [
        {
          id: "u1",
          productId: "p1",
          tenantId: TENANT,
          label: "Crate",
          factorToBase: 6,
          perParent: 6,
          tenantUnitId: "t1",
        },
      ],
    });
    await expect(
      service.replace("p1", body([lv("Crate", 6, null, { price: 5 })])),
    ).resolves.toBeDefined();
  });

  it.each([
    ["", "Enter a name."],
    ["x".repeat(31), "Keep it to 30 characters or fewer."],
  ])("new unit name %p is refused (%s)", async (name, msg) => {
    const { service } = setup();
    await expect(
      service.replace("p1", body([lv("Pack", 6)], { newUnits: [name] })),
    ).rejects.toThrow(msg);
  });

  it("404s for a product of another tenant", async () => {
    const { service } = setup({ products: [product({ tenantId: "someone-else" })] });
    await expect(service.replace("p1", body([lv("Pack", 6)]))).rejects.toThrow(NotFoundException);
  });

  it("runs in ONE tenant transaction, holding the catalog-code lock (key = tenant) around it", async () => {
    const { service, prisma } = setup();
    const txSpy = jest.spyOn(prisma, "tenantTransaction");
    await service.replace("p1", body([lv("Pack", 6)]));
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(fakeLock.taken).toEqual([{ family: "catalog-code", key: TENANT }]);
    expect(fakeLock.withAdvisoryLock.mock.invocationCallOrder[0]).toBeLessThan(
      txSpy.mock.invocationCallOrder[0],
    );
  });

  it("a lock timeout answers 503 with the retry copy and saves nothing", async () => {
    const { service, state } = setup();
    fakeLock.withAdvisoryLock.mockRejectedValueOnce(
      new locks.LockTimeoutError("catalog-code", TENANT, 10),
    );
    const err: any = await service.replace("p1", body([lv("Pack", 6)])).catch((e): any => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe(
      "Couldn't check that code right now. Your entry is still here. Try again.",
    );
    expect(state.productUnit).toHaveLength(0);
  });
});

describe("PUT /products/:id/units - per-level codes", () => {
  it("saves a level's own SKU and barcode (ProductUnit.sku + a ProductBarcode row with productUnitId)", async () => {
    const { service, state } = setup();
    await service.replace("p1", body([lv("Pack", 6, null, { sku: "PK-1", barcode: "111" })]));
    const u = state.productUnit[0];
    expect(u.sku).toBe("PK-1");
    const row = state.productBarcode.find((b: any) => b.productUnitId === u.id);
    expect(row).toMatchObject({
      code: "111",
      productId: "p1",
      tenantId: TENANT,
      origin: "ENTERED",
    });
  });

  it("blank, or equal to the base's own code, saves nothing (no row, null SKU)", async () => {
    const { service, state } = setup({ products: [product({ unitSku: "BASE-1" })] });
    await service.replace(
      "p1",
      body([
        lv("Pack", 6, null, { sku: "  ", barcode: "" }),
        lv("Tray", 4, null, { sku: "BASE-1" }),
      ]),
    );
    expect(state.productUnit.map((u: any) => u.sku ?? null)).toEqual([null, null]);
    expect(state.productBarcode).toHaveLength(0);
  });

  it("an unchanged re-save does not re-create the barcode rows", async () => {
    const { service, state } = setup();
    const dto = () => body([lv("Pack", 6, null, { barcode: "111" })]);
    await service.replace("p1", dto());
    const id = state.productBarcode[0].id;
    await service.replace("p1", dto());
    expect(state.productBarcode.map((b: any) => b.id)).toEqual([id]);
  });

  it("an ordinary product save (the legacy barcode sync) never deletes a level's own barcode rows", async () => {
    const { service, state, client } = setup();
    await service.replace("p1", body([lv("Pack", 6, null, { barcode: "111" })]));
    await syncProductBarcodesFromLegacy(client, {
      tenantId: TENANT,
      productId: "p1",
      barcode: "999",
      unitsPerBox: 12,
      previousBarcode: null,
    });
    expect(state.productBarcode.some((b: any) => b.code === "111" && b.productUnitId)).toBe(true);
  });

  it("the same product may reuse one code on several levels (and its own pack code)", async () => {
    const { service, state } = setup({ products: [product({ sku: "OWN-1" })] });
    await service.replace(
      "p1",
      body([
        lv("Pack", 6, null, { barcode: "222", sku: "OWN-1" }),
        lv("Tray", 4, null, { barcode: "222" }),
      ]),
    );
    expect(state.productBarcode.filter((b: any) => b.code === "222")).toHaveLength(2);
  });

  const holders: Array<[string, (v: string) => Record<string, any>]> = [
    ["Product.sku", (v) => ({ products: [product(), other("p2", { sku: v })] })],
    ["Product.unitSku", (v) => ({ products: [product(), other("p2", { unitSku: v })] })],
    ["Product.barcode", (v) => ({ products: [product(), other("p2", { barcode: v })] })],
    [
      "ProductUnit.sku",
      (v) => ({
        products: [product(), other("p2")],
        units: [
          { id: "x1", productId: "p2", tenantId: TENANT, label: "Z", factorToBase: 3, sku: v },
        ],
      }),
    ],
    [
      "ProductBarcode.code",
      (v) => ({
        products: [product(), other("p2")],
        barcodes: [{ id: "b1", productId: "p2", tenantId: TENANT, level: "UNIT", code: v }],
      }),
    ],
  ];
  describe.each(["sku", "barcode"] as const)("a level %s that another product holds", (field) => {
    it.each(holders)("clashes with %s -> 409 naming the holder", async (_name, seed) => {
      const { service, state } = setup(seed("DUP-9"));
      const err: any = await service
        .replace("p1", body([lv("Pack", 6, null, { [field]: "DUP-9" })]))
        .catch((e): any => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        field,
        productId: "p2",
        productName: "Gift Box p2",
      });
      expect(state.productUnit.filter((u: any) => u.productId === "p1")).toHaveLength(0);
    });
  });

  it("a deactivated holder that still holds the code answers inactive: true", async () => {
    const { service } = setup({
      products: [product(), other("p2", { isActive: false, sku: "DUP-9" })],
    });
    const err: any = await service
      .replace("p1", body([lv("Pack", 6, null, { sku: "DUP-9" })]))
      .catch((e): any => e);
    expect(err.getResponse()).toMatchObject({ inactive: true, productName: "Gift Box p2" });
  });

  it("a deactivated product's RELEASED code is reusable at once", async () => {
    const { service, state } = setup({
      products: [product(), other("p2", { isActive: false, sku: null, retiredSku: "DUP-9" })],
      barcodes: [
        {
          id: "b1",
          productId: "p2",
          tenantId: TENANT,
          level: "UNIT",
          code: null,
          retiredCode: "DUP-9",
        },
      ],
    });
    await service.replace("p1", body([lv("Pack", 6, null, { sku: "DUP-9", barcode: "DUP-9" })]));
    expect(state.productUnit[0].sku).toBe("DUP-9");
  });

  it("never writes Product.sku / unitSku / barcode (single writer): pack and base codes in the body are ignored", async () => {
    const { service, state } = setup({
      products: [product({ sku: "KEEP-1", unitSku: "KEEP-2", barcode: null })],
    });
    await service.replace("p1", {
      ...body([lv("Case", 6, null, { sku: "CASE-9", barcode: "999" })], {
        packLevel: "Case",
        packLabel: "Case",
      }),
      base: { price: 1 },
    });
    expect(state.product[0]).toMatchObject({ sku: "KEEP-1", unitSku: "KEEP-2", barcode: null });
    expect(state.productBarcode).toHaveLength(0);
    expect(state.productUnit.some((u: any) => u.sku === "CASE-9")).toBe(false);
  });

  it('a level called "Piece" above a custom base is refused (Piece is always the factor-1 unit)', async () => {
    const { service } = setup();
    await expect(service.replace("p1", body([lv("Piece", 6)]))).rejects.toThrow(
      BadRequestException,
    );
  });

  it("a 5th coded level is a 409 LEVEL_CODES_FULL", async () => {
    const { service, state } = setup();
    const levels = [2, 3, 5, 7, 11].map((n, i) => lv(`L${n}`, n, null, { barcode: `BC-${i}` }));
    const err: any = await service.replace("p1", body(levels)).catch((e): any => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(
      "Only 4 levels can have their own code. Leave this level's code blank and it will use the code of the level above, or remove a code from another level.",
    );
    expect(err.getResponse()).toMatchObject({ code: "LEVEL_CODES_FULL" });
    expect(state.productUnit).toHaveLength(0);
    // four coded levels are fine
    await service.replace("p1", body(levels.slice(0, 4)));
    expect(state.productBarcode).toHaveLength(4);
  });

  it("dropping a level in a PUT removes its barcode rows in the same transaction", async () => {
    const { service, state } = setup();
    await service.replace(
      "p1",
      body([lv("Pack", 6, null, { barcode: "111" }), lv("Tray", 4, null, { barcode: "222" })]),
    );
    await service.replace("p1", body([lv("Tray", 4, null, { barcode: "222" })]));
    expect(state.productBarcode.map((b: any) => b.code)).toEqual(["222"]);
  });

  it("deleting a ProductUnit through the single-level route removes its own barcode rows", async () => {
    const { service, state } = setup();
    await service.replace("p1", body([lv("Pack", 6, null, { barcode: "111" })]));
    const unitId = state.productUnit[0].id;
    await service.remove("p1", unitId);
    expect(state.productUnit).toHaveLength(0);
    expect(state.productBarcode).toHaveLength(0);
  });

  it("two concurrent writers of ONE new code: one succeeds, one gets a 409", async () => {
    const { service, state } = setup({ products: [product(), other("p2")] });
    const results = await Promise.allSettled([
      service.replace("p1", body([lv("Pack", 6, null, { sku: "RACE-1" })])),
      service.replace("p2", body([lv("Pack", 6, null, { sku: "RACE-1" })])),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ConflictException);
    expect(state.productUnit.filter((u: any) => u.sku === "RACE-1")).toHaveLength(1);
  });

  describe("shared code validator", () => {
    it("rejects 65 characters on a new code and control characters; trims", async () => {
      const { service, state } = setup();
      await expect(
        service.replace("p1", body([lv("Pack", 6, null, { sku: "a".repeat(65) })])),
      ).rejects.toThrow("Keep it to 64 characters or fewer.");
      await expect(
        service.replace("p1", body([lv("Pack", 6, null, { barcode: "12\n34" })])),
      ).rejects.toThrow(BadRequestException);
      await service.replace("p1", body([lv("Pack", 6, null, { sku: "  PK-7  " })]));
      expect(state.productUnit[0].sku).toBe("PK-7");
    });
  });
});

describe("PUT /products/:id/units - DTO and routing", () => {
  const check = async (plain: unknown) =>
    validate(plainToInstance(ReplaceProductUnitsDto, plain), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it("accepts the documented body", async () => {
    expect(
      await check({
        baseUnitLabel: "Bottle",
        packLabel: "Case",
        packLevel: "Case",
        levels: [
          {
            label: "Pack",
            perParent: 6,
            parentLabel: null,
            price: 3,
            tiers: [1, null],
            isDefaultSelling: false,
            sortOrder: 0,
            barcode: "1",
            sku: "x",
          },
        ],
        newUnits: ["Crate"],
      }),
    ).toEqual([]);
  });

  it.each([
    ["levels missing", { baseUnitLabel: null }],
    [
      "perParent a fraction",
      { levels: [{ label: "Pack", perParent: 2.5, isDefaultSelling: false, sortOrder: 0 }] },
    ],
    [
      "more than 4 tiers",
      {
        levels: [
          {
            label: "Pack",
            perParent: 2,
            tiers: [1, 2, 3, 4, 5],
            isDefaultSelling: false,
            sortOrder: 0,
          },
        ],
      },
    ],
    [
      "price with 3 decimals",
      {
        levels: [
          { label: "Pack", perParent: 2, price: 1.234, isDefaultSelling: false, sortOrder: 0 },
        ],
      },
    ],
    ["an unknown key", { levels: [], surprise: 1 }],
  ])("rejects %s", async (_n, plain) => {
    expect((await check(plain)).length).toBeGreaterThan(0);
  });

  it("is a PUT on :productId/units/ladder-free path, operator-only, behind flag.units_v1 like the rest", () => {
    const proto = ProductUnitsController.prototype as any;
    expect(Reflect.getMetadata("method", proto.replace)).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata("path", proto.replace)).toBe("/");
    expect(Reflect.getMetadata(ROLES_KEY, proto.replace)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, ProductUnitsController)).toBe(
      "flag.units_v1",
    );
  });
});
