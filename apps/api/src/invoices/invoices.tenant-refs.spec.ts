/**
 * 681 (R5-5) sites 2, 3 and 10 — an invoice stores ids the caller supplies. Each must resolve inside the
 * caller's tenant BEFORE the write (and before the selling-restrictions / family policy, which only judge
 * products that exist), and on the OUTER client, before any transaction opens:
 *  - site 2: `create` — the manual lines' productIds;
 *  - site 3: `update` — the edited lines' productIds, proven before the edit tx;
 *  - site 10: `writeStandalonePayment` — dto.customerId, so `allocations: []` (an advance-only receipt, a
 *    real flow) with another tenant's customer writes no AdvancePayment. The DTO keeps allowing `[]`.
 * A foreign id and a missing id are the same 404.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => unknown) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.filter((id) => owned.includes(id)).map((id) => ({ id }));

describe("InvoicesService — tenant refs (681 sites 2, 3, 10)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const restrictions = { assertLinesSellable: jest.fn() };
  const numbering = { reserveNext: jest.fn() };
  const reached = new Error("write reached");

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    prisma.product.findMany.mockImplementation(ownRows(["prod-a"]));
    prisma.customer.findMany.mockImplementation(ownRows(["cust-a"]));
    // The transaction opening IS the write for these paths: it throws a sentinel the control asserts on.
    prisma.tenantTransaction.mockRejectedValue(reached);
    restrictions.assertLinesSellable.mockResolvedValue(undefined);
    numbering.reserveNext.mockResolvedValue("INV-0001");
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
  });

  describe("site 2 — create (manual lines)", () => {
    const create = (productId: string) =>
      service.create({
        customerId: "cust-a",
        items: [
          { description: "Line", productId, qty: 1, unitPrice: 10 },
          { description: "Freeform fee", qty: 1, unitPrice: 5 },
        ],
      } as never);

    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-a",
        isTaxExempt: false,
        deletedAt: null,
      });
    });

    it("another tenant's product on a manual line is a 404; nothing is numbered or written", async () => {
      const err = await create("prod-b").catch((e) => e);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(numbering.reserveNext).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Product not found");
    });

    it("the proof comes before the selling-restrictions policy", async () => {
      await create("prod-b").catch((e) => e);
      expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
    });

    it("control: this tenant's product passes the proof and reaches the write", async () => {
      await expect(create("prod-a")).rejects.toBe(reached);
      expect(restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    });
  });

  describe("site 3 — update (edited lines)", () => {
    const draft = { id: "inv-1", customerId: "cust-a", status: "DRAFT", orderId: null };
    const edit = (productId: string) =>
      service.update("inv-1", {
        items: [{ description: "Line", productId, qty: 1, unitPrice: 4 }],
      } as never);

    beforeEach(() => {
      prisma.invoice.findUnique.mockResolvedValue(draft);
      prisma.invoice.findFirst.mockResolvedValue({ items: [] });
      prisma.invoiceItem.findMany.mockResolvedValue([]);
    });

    it("another tenant's product on an edited line is a 404 and no edit transaction opens", async () => {
      const err = await edit("prod-b").catch((e) => e);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Product not found");
    });

    it("the proof comes before the selling-restrictions policy", async () => {
      await edit("prod-b").catch((e) => e);
      expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
    });

    it("control: this tenant's product passes the proof and reaches the edit transaction", async () => {
      await expect(edit("prod-a")).rejects.toBe(reached);
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("site 10 — writeStandalonePayment (dto.customerId)", () => {
    const pay = (customerId: string, allocations: object[] = []) =>
      service.recordStandalonePayment({
        customerId,
        totalAmount: 50,
        method: "CASH",
        allocations,
      } as never);

    beforeEach(() => {
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 3 });
    });

    it("allocations: [] with another tenant's customer is a 404 and no AdvancePayment is written", async () => {
      const err = await pay("cust-b").catch((e) => e);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.advancePayment.create).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Customer not found");
    });

    it("a foreign customer with allocations is the same 404 before the payment number is reserved", async () => {
      const err = await pay("cust-b", [{ invoiceId: "inv-1", amount: 10 }]).catch((e) => e);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.paymentCounter.upsert).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
    });

    it("control: an advance-only receipt (allocations: []) for this tenant's customer still reaches the write", async () => {
      await expect(pay("cust-a")).rejects.toBe(reached);
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
