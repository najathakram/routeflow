/**
 * B646 — a recurring template line is a PACK COUNT (boxes typed against a per-box price). It reached
 * `invoicesService.create` as a bare qty, so a 12-pack line of 6 boxes was STORED as qty 6 in the PIECES
 * column, with no boxes/pieces and no unitsPerBox snapshot: every reader of the stored line (the regulated
 * ledger's pieces, COGS, returns, a later price adjustment) saw 6 pieces. The billed subtotal and the
 * invoice-line levy were already right (the builder multiplied the levy basis by the live pack), so the fix
 * is STORAGE-only for money on the invoice: the contrast case below pins that. Generation is a NEW sale, so
 * the LIVE pack is the right one.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Test } from "@nestjs/testing";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { recurringLineSplit } from "./recurring-line-split";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NotificationsService } from "../notifications/notifications.service";
import { buildManualInvoiceLines } from "../invoices/manual-invoice-lines";
import { foldCategoryTax } from "../invoices/manual-invoice-context";
import { createMockPrisma } from "../testing/prisma-mock";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { roundMoney } from "@routeflow/pricing";
import { CreateInvoiceDto } from "../invoices/dto/create-invoice.dto";

const LIVE_PRODUCTS = [
  { id: "p-12", unitsPerBox: 12, isActive: true },
  { id: "p-loose", unitsPerBox: null, isActive: true },
];
const template = (items: any[]) => ({
  id: "ri-1",
  customerId: "cust-1",
  frequency: "MONTHLY",
  dayOfMonth: 1,
  discount: 0,
  shippingFee: 0,
  notes: null,
  terms: null,
  autoSend: false,
  nextRunAt: new Date("2026-07-01"),
  items,
});
const tmplLine = (over: Record<string, unknown> = {}) => ({
  description: "Case",
  productId: "p-12",
  qty: 6,
  unitPrice: 40,
  discount: 0,
  taxRate: 0,
  unitLabel: null,
  ...over,
});

describe("recurringLineSplit", () => {
  it("a whole number of boxes of a boxed product is boxes + 0 pieces", () => {
    expect(recurringLineSplit({ productId: "p", qty: 6 }, 12)).toEqual({ boxes: 6, pieces: 0 });
    expect(recurringLineSplit({ productId: "p", qty: "6.000" }, 12)).toEqual({
      boxes: 6,
      pieces: 0,
    });
  });

  it("a fractional box that is a whole number of pieces splits exactly (1.5 of 12 = 1 box + 6 pieces)", () => {
    expect(recurringLineSplit({ productId: "p", qty: 1.5 }, 12)).toEqual({ boxes: 1, pieces: 6 });
  });

  it("a qty that is not a whole number of pieces keeps today's path (null), never a rounded price", () => {
    expect(recurringLineSplit({ productId: "p", qty: 1.3 }, 12)).toBeNull();
  });

  it("non-boxed, freeform, selling-unit and empty lines are untouched", () => {
    expect(recurringLineSplit({ productId: "p", qty: 6 }, null)).toBeNull();
    expect(recurringLineSplit({ productId: "p", qty: 6 }, 1)).toBeNull();
    expect(recurringLineSplit({ productId: null, qty: 6 }, 12)).toBeNull();
    expect(recurringLineSplit({ productId: "p", qty: 6, unitLabel: "Case" }, 12)).toBeNull();
    expect(recurringLineSplit({ productId: "p", qty: 0 }, 12)).toBeNull();
  });
});

describe("RecurringInvoicesService generation — boxed template lines (B646)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoices = { create: jest.fn().mockResolvedValue({ id: "inv-1" }) };
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: invoices },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        { provide: NotificationsService, useValue: { sendToUser: jest.fn().mockResolvedValue(1) } },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
    prisma.invoice.update.mockResolvedValue({ id: "inv-1" });
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" });
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.product.findMany.mockResolvedValue(LIVE_PRODUCTS);
  });

  const generatedItems = async (items: any[]) => {
    await (service as any).generateInvoiceFromTemplate(template(items));
    return invoices.create.mock.calls[0][0].items as any[];
  };
  /** What InvoicesService.create() builds from those items, with the LIVE pack and a per-piece levy. */
  const build = (items: any[]) =>
    buildManualInvoiceLines(items, {
      productMap: new Map(LIVE_PRODUCTS.map((p) => [p.id, { ...p, trackedCategoryId: "cat-1" }])),
      categoryMap: new Map([
        ["cat-1", { taxType: "EXCISE_PER_UNIT", rate: 0.5, priceIncludesTax: false }],
      ]),
      tenantId: "t-1",
      clampFreeUnits: () => 0,
    });

  it("a failed LIVE-pack read after the claim gives the cycle back as FAILED and creates nothing", async () => {
    prisma.product.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.unitsPerBox) throw new Error("pack read failed");
      return LIVE_PRODUCTS;
    });
    const ri = template([tmplLine()]);
    await expect((service as any).generateInvoiceFromTemplate(ri)).rejects.toThrow(
      "pack read failed",
    );
    expect(invoices.create).not.toHaveBeenCalled();
    const restore = prisma.recurringInvoice.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a?.data?.lastError === "pack read failed");
    expect(restore?.data).toMatchObject({ nextRunAt: ri.nextRunAt, lastRunStatus: "FAILED" });
  });

  it("a 12-pack template line of qty 6 at $40/box generates $240 stored as 72 PIECES, not qty 6 (or $2,880)", async () => {
    const items = await generatedItems([tmplLine()]);
    expect(items[0]).toMatchObject({ qty: 6, boxes: 6, pieces: 0, unitPrice: 40 });
    const { itemsData, subtotal } = build(items);
    expect(itemsData[0]).toMatchObject({
      qty: 72,
      boxes: 6,
      pieces: 0,
      unitsPerBox: 12,
      subtotal: 240,
    });
    expect(subtotal).toBe(240);
    expect(subtotal).not.toBe(2880); // 72 x $40: the per-piece re-price this must never become
  });

  // Not a red case: the no-split path already levied on pieces (see the contrast below). Kept as a pin.
  it("the levy is on the PIECES basis (72 x 0.5 = 36), not the box count", async () => {
    const { itemsData } = build(await generatedItems([tmplLine()]));
    expect(itemsData[0].categoryTaxAmount).toBe(36);
  });

  it("the bug it fixes: the SAME line without the split is stored qty 6 in the pieces column", () => {
    const { itemsData } = build([
      { description: "Case", productId: "p-12", qty: 6, unitPrice: 40, discount: 0, taxRate: 0 },
    ]);
    expect(itemsData[0]).toMatchObject({ qty: 6, boxes: null, unitsPerBox: null });
    // ...while the money on the invoice was already right: the fix changes what is STORED, not the bill.
    expect(itemsData[0].subtotal).toBe(240);
    expect(itemsData[0].categoryTaxAmount).toBe(36);
  });

  // SA-135a: the billed money is IDENTICAL with and without the split, for every qty, including a qty with
  // a non-whole leftover (no split: qty stays in the pieces column), so the two branches can never disagree.
  // What the fix changes is STORAGE (qty in pieces, boxes/pieces, the pack snapshot), never the bill.
  it.each([6, 1.5, 2.5, 72, 1.3])(
    "qty %p boxes at $40: subtotal and levy are identical before (no split) and after the fix",
    async (qty) => {
      const after = build(await generatedItems([tmplLine({ qty })])).itemsData[0];
      const before = build([
        { description: "Case", productId: "p-12", qty, unitPrice: 40, discount: 0, taxRate: 0 },
      ]).itemsData[0];
      expect(after.subtotal).toBe(before.subtotal);
      expect(after.categoryTaxAmount).toBe(before.categoryTaxAmount);
      // ...and both are the boxed figure: qty BOXES x the per-box price.
      expect(after.subtotal).toBe(roundMoney(qty * 40));
    },
  );

  // SA-135 (2): ONE read. The pack the generator split with rides along as packSnapshot, so a repack
  // between the generator's read and create()'s own product read cannot store a pack-A split under pack B.
  it("2.5 boxes split with a 12-pack is stored at 12 even if create() re-reads a repack to 6", async () => {
    const items = await generatedItems([tmplLine({ qty: 2.5 })]);
    expect(items[0]).toMatchObject({ boxes: 2, pieces: 6, packSnapshot: 12 });
    const repacked = buildManualInvoiceLines(items, {
      productMap: new Map([["p-12", { id: "p-12", unitsPerBox: 6, isActive: true }]]),
      categoryMap: new Map(),
      tenantId: "t-1",
      clampFreeUnits: () => 0,
    });
    expect(repacked.itemsData[0]).toMatchObject({
      qty: 30,
      boxes: 2,
      pieces: 6,
      unitsPerBox: 12,
      subtotal: 100,
    });
  });

  it("the HTTP CreateInvoiceDto still REJECTS packSnapshot (forbidNonWhitelisted -> 400)", async () => {
    const dto = plainToInstance(CreateInvoiceDto, {
      customerId: "4a0d0f1e-7c58-4a5c-9a4b-0c3d2b1a0f9e",
      items: [{ description: "Case", productId: null, qty: 1, unitPrice: 1, packSnapshot: 12 }],
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(JSON.stringify(errors)).toMatch(/packSnapshot/);
  });

  it("a non-boxed control is generated exactly as before (no split keys)", async () => {
    const items = await generatedItems([tmplLine({ productId: "p-loose", qty: 3, unitPrice: 5 })]);
    expect(items[0]).not.toHaveProperty("boxes");
    expect(items[0]).not.toHaveProperty("pieces");
    expect(build(items).itemsData[0]).toMatchObject({ qty: 3, subtotal: 15 });
  });

  it("a freeform line and a selling-unit (unitLabel) line are generated exactly as before", async () => {
    const items = await generatedItems([
      tmplLine({ productId: null, description: "Fee", qty: 2, unitPrice: 10 }),
      tmplLine({ unitLabel: "Case" }),
    ]);
    for (const it of items) {
      expect(it).not.toHaveProperty("boxes");
      expect(it).not.toHaveProperty("pieces");
    }
  });

  it("an exempt customer owes $0 of levy on the generated line, and the line still carries pieces", async () => {
    const { itemsData } = build(await generatedItems([tmplLine()]));
    expect(foldCategoryTax(itemsData, true)).toBe(0);
    expect(itemsData[0]).toMatchObject({ categoryTaxAmount: 0, qty: 72 });
  });

  it("a boxed line whose qty is not a whole number of pieces warns, naming the template line, and is generated as today", async () => {
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    const items = await generatedItems([tmplLine({ qty: 1.3, description: "Odd case" })]);
    expect(items[0]).not.toHaveProperty("boxes");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ri-1.*"Odd case".*p-12.*1\.3/));
    warn.mockClear();
    await generatedItems([tmplLine({ productId: "p-loose", qty: 1.3 })]); // non-boxed: nothing to warn about
    expect(warn).not.toHaveBeenCalled();
  });

  it("the LIVE pack at generation time decides the split (generation is the sale): 1.5 boxes is 1 box + 12 pieces of a 24-pack", async () => {
    prisma.product.findMany.mockResolvedValue([{ id: "p-12", unitsPerBox: 24, isActive: true }]);
    const items = await generatedItems([tmplLine({ qty: 1.5 })]);
    expect(items[0]).toMatchObject({ boxes: 1, pieces: 12 });
  });
});
