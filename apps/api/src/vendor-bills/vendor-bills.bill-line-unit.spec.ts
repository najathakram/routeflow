import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { billPlanFromPO } from "@routeflow/pricing";
import { wireStockHelper } from "../inventory/testing/stock-helper-mock";

jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("sharp", () => ({ __esModule: true, default: jest.fn() }));

/**
 * SA-1207 S2b (spec 4-8): the bill line's own unit and identity. Red at e259ccfaab: an edit that
 * echoes no ids rewrote a lot and lost its label and family columns; a partial receive of a lot
 * posted a fraction of a piece; the family columns were never written.
 */
const D = (n: number | string) => new Prisma.Decimal(n);

const LOT = {
  id: "it-lot",
  productId: "p-1",
  description: "Soda lot",
  qty: D(1),
  unitCost: D(7.5),
  packSize: 7,
  sku: null,
  lineTotal: null,
  qtyReceived: null,
  unitLabel: "7 Pieces",
  familyProductId: "fam-1",
  familyGroupId: "grp-1",
};
const CHILD2 = { ...LOT, id: "it-lot2", productId: "p-2", packSize: 5, unitLabel: "5 Pieces" };
const PLAIN = {
  ...LOT,
  id: "it-plain",
  unitLabel: null,
  familyProductId: null,
  familyGroupId: null,
  packSize: null,
};

async function make() {
  const prisma = createMockPrisma();
  wireStockHelper(prisma, { ample: true });
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      VendorBillsService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: PlatformConfigService,
        useValue: {
          prepareAiCall: jest.fn(),
          requireAiTenant: jest.fn(),
          recordAiUsage: jest.fn(),
        },
      },
      {
        provide: SystemConfigService,
        useValue: {
          get: jest.fn().mockResolvedValue(null),
          getAll: jest.fn().mockResolvedValue({}),
        },
      },
      {
        provide: DuplicateMatchService,
        useValue: {
          normalizeNumber: (r: string) => r,
          findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
          findScanDuplicate: jest.fn().mockResolvedValue(null),
        },
      },
      { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
      {
        provide: InventoryService,
        useValue: {
          recomputeProductInTx: jest.fn(),
          lockProducts: jest.fn(),
          fireStockAlerts: jest.fn(),
          createDraftPurchaseOrderInTx: jest.fn().mockResolvedValue({ id: "po-1" }),
        },
      },
      { provide: ProductAliasService, useValue: { resolveMany: jest.fn(), learn: jest.fn() } },
    ],
  }).compile();
  return {
    service: module.get(VendorBillsService),
    prisma,
    inventory: module.get(InventoryService),
  };
}

const draft = (items: any[]) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierId: "sup-1",
  status: "DRAFT",
  receivedDate: null,
  totalOwed: D(50),
  totalPaid: D(0),
  taxAmount: null,
  purchaseOrderId: null,
  items,
});

async function outcome(p: Promise<unknown>) {
  const e: any = await p.then(
    () => null,
    (x) => x,
  );
  return e ? { status: e.getStatus?.(), code: e.getResponse?.()?.code } : null;
}

const updateRows = (prisma: any) =>
  prisma.vendorBill.update.mock.calls
    .map((c: any) => c[0].data.items?.createMany?.data)
    .find(Boolean);

