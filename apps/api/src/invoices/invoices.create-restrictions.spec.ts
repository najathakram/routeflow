/**
 * F-05 (#2093, owner rulings 2026-09-25) — `InvoicesService.create` (a manual invoice) SELLS its lines,
 * so it asks the selling-restrictions choke point BEFORE it reads, prices or numbers anything: a banned
 * product refuses (409 SELLING_RESTRICTED) and burns nothing. The choke point itself is proven in
 * `selling-restrictions.service.spec.ts`; this file pins the CALL: what it is asked, and when.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test } from "@nestjs/testing";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";

/** Any collaborator method resolves undefined; `then`/symbols stay undefined (a thenable mock hangs `await`). */
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("InvoicesService.create — selling restrictions (F-05)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const restrictions = { assertLinesSellable: jest.fn() };
  const numbering = { reserveNext: jest.fn() };

  const items = [
    { description: "Banned", productId: "p-banned", qty: 1, unitPrice: 10 },
    { description: "Freeform fee", qty: 1, unitPrice: 5 },
    { description: "Fine", productId: "p-ok", qty: 2, unitPrice: 3 },
  ];
  const create = () => service.create({ customerId: "cust-1", items } as never);

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    restrictions.assertLinesSellable.mockResolvedValue(undefined);
    numbering.reserveNext.mockRejectedValue(new Error("stop: past the guard"));
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        if (token === SellingRestrictionsService) return restrictions;
        if (token === NumberingService) return numbering;
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      isTaxExempt: false,
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([]);
  });

  it("refuses a banned product with 409 SELLING_RESTRICTED before anything is priced, numbered or written", async () => {
    restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] }),
    );
    await expect(create()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(numbering.reserveNext).not.toHaveBeenCalled();
  });

  it("asks the choke point for the invoice's customer and catalog lines as STAFF, ahead of the line context read", async () => {
    await expect(create()).rejects.toBeDefined();
    expect(restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "test-tenant",
        customerId: "cust-1",
        // the freeform fee line has no product: nothing to check (row 510: each line keyed by its payload index)
        lines: [
          { productId: "p-banned", lineKey: "n:0" },
          { productId: "p-ok", lineKey: "n:2" },
        ],
        channel: "STAFF",
        fulfilmentKind: "DELIVERY",
        document: "INVOICE",
      }),
    );
    expect(restrictions.assertLinesSellable.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.product.findMany.mock.invocationCallOrder[0],
    );
  });

  it("L8: at a PICKUP-ONLY tenant this sale is judged as PICKUP (the store's state), not DELIVERY", async () => {
    prisma.tenantFeatureConfig.findFirst.mockResolvedValue({ mode: "pickup" });
    await expect(create()).rejects.toBeDefined();
    expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ fulfilmentKind: "PICKUP" }),
    );
  });

  it("refuses a tenant-less session (403) rather than skipping the check", async () => {
    prisma.getTenantId.mockReturnValue(null);
    await expect(create()).rejects.toBeInstanceOf(ForbiddenException);
    expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
  });
});
