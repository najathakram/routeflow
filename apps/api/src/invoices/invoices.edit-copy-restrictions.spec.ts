/**
 * F-05 (#2093, owner rulings 2026-09-25) — `InvoicesService.update` (an item replace) and `duplicate` (a
 * copy) SELL lines, so they ask the selling-restrictions choke point before writing. An edit asks only
 * about products it ADDS (a since-banned line the DRAFT already carries is not re-refused on a notes
 * save); a copy is a new document, so every catalog line counts. The choke point itself is proven in
 * `selling-restrictions.service.spec.ts`; this file pins the CALL.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  addedRestrictionLines,
  assertEditStillJudged,
  catalogRestrictionLines,
  netEditRestrictionLines,
} from "./invoice-restriction-lines";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("invoice edit / copy — selling restrictions (F-05)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const restrictions = { assertLinesSellable: jest.fn() };
  const banned = () =>
    new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("test-tenant");
    restrictions.assertLinesSellable.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        if (token === SellingRestrictionsService) return restrictions;
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
  });

  describe("update", () => {
    const draft = { id: "inv-1", customerId: "cust-1", status: "DRAFT", orderId: null };
    const edit = (items: object[]) => service.update("inv-1", { items } as never);
    const held = { productId: "p-held", qty: 5 };
    const line = (productId: string | null, qty: number) => ({
      description: "x",
      productId,
      qty,
      unitPrice: 4,
    });

    beforeEach(() => {
      prisma.invoice.findUnique.mockResolvedValue(draft);
      prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // no unit-labelled lines
      prisma.invoiceItem.findMany.mockResolvedValue([held]);
      prisma.product.findMany.mockResolvedValue([]);
    });

    it("asks only for the NET increase (5 -> 50 asks for 45) and for products it adds, as STAFF", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(banned());
      await expect(
        edit([line("p-held", 50), line("p-new", 1), line(null, 1)]),
      ).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "test-tenant",
          customerId: "cust-1",
          // row 510: each netted line carries the key of the first payload entry of its product
          lines: [
            { productId: "p-held", qtyDelta: 45, lineKey: "n:0" },
            { productId: "p-new", lineKey: "n:1" },
          ],
          channel: "STAFF",
          document: "INVOICE",
        }),
      );
    });

    it("an increase on a banned line already on the draft is REFUSED, writing nothing", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(banned());
      await expect(edit([line("p-held", 50)])).rejects.toBeDefined();
      expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it.each([
      ["unchanged", 5],
      ["decreased (5 -> 3)", 3],
    ])(
      "a line %s asks about nothing, so a since-banned line does not block the edit",
      async (_n, qty) => {
        await edit([line("p-held", qty)]).catch(() => undefined);
        expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
          expect.objectContaining({ lines: [] }),
        );
      },
    );

    it("does not ask at all for a header-only edit", async () => {
      await service.update("inv-1", { notes: "hi" } as never).catch(() => undefined);
      expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
    });
  });

  describe("duplicate", () => {
    it("refuses a copy carrying a banned product before numbering or writing", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        customerId: "cust-1",
        orderId: null,
        items: [
          { productId: "p-banned", description: "B" },
          { productId: null, description: "Fee" },
        ],
      });
      restrictions.assertLinesSellable.mockRejectedValue(banned());
      await expect(service.duplicate("inv-1")).rejects.toMatchObject({
        response: { code: "SELLING_RESTRICTED" },
      });
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "test-tenant",
          customerId: "cust-1",
          lines: [{ productId: "p-banned", lineKey: "n:0" }],
          channel: "STAFF",
          document: "INVOICE",
        }),
      );
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });

  describe("pieces through the line's pack (SA-228 / SA-247)", () => {
    // P is 24/box: the draft holds 2 boxes, stored qty 48 with the split.
    const held = [{ productId: "p", qty: 48, boxes: 2, pieces: 0, unitsPerBox: 24 }];
    const live = new Map<string, number | null>([
      ["p", 24],
      ["q", null],
    ]);

    it("qty 40 with no split bills 40 BOXES (960 pieces): asks for 912, not -8", () => {
      expect(netEditRestrictionLines(held, [{ productId: "p", qty: 40 }], live)).toEqual([
        { productId: "p", qtyDelta: 912 },
      ]);
    });

    it("{boxes: 40, qty: 1} counts as its 960 billed pieces", () => {
      expect(netEditRestrictionLines(held, [{ productId: "p", qty: 1, boxes: 40 }], live)).toEqual([
        { productId: "p", qtyDelta: 912 },
      ]);
    });

    it("an unchanged boxed line and a decrease (2 -> 1 box) ask about nothing", () => {
      expect(
        netEditRestrictionLines(held, [{ productId: "p", qty: 48, boxes: 2, pieces: 0 }], live),
      ).toEqual([]);
      expect(
        netEditRestrictionLines(held, [{ productId: "p", qty: 24, boxes: 1, pieces: 0 }], live),
      ).toEqual([]);
    });

    describe("SA-250: a no-split payload on a held SPLIT row counts as pieces (#2083's re-split)", () => {
      const heldRow = { id: "row-1", ...held[0] };

      it("48 -> 40 pieces sent without a split, by the row's id, is a decrease: asks nothing", () => {
        expect(
          netEditRestrictionLines([heldRow], [{ id: "row-1", productId: "p", qty: 40 }], live),
        ).toEqual([]);
      });

      it("48 -> 50 pieces the same way asks for the 2-piece increase, not 1152", () => {
        expect(
          netEditRestrictionLines([heldRow], [{ id: "row-1", productId: "p", qty: 50 }], live),
        ).toEqual([{ productId: "p", qtyDelta: 2 }]);
      });

      it("a held row WITHOUT a split keeps the legacy qty x pack reading", () => {
        const legacy = { id: "row-1", productId: "p", qty: 2, unitsPerBox: 24 };
        expect(
          netEditRestrictionLines([legacy], [{ id: "row-1", productId: "p", qty: 3 }], live),
        ).toEqual([{ productId: "p", qtyDelta: 24 }]);
      });

      it("an id naming a row of ANOTHER product is not re-split: the new product is checked", () => {
        expect(
          netEditRestrictionLines([heldRow], [{ id: "row-1", productId: "q", qty: 40 }], live),
        ).toEqual([{ productId: "q" }]);
      });
    });

    describe("SA-377: an id-matched line is counted at its held row's pack, not the live one", () => {
      // The product was repacked 24 -> 30 after the draft was billed at 24.
      const heldRow = { id: "row-1", ...held[0] };
      const repacked = new Map<string, number | null>([["p", 30]]);

      it("an unchanged re-send WITH its split asks nothing (not a false 12)", () => {
        expect(
          netEditRestrictionLines(
            [heldRow],
            [{ id: "row-1", productId: "p", qty: 48, boxes: 2, pieces: 0 }],
            repacked,
          ),
        ).toEqual([]);
      });

      it("2 -> 3 boxes asks for 24 pieces at the row's pack, not 30-per-box", () => {
        expect(
          netEditRestrictionLines(
            [heldRow],
            [{ id: "row-1", productId: "p", qty: 72, boxes: 3, pieces: 0 }],
            repacked,
          ),
        ).toEqual([{ productId: "p", qtyDelta: 24 }]);
      });

      it("a same-product line with NO held match is counted at the live pack", () => {
        expect(
          netEditRestrictionLines(
            [heldRow],
            [{ productId: "p", qty: 90, boxes: 3, pieces: 0 }],
            repacked,
          ),
        ).toEqual([{ productId: "p", qtyDelta: 42 }]);
      });
    });

    it("a plain unboxed line nets numerically (5 -> 50 asks for 45) and split lines sum", () => {
      expect(
        netEditRestrictionLines([{ productId: "q", qty: 5 }], [{ productId: "q", qty: 50 }], live),
      ).toEqual([{ productId: "q", qtyDelta: 45 }]);
      expect(
        netEditRestrictionLines(
          [
            { productId: "q", qty: 2 },
            { productId: "q", qty: 3 },
          ],
          [{ productId: "q", qty: 8 }],
          live,
        ),
      ).toEqual([{ productId: "q", qtyDelta: 3 }]);
    });
  });

  describe("re-check under the Invoice row lock", () => {
    const tx = (rows: object[]) => ({
      $executeRaw: jest.fn().mockResolvedValue(1),
      invoiceItem: { findMany: jest.fn().mockResolvedValue(rows) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
    });

    it("refuses a retryable 409 when a concurrent edit changed what needs a check", async () => {
      // judged pre-lock: nothing needed (the invoice then held 50 of q); at the lock only 5 is held
      const t = tx([{ productId: "q", qty: 5 }]);
      await expect(
        assertEditStillJudged(t, "inv-1", [{ productId: "q", qty: 50 }], []),
      ).rejects.toMatchObject({ response: { code: "INVOICE_CHANGED_DURING_EDIT" } });
      expect(t.$executeRaw).toHaveBeenCalled();
    });

    it("passes when the lock-time plan needs nothing the pre-lock judgment missed", async () => {
      const t = tx([{ productId: "q", qty: 5 }]);
      await expect(
        assertEditStillJudged(t, "inv-1", [{ productId: "q", qty: 5 }], []),
      ).resolves.toBeUndefined();
    });
  });

  describe("line pickers", () => {
    it("catalogRestrictionLines: every distinct catalog product", () => {
      expect(catalogRestrictionLines([{ productId: "a" }, { productId: null }])).toEqual([
        { productId: "a" },
      ]);
    });
  });

  describe("VU-4a M1: unit lines net in pieces at the unit's factor (Pallet 480 > Box-24)", () => {
    // P sells a Box of 24; its ladder has a Pallet (480) and a Piece (1). A Pallet line is STORED like a split
    // whose box is the unit: boxes = count, qty = count x 480 pieces, unitsPerBox = 480.
    const live = new Map<string, number | null>([["p", 24]]);
    const ladders = new Map([
      [
        "p",
        {
          product: { unit: "Box", unitsPerBox: 24, pricePerUnit: 48 },
          units: [
            { label: "Pallet", factorToBase: 480 },
            { label: "Piece", factorToBase: 1 },
          ] as any[],
        },
      ],
    ]);
    const pallets = {
      id: "row-u",
      productId: "p",
      qty: 960,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 480,
      unitLabel: "Pallet",
    };

    it("raising 2 -> 10 Pallets (label re-sent) is judged on 4800 pieces: asks for 3840", () => {
      const items = [{ id: "row-u", productId: "p", qty: 10, unitLabel: "Pallet" }];
      expect(netEditRestrictionLines([pallets], items, live, ladders)).toEqual([
        { productId: "p", qtyDelta: 3840 },
      ]);
    });

    it("the same raise with the label ABSENT keeps the held Pallet (SA-070): asks for 3840", () => {
      const items = [{ id: "row-u", productId: "p", qty: 10 }];
      expect(netEditRestrictionLines([pallets], items, live, ladders)).toEqual([
        { productId: "p", qtyDelta: 3840 },
      ]);
    });

    it("2 -> 1 Pallet is a decrease and an unchanged re-send nets 0: asks nothing", () => {
      for (const qty of [1, 2]) {
        const items = [{ id: "row-u", productId: "p", qty, unitLabel: "Pallet" }];
        expect(netEditRestrictionLines([pallets], items, live, ladders)).toEqual([]);
      }
    });

    it("a NEW Pallet line on a draft holding 2 Boxes counts at the in-lock ladder's 480", () => {
      const boxes = [
        { id: "row-b", productId: "p", qty: 48, boxes: 2, pieces: 0, unitsPerBox: 24 },
      ];
      const items = [
        { id: "row-b", productId: "p", qty: 48, boxes: 2, pieces: 0 },
        { productId: "p", qty: 10, unitLabel: "Pallet" },
      ];
      expect(netEditRestrictionLines(boxes, items, live, ladders)).toEqual([
        { productId: "p", qtyDelta: 4800 },
      ]);
    });

    it("fails CLOSED: a label the ladder cannot size is always judged (no delta)", () => {
      const items = [{ id: "row-u", productId: "p", qty: 1, unitLabel: "Crate" }];
      expect(netEditRestrictionLines([pallets], items, live, ladders)).toEqual([
        { productId: "p" },
      ]);
      // no ladder read at all: a NEW unit line cannot be sized either
      expect(
        netEditRestrictionLines([pallets], [{ productId: "p", qty: 1, unitLabel: "Pallet" }], live),
      ).toEqual([{ productId: "p" }]);
    });

    it("fails CLOSED: a held unit row with no usable snapshot factor and no ladder row is judged", () => {
      const broken = { ...pallets, unitsPerBox: null, unitLabel: "Skid" };
      const items = [{ id: "row-u", productId: "p", qty: 1 }];
      expect(netEditRestrictionLines([broken], items, live, ladders)).toEqual([{ productId: "p" }]);
    });

    it("leaving a Pallet for the pack with a bare count counts Boxes at the LIVE pack (as the write does)", () => {
      const items = [{ id: "row-u", productId: "p", qty: 50, unitLabel: null }];
      expect(netEditRestrictionLines([pallets], items, live, ladders)).toEqual([
        { productId: "p", qtyDelta: 50 * 24 - 960 },
      ]);
    });

    it("leaving a factor-1 Piece row with a bare count counts PIECES, never boxes", () => {
      const piece = {
        id: "row-p",
        productId: "p",
        qty: 5,
        boxes: 5,
        pieces: 0,
        unitsPerBox: 1,
        unitLabel: "Piece",
      };
      const items = [{ id: "row-p", productId: "p", qty: 30, unitLabel: null }];
      expect(netEditRestrictionLines([piece], items, live, ladders)).toEqual([
        { productId: "p", qtyDelta: 25 },
      ]);
    });

    it("addedRestrictionLines reads the ladder through the SAME reader (in-lock: the tx)", async () => {
      const db = {
        invoiceItem: { findMany: jest.fn().mockResolvedValue([pallets]) },
        product: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: "p", unitsPerBox: 24, unit: "Box", pricePerUnit: 48 }]),
        },
        productUnit: {
          findMany: jest.fn().mockResolvedValue([
            { productId: "p", label: "Pallet", factorToBase: 480 },
            { productId: "p", label: "Piece", factorToBase: 1 },
          ]),
        },
      };
      const out = await addedRestrictionLines(db as any, "inv-1", [
        { id: "row-u", productId: "p", qty: 10, unitLabel: "Pallet" },
      ]);
      expect(out).toEqual([{ productId: "p", qtyDelta: 3840 }]);
      expect(db.productUnit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { productId: { in: ["p"] } } }),
      );
    });
  });
});
