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
import { catalogRestrictionLines, newlyAddedRestrictionLines } from "./invoice-restriction-lines";

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
    const edit = () =>
      service.update("inv-1", {
        items: [
          { description: "Held", productId: "p-held", qty: 1, unitPrice: 4 },
          { description: "New", productId: "p-new", qty: 1, unitPrice: 6 },
          { description: "Fee", qty: 1, unitPrice: 2 },
        ],
      } as never);

    beforeEach(() => {
      prisma.invoice.findUnique.mockResolvedValue(draft);
      prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // no unit-labelled lines
      prisma.invoiceItem.findMany.mockResolvedValue([{ productId: "p-held" }]);
    });

    it("asks only about the products the edit adds, as STAFF, for the invoice's customer", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(banned());
      await expect(edit()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith({
        tenantId: "test-tenant",
        customerId: "cust-1",
        lines: [{ productId: "p-new" }],
        channel: "STAFF",
      });
    });

    it("writes nothing when the check refuses", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(banned());
      await expect(edit()).rejects.toBeDefined();
      expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

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
    it("newlyAddedRestrictionLines: dedupes, drops held and productless lines", () => {
      expect(
        newlyAddedRestrictionLines(
          ["a", null],
          [{ productId: "a" }, { productId: "b" }, { productId: "b" }, {}],
        ),
      ).toEqual([{ productId: "b" }]);
    });
    it("catalogRestrictionLines: every distinct catalog product", () => {
      expect(catalogRestrictionLines([{ productId: "a" }, { productId: null }])).toEqual([
        { productId: "a" },
      ]);
    });
  });
});