describe("S2b spec 6: edit identity", () => {
  async function edit(stored: any[], items: any[]) {
    const { service, prisma } = await make();
    prisma.vendorBill.findUnique.mockResolvedValue(draft(stored));
    prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "DRAFT", totalOwed: 1 });
    const res = await outcome(service.update("bill-1", { items }));
    return { res, prisma };
  }
  const echo = (i: any, over: any = {}) => ({
    id: i.id,
    productId: i.productId,
    description: i.description,
    qty: Number(i.qty),
    unitCost: Number(i.unitCost),
    packSize: i.packSize ?? undefined,
    ...over,
  });
  const LOCKED = { status: 409, code: "SPLIT_LINE_LOCKED" };

  it("an edit that echoes no ids on a bill holding a lot is 409 SPLIT_LINE_LOCKED and writes nothing", async () => {
    const { res, prisma } = await edit([LOT, CHILD2], [{ ...echo(LOT), id: undefined }]);
    expect(res).toEqual(LOCKED);
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  it("with ids the child keeps its label, family, group and pack 7; only unitCost moved", async () => {
    const { res, prisma } = await edit([LOT, CHILD2], [echo(LOT, { unitCost: 8 }), echo(CHILD2)]);
    expect(res).toBeNull();
    const rows = updateRows(prisma);
    expect(rows[0]).toMatchObject({
      packSize: 7,
      unitLabel: "7 Pieces",
      familyProductId: "fam-1",
      familyGroupId: "grp-1",
    });
    expect(Number(rows[0].unitCost)).toBe(8);
  });

  it("the client's own label and group are never read on an edit", async () => {
    const { prisma } = await edit(
      [LOT, CHILD2],
      [echo(LOT, { unitLabel: "forged", familyGroupId: "x", familyProductId: "y" }), echo(CHILD2)],
    );
    expect(updateRows(prisma)[0]).toMatchObject({ unitLabel: "7 Pieces", familyGroupId: "grp-1" });
  });

  it.each([
    ["a re-pack to 10", (i: any) => echo(i, { packSize: 10 })],
    ["a changed product", (i: any) => echo(i, { productId: "p-9" })],
    ["a changed qty", (i: any) => echo(i, { qty: 2 })],
  ])("%s on a lot is 409 SPLIT_LINE_LOCKED", async (_n, mk) => {
    const { res, prisma } = await edit([LOT, CHILD2], [mk(LOT), echo(CHILD2)]);
    expect(res).toEqual(LOCKED);
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  it("dropping one child of a group is 409; dropping the whole group is allowed", async () => {
    const part = await edit([LOT, CHILD2], [echo(LOT)]);
    expect(part.res).toEqual(LOCKED);
    const all = await edit([LOT, CHILD2, PLAIN], [echo(PLAIN)]);
    expect(all.res).toBeNull();
  });

  it("a bill with no lot or group edits as before, ids or not", async () => {
    const { res } = await edit([PLAIN], [{ description: "x", qty: 1, unitCost: 1 }]);
    expect(res).toBeNull();
  });
});

describe("S2b spec 8: receive", () => {
  it("0.667 of a 6-piece lot is refused and posts no stock", async () => {
    const { service, prisma } = await make();
    const lot = {
      ...LOT,
      packSize: 6,
      unitLabel: "6 Pieces",
      familyGroupId: null,
      familyProductId: null,
    };
    const b = {
      ...draft([
        { ...lot, product: { id: "p-1", name: "Soda", currentStock: D(0), averageCost: null } },
      ]),
      supplier: { id: "sup-1", name: "Acme" },
      billDate: new Date("2026-06-01"),
    };
    prisma.vendorBill.findUnique.mockResolvedValue(b);
    prisma.product.findFirst.mockResolvedValue({
      currentStock: D(0),
      averageCost: null,
      costingMethod: "AVCO",
    });
    const res = await outcome(
      service.receive("bill-1", { items: [{ itemId: "it-lot", qty: 0.667 }] }, "u1"),
    );
    expect(res).toEqual({ status: 400, code: "RECEIVE_PARTIAL_UNIT" });
    expect(prisma.stockLot.create).not.toHaveBeenCalled();
  });
});

/** The inline bill-item map this service must never grow back (SA-1224 MED-4). */
const INLINE_ITEM_MAP = /tenantId: this\.prisma\.getTenantId\(\),\s*productId: item\.productId/;

describe("S2b spec 5, 7: write shape and the minted group", () => {
  it("MED-4: the pin fires on a planted inline item map", () => {
    const planted =
      "data: items.map((item) => ({\n tenantId: this.prisma.getTenantId(),\n productId: item.productId || null,";
    expect(planted).toMatch(INLINE_ITEM_MAP);
  });

  const fam = (over: any = {}) => ({ id: "fam-1", parentProductId: null, isActive: true, ...over });
  const variant = (id: string, over: any = {}) => ({
    id,
    parentProductId: "fam-1",
    isActive: true,
    ...over,
  });
  async function create(items: any[], catalog: any[]) {
    const { service, prisma, inventory } = await make();
    prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1" }]);
    prisma.vendorBill.findFirst.mockResolvedValue(null);
    prisma.vendorBill.create.mockResolvedValue({ id: "b", items: [] });
    prisma.product.findMany.mockImplementation(async (a: any) =>
      catalog.filter((p) => (a?.where?.id?.in ?? []).includes(p.id)),
    );
    const res = await outcome(service.create({ supplierId: "sup-1", items }));
    return { res, prisma, inventory };
  }
  const item = (productId: string, group: number | undefined, over: any = {}) => ({
    productId,
    description: productId,
    qty: 1,
    unitCost: 3,
    packSize: 6,
    unitLabel: "6 Pieces",
    familyProductId: "fam-1",
    familyGroup: group,
    ...over,
  });
  const rowsOf = (prisma: any) =>
    prisma.vendorBill.create.mock.calls[0][0].data.items.createMany.data;

  it("the server mints one group id per ordinal and stores label and family", async () => {
    const { res, prisma } = await create(
      [item("v-1", 0), item("v-2", 0), item("v-1", 1)],
      [fam(), variant("v-1"), variant("v-2")],
    );
    expect(res).toBeNull();
    const rows = rowsOf(prisma);
    expect(rows[0].familyGroupId).toBeTruthy();
    expect(rows[0].familyGroupId).toBe(rows[1].familyGroupId);
    expect(rows[2].familyGroupId).not.toBe(rows[0].familyGroupId);
    expect(rows[0]).toMatchObject({ unitLabel: "6 Pieces", familyProductId: "fam-1", packSize: 6 });
  });

  it.each([
    [
      "a product that is not a variant of the family",
      [fam(), variant("v-1", { parentProductId: "other" })],
    ],
    ["an archived variant", [fam(), variant("v-1", { isActive: false })]],
  ])("%s is refused and nothing is written", async (_n, catalog) => {
    const { res, prisma } = await create([item("v-1", 0)], catalog as any[]);
    expect(res?.status).toBe(400);
    expect(prisma.vendorBill.create).not.toHaveBeenCalled();
  });

  it("a family outside this business is a 404 and nothing is written", async () => {
    const { res, prisma } = await create([item("v-1", 0)], [variant("v-1")]);
    expect(res?.status).toBe(404);
    expect(prisma.vendorBill.create).not.toHaveBeenCalled();
  });

  it("two families in one group is refused", async () => {
    const { res } = await create(
      [item("v-1", 0), item("v-2", 0, { familyProductId: "fam-2" })],
      [fam(), fam({ id: "fam-2" }), variant("v-1"), variant("v-2", { parentProductId: "fam-2" })],
    );
    expect(res?.status).toBe(400);
  });

  it("a family id with no group ordinal is refused", async () => {
    const { res } = await create([item("v-1", undefined)], [fam(), variant("v-1")]);
    expect(res?.status).toBe(400);
  });

  it("static pin: one bill-item write shape (billItemData), no inline item map", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "vendor-bills.service.ts"),
      "utf8",
    );
    expect((src.match(/billItemData\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(INLINE_ITEM_MAP);
  });
});

describe("SA-1223 M1-M2: duplicate ids, whole lots", () => {
  const echo = (i: any, over: any = {}) => ({
    id: i.id,
    productId: i.productId,
    description: i.description,
    qty: Number(i.qty),
    unitCost: Number(i.unitCost),
    packSize: i.packSize ?? undefined,
    ...over,
  });
  async function edit(stored: any[], items: any[]) {
    const { service, prisma } = await make();
    prisma.vendorBill.findUnique.mockResolvedValue(draft(stored));
    prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "DRAFT", totalOwed: 1 });
    const res = await outcome(service.update("bill-1", { items }));
    return { res, prisma };
  }

  it("M1: the same locked id twice is 400 DUPLICATE_LINE_ID and nothing is written", async () => {
    const { res, prisma } = await edit([LOT, CHILD2], [echo(LOT), echo(LOT), echo(CHILD2)]);
    expect(res).toEqual({ status: 400, code: "DUPLICATE_LINE_ID" });
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  it("M2a: creating a lot with qty 0.5 is 400 LOT_QTY_NOT_WHOLE", async () => {
    const { service, prisma } = await make();
    prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1" }]);
    prisma.vendorBill.findFirst.mockResolvedValue(null);
    prisma.vendorBill.create.mockResolvedValue({ id: "b", items: [] });
    const res = await outcome(
      service.create({
        supplierId: "sup-1",
        items: [
          {
            productId: "p-1",
            description: "x",
            qty: 0.5,
            unitCost: 3,
            packSize: 6,
            unitLabel: "6 Pieces",
          },
        ],
      }),
    );
    expect(res).toEqual({ status: 400, code: "LOT_QTY_NOT_WHOLE" });
    expect(prisma.vendorBill.create).not.toHaveBeenCalled();
  });

  async function receive(items: any[], dto: any) {
    const { service, prisma } = await make();
    const withProduct = items.map((i) => ({
      ...i,
      product: { id: "p-1", name: "Soda", currentStock: D(0), averageCost: null },
    }));
    prisma.vendorBill.findUnique.mockResolvedValue({
      ...draft(withProduct),
      supplier: { id: "sup-1", name: "Acme" },
      billDate: new Date("2026-06-01"),
    });
    prisma.product.findFirst.mockResolvedValue({
      currentStock: D(0),
      averageCost: null,
      costingMethod: "AVCO",
    });
    const res = await outcome(service.receive("bill-1", dto, "u1"));
    return { res, prisma };
  }
  const lot6 = {
    ...LOT,
    packSize: 6,
    unitLabel: "6 Pieces",
    familyGroupId: null,
    familyProductId: null,
  };

  it("M2b: a stored lot of qty 0.5 on a full receive is 400 RECEIVE_PARTIAL_UNIT, no stock", async () => {
    const { res, prisma } = await receive([{ ...lot6, qty: D(0.5) }], {});
    expect(res).toEqual({ status: 400, code: "RECEIVE_PARTIAL_UNIT" });
    expect(prisma.stockLot.create).not.toHaveBeenCalled();
  });

  it("M2b control: 2 lots with 1 received, then a full receive, posts exactly 6 pieces", async () => {
    const { res, prisma } = await receive([{ ...lot6, qty: D(2), qtyReceived: D(1) }], {});
    expect(res).toBeNull();
    expect(prisma.stockLot.create.mock.calls[0][0].data.qty.toString()).toBe("6");
  });
});

describe("SA-1224 MED-1 and MED-2", () => {
  const echo = (i: any, over: any = {}) => ({
    id: i.id,
    productId: i.productId,
    description: i.description,
    qty: Number(i.qty),
    unitCost: Number(i.unitCost),
    packSize: i.packSize ?? undefined,
    ...over,
  });
  async function edit(stored: any[], items: any[]) {
    const { service, prisma } = await make();
    prisma.vendorBill.findUnique.mockResolvedValue(draft(stored));
    prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "DRAFT", totalOwed: 1 });
    const res = await outcome(service.update("bill-1", { items }));
    return { res, prisma };
  }

  it("MED-1: a new line beside echoed ids gets the create rule's label for its pack", async () => {
    const { res, prisma } = await edit(
      [LOT, CHILD2],
      [
        echo(LOT),
        echo(CHILD2),
        { description: "Lot of 122", qty: 1, unitCost: 5, packSize: 122, unitLabel: "122 Pieces" },
      ],
    );
    expect(res).toBeNull();
    expect(updateRows(prisma)[2]).toMatchObject({ packSize: 122, unitLabel: "122 Pieces" });
  });

  it("MED-2: a price-only edit of a pack-1 locked child saves (the web sends no pack at 1)", async () => {
    const one = { ...LOT, packSize: 1, unitLabel: "1 Piece" };
    const { res } = await edit([one], [echo(one, { packSize: undefined, unitCost: 9 })]);
    expect(res).toBeNull();
  });

  describe("SA-1227: one whole-lot check on every edit row", () => {
    const piece = { ...PLAIN, id: "it-pc", unitLabel: "1 Piece", packSize: null };
    const NOT_WHOLE = { status: 400, code: "LOT_QTY_NOT_WHOLE" };

    it("R1: a stated 1 Piece row re-packed to a labelled 6 at qty 0.5 is 400, writes nothing", async () => {
      const { res, prisma } = await edit(
        [piece],
        [echo(piece, { packSize: 6, qty: 0.5, unitLabel: "6 Pieces" })],
      );
      expect(res).toEqual(NOT_WHOLE);
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    });

    it("a new no-id row with pack 6, label and qty 0.5 is 400", async () => {
      const { res } = await edit(
        [piece],
        [
          echo(piece),
          { description: "x", qty: 0.5, unitCost: 3, packSize: 6, unitLabel: "6 Pieces" },
        ],
      );
      expect(res).toEqual(NOT_WHOLE);
    });

    it("green: qty 2 saves; a price-only 1 Piece edit saves", async () => {
      expect((await edit([piece], [echo(piece, { packSize: 6, qty: 2 })])).res).toBeNull();
      expect((await edit([piece], [echo(piece, { unitCost: 9 })])).res).toBeNull();
    });
  });

  describe("SA-1227 follow-up: relabel on re-pack, locked lines, one dup helper", () => {
    const piece = { ...PLAIN, id: "it-pc", unitLabel: "1 Piece", packSize: null };

    it("R2: the web shape (no label) re-packed to 6 at 0.5 stores an unlabelled case", async () => {
      const { res, prisma } = await edit([piece], [echo(piece, { packSize: 6, qty: 0.5 })]);
      expect(res).toBeNull();
      expect(updateRows(prisma)[0]).toMatchObject({ packSize: 6, unitLabel: null });
    });

    it("R3: a labelled re-pack at qty 2 is stored as 6 Pieces, not 1 Piece", async () => {
      const { res, prisma } = await edit(
        [piece],
        [echo(piece, { packSize: 6, qty: 2, unitLabel: "6 Pieces" })],
      );
      expect(res).toBeNull();
      expect(updateRows(prisma)[0]).toMatchObject({ packSize: 6, unitLabel: "6 Pieces" });
    });

    it("M3 control: a price-only edit keeps the stored label", async () => {
      const { prisma } = await edit([piece], [echo(piece, { unitCost: 9 })]);
      expect(updateRows(prisma)[0]).toMatchObject({ unitLabel: "1 Piece" });
    });

    it.each([
      ["description", { description: "Other" }],
      ["sku", { sku: "NEW-1" }],
      ["lineTotal", { lineTotal: 99 }],
    ])(
      "a locked line may change its price only: %s is 409 and nothing is written",
      async (_n, over) => {
        const { res, prisma } = await edit([LOT, CHILD2], [echo(LOT, over), echo(CHILD2)]);
        expect(res).toEqual({ status: 409, code: "SPLIT_LINE_LOCKED" });
        expect(prisma.vendorBill.update).not.toHaveBeenCalled();
      },
    );

    it("green: a locked line's price edit that echoes description, sku and lineTotal saves", async () => {
      const stored = { ...LOT, sku: "S-1", lineTotal: D(7.5) };
      const { res } = await edit(
        [stored, CHILD2],
        [echo(stored, { sku: "S-1", lineTotal: 7.5, unitCost: 8 }), echo(CHILD2)],
      );
      expect(res).toBeNull();
    });

    it("R8: a lone part lot passes save 1 (add the new lot) and save 2 (drop it)", async () => {
      const part = {
        ...LOT,
        id: "it-part",
        packSize: 6,
        unitLabel: "6 Pieces",
        qty: D(0.5),
        familyGroupId: null,
        familyProductId: null,
      };
      const fresh = {
        description: "Soda",
        productId: "p-1",
        qty: 1,
        unitCost: 3,
        packSize: 6,
        unitLabel: "6 Pieces",
      };
      expect((await edit([part], [echo(part), fresh])).res).toBeNull();
      const saved = { ...part, id: "it-new", qty: D(1) };
      expect((await edit([part, saved], [echo(saved)])).res).toBeNull();
    });

    it("R8 receive leg: a full receive before save 2 is 400 with the can't-be-received text", async () => {
      const { service, prisma } = await make();
      const part = { ...LOT, packSize: 6, unitLabel: "6 Pieces", qty: D(0.5), familyGroupId: null };
      const item = { ...part, product: { id: "p-1", name: "Soda", currentStock: D(0) } };
      prisma.vendorBill.findUnique.mockResolvedValue({ ...draft([item]), billDate: new Date() });
      const e: any = await service.receive("bill-1", {}, "u1").then(
        () => null,
        (x) => x,
      );
      expect(e.getResponse()).toMatchObject({
        code: "RECEIVE_PARTIAL_UNIT",
        message:
          '"Soda lot" is one unit of 6 pieces and can\'t be received in part. Add it again as a new line in whole packs, save, then remove this line.',
      });
    });

    it("P0: create with a 1 Piece label and no pack stores 1 Piece with a null pack", async () => {
      const { service, prisma } = await make();
      prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1" }]);
      prisma.vendorBill.findFirst.mockResolvedValue(null);
      prisma.vendorBill.create.mockResolvedValue({ id: "b", items: [] });
      await service.create({
        supplierId: "sup-1",
        items: [{ description: "x", qty: 1, unitCost: 3, unitLabel: "1 Piece" }],
      } as any);
      const rows = prisma.vendorBill.create.mock.calls[0][0].data.items.createMany.data;
      expect(rows[0]).toMatchObject({ unitLabel: "1 Piece", packSize: null });
    });

    it("R7: update() reads description, sku and lineTotal of the stored lines", async () => {
      const { prisma } = await edit([PLAIN], [echo(PLAIN)]);
      expect(prisma.vendorBill.findUnique.mock.calls[0][0].include.items.select).toMatchObject({
        description: true,
        sku: true,
        lineTotal: true,
      });
    });

    it("L4 (LOW b): a lone re-sent lot with no id is 409 and never stored unlabelled", async () => {
      const { res } = await edit([LOT], [{ description: "x", qty: 1, unitCost: 1, packSize: 7 }]);
      expect(res).toEqual({ status: 409, code: "SPLIT_LINE_LOCKED" });
    });

    it("R4: the identity file uses the shared duplicate helper, no inline copy", () => {
      const src = require("fs").readFileSync(
        require("path").join(__dirname, "bill-line-identity.ts"),
        "utf8",
      );
      expect(src).toContain("assertNoDuplicateLineIds(");
      expect(src).not.toContain("appears twice");
    });

    it("L1: the same unlocked id twice is the shared helper's DUPLICATE_LINE_ID", async () => {
      const { res } = await edit([PLAIN], [echo(PLAIN), echo(PLAIN)]);
      expect(res).toEqual({ status: 400, code: "DUPLICATE_LINE_ID" });
    });
  });
});

