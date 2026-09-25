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
import { catalogRestrictionLines, netEditRestrictionLines } from "./invoice-restriction-lines";

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
    });

    it("asks only for the NET increase (5 -> 50 asks for 45) and for products it adds, as STAFF", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(banned());
      await expect(
        edit([line("p-held", 50), line("p-new", 1), line(null, 1)]),
      ).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith({
        tenantId: "test-tenant",
        customerId: "cust-1",
        lines: [{ productId: "p-held", qtyDelta: 45 }, { productId: "p-new" }],
        channel: "STAFF",
      });
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
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith({
        tenantId: "test-tenant",
        customerId: "cust-1",
        lines: [{ productId: "p-banned" }],
        channel: "STAFF",
      });
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });

  describe("line pickers", () => {
    it("netEditRestrictionLines: nets per product, sums split lines, omits the delta for a product not held", () => {
      expect(
        netEditRestrictionLines(
          [
            { productId: "a", qty: 2 },
            { productId: "a", qty: 3 },
            { productId: "d", qty: 9 },
          ],
          [
            { productId: "a", qty: 8 },
            { productId: "b", qty: 1 },
            { productId: "d", qty: 9 },
            { qty: 4 },
          ],
        ),
      ).toEqual([{ productId: "a", qtyDelta: 3 }, { productId: "b" }]);
    });
    it("catalogRestrictionLines: every distinct catalog product", () => {
      expect(catalogRestrictionLines([{ productId: "a" }, { productId: null }])).toEqual([
        { productId: "a" },
      ]);
    });
  });
});