describe("SA-1207 P2b: a bill made from a purchase order keeps the whole-lot rule", () => {
  it("a PO piece line stored with its own 1 Piece label, PATCHed to {pack 6, qty 0.5, 6 Pieces}, is 400 and writes nothing", async () => {
    // The stored line is what the PO prefill sends for one piece (a piece line, qty 1, no pack).
    const plan = billPlanFromPO(
      [{ id: "poi-1", productId: "p-1", qtyOrdered: 1, unitCost: 2, totalCost: 2 }],
      [1],
    );
    const line = plan.lines[0];
    expect(line).toMatchObject({ qty: 1, packSize: null });
    const stored = {
      ...PLAIN,
      id: "it-po",
      qty: D(line.qty),
      unitCost: D(line.unitCost),
      packSize: null,
      unitLabel: "1 Piece",
    };
    const { service, prisma } = await make();
    prisma.vendorBill.findUnique.mockResolvedValue(draft([stored]));
    const res = await outcome(
      service.update("bill-1", {
        items: [
          {
            id: stored.id,
            productId: "p-1",
            description: stored.description,
            qty: 0.5,
            unitCost: line.unitCost,
            packSize: 6,
            unitLabel: "6 Pieces",
          },
        ],
      }),
    );
    expect(res).toEqual({ status: 400, code: "LOT_QTY_NOT_WHOLE" });
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });
});
