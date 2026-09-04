import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * F13 red set — B46 (MONTHLY schedule), B106 (failure/success outcome recording),
 * B92 (recurring template item replace). Every proof title below carries its
 * REG-B## token; see test-plan.md §2 for T# -> requirement mapping.
 */
describe("RecurringInvoicesService — schedule + outcome (F13)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock; send: jest.Mock; sendEmail: jest.Mock };

  const template = (overrides: Record<string, unknown> = {}) => ({
    id: "ri-1",
    customerId: "c1",
    discount: 0,
    shippingFee: 0,
    notes: null,
    terms: null,
    autoSend: false,
    frequency: "MONTHLY",
    dayOfWeek: null,
    dayOfMonth: 15,
    nextRunAt: new Date(2026, 6, 15),
    items: [{ description: "x", productId: null, qty: 1, unitPrice: 10, discount: 0, taxRate: 0 }],
    ...overrides,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoices = {
      create: jest.fn().mockResolvedValue({ id: "inv-1" }),
      send: jest.fn().mockResolvedValue({ id: "inv-1" }),
      sendEmail: jest.fn().mockResolvedValue({ success: true }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: invoices },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
    prisma.invoice.update.mockResolvedValue({ id: "inv-1" });
  });

  const calcNextRunAt = (
    frequency: string,
    dayOfWeek: number | null,
    dayOfMonth: number | null,
    from: Date,
  ): Date => (service as any).calcNextRunAt(frequency, dayOfWeek, dayOfMonth, from);

  describe("MONTHLY next-run calculation (R1/R2, B46)", () => {
    it("REG-B46 T1 — the next occurrence of dayOfMonth is the earliest one strictly after `from`", () => {
      const result = calcNextRunAt("MONTHLY", null, 15, new Date(2026, 6, 15));
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(7); // August (0-indexed)
      expect(result.getDate()).toBe(15);
    });

    // T2 (the dom-31 clamp) is NOT a red proof and lives in
    // recurring-invoices.service.spec.ts as a pin instead: a month-end `from` is
    // already advanced past the dead `setDate(1)` compare by the unconditional
    // `+1 day`, and `Math.min(dom, daysInMonth)` already clamps, so dom 31 cannot
    // expose B46. R2's red coverage stands on T3 (year roll) and T6 (12-cycle
    // strict advance).

    it("REG-B46 T1b — a corrupt dayOfMonth (0 or negative) is clamped, never looped on", () => {
      // The column is a nullable Int with no DB constraint and the PATCH was unvalidated
      // until B92, so 0/negative rows are reachable. Unclamped, occurrence(y, m) lands in
      // month m-1 and the advance loop never terminates — hanging the cron and the API.
      const zero = calcNextRunAt("MONTHLY", null, 0, new Date(2026, 6, 20));
      expect(zero.getFullYear()).toBe(2026);
      expect(zero.getMonth()).toBe(7); // August
      expect(zero.getDate()).toBe(1);
      expect(calcNextRunAt("MONTHLY", null, -3, new Date(2026, 6, 20)).getTime()).toBe(
        zero.getTime(),
      );
    });

    it("REG-B46 T3 — December rolls into January of the next year", () => {
      const result = calcNextRunAt("MONTHLY", null, 15, new Date(2026, 11, 15));
      expect(result.getFullYear()).toBe(2027);
      expect(result.getMonth()).toBe(0); // January
      expect(result.getDate()).toBe(15);
    });

    it("REG-B46 T5 — a time-of-day on `from` is treated as its calendar day", () => {
      const result = calcNextRunAt("MONTHLY", null, 15, new Date(2026, 6, 15, 10, 30));
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(7); // August
      expect(result.getDate()).toBe(15);
      expect(result.getHours()).toBe(0);
    });

    it("REG-B46 T6 — twelve consecutive cycles each strictly advance and land on the 15th (Feb 2026 .. Jan 2027)", () => {
      const expectedSequence: Array<[number, number]> = [
        [2026, 1],
        [2026, 2],
        [2026, 3],
        [2026, 4],
        [2026, 5],
        [2026, 6],
        [2026, 7],
        [2026, 8],
        [2026, 9],
        [2026, 10],
        [2026, 11],
        [2027, 0],
      ];
      let current = new Date(2026, 0, 15);
      for (let cycle = 0; cycle < 12; cycle++) {
        const next = calcNextRunAt("MONTHLY", null, 15, current);
        expect(next.getTime()).toBeGreaterThan(current.getTime());
        expect(next.getDate()).toBe(15);
        expect(next.getFullYear()).toBe(expectedSequence[cycle][0]);
        expect(next.getMonth()).toBe(expectedSequence[cycle][1]);
        current = next;
      }
    });
  });

  describe("cycle claim carries the corrected nextRunAt (R4, B46)", () => {
    // R4 is a claim about `now`, not about a fixed calendar month, so these two use a
    // due date derived from today: a hard-coded past `from` would pass while the claim
    // still landed in the past (which is exactly what B46's nightly re-fire was).
    it("REG-B46 T7 — generateInvoiceFromTemplate claims the cycle with the strictly-future nextRunAt", async () => {
      const due = new Date();
      due.setHours(0, 0, 0, 0);
      const ri = template({ nextRunAt: due });
      prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
      invoices.create.mockResolvedValue({ id: "inv-1" });

      const before = Date.now();
      await (service as any).generateInvoiceFromTemplate(ri);

      expect(prisma.recurringInvoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ri-1", nextRunAt: ri.nextRunAt } }),
      );
      const claimed: Date = prisma.recurringInvoice.updateMany.mock.calls[0][0].data.nextRunAt;
      expect(claimed.getTime()).toBeGreaterThan(before);
      expect(claimed.getDate()).toBe(15); // the template's dayOfMonth, re-applied
    });

    it("REG-B46 T7b — a months-overdue template is claimed into the future, not one month on", async () => {
      // B46 froze MONTHLY templates at their original due date, so the rows this fix meets
      // on deploy day are months behind. Advancing one cycle from the stored value would
      // still be <= now and the midnight cron would re-select the template every night,
      // minting one real customer invoice per night until the backlog cleared.
      const stale = new Date();
      stale.setHours(0, 0, 0, 0);
      stale.setMonth(stale.getMonth() - 8);
      const ri = template({ nextRunAt: stale });
      prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
      invoices.create.mockResolvedValue({ id: "inv-1" });

      const before = Date.now();
      await (service as any).generateInvoiceFromTemplate(ri);

      const claimed: Date = prisma.recurringInvoice.updateMany.mock.calls[0][0].data.nextRunAt;
      expect(claimed.getTime()).toBeGreaterThan(before);
      expect(claimed.getDate()).toBe(15);
    });
  });

  describe("failure/success outcome recording (R12-R15, B106)", () => {
    it("REG-B106 T17 — a create failure restores nextRunAt, records FAILED, and rethrows the original error", async () => {
      const ri = template({ nextRunAt: new Date(2026, 6, 15) });
      prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
      const failure = new NotFoundException("Customer not found");
      invoices.create.mockRejectedValue(failure);

      await expect((service as any).generateInvoiceFromTemplate(ri)).rejects.toBe(failure);

      expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({
        where: { id: "ri-1" },
        data: expect.objectContaining({
          nextRunAt: ri.nextRunAt,
          lastRunStatus: "FAILED",
          lastError: expect.stringContaining("Customer not found"),
        }),
      });
      const failedWrite = prisma.recurringInvoice.update.mock.calls.find(
        (c: any) => c[0]?.data?.lastRunStatus === "FAILED",
      );
      expect(failedWrite?.[0].data).not.toHaveProperty("lastRunAt");
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("REG-B106 T17b — a failure AFTER the invoice exists records the billed-but-unfinalized state and keeps the advanced nextRunAt", async () => {
      const ri = template({ nextRunAt: new Date(2026, 6, 15) });
      prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
      invoices.create.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.update.mockRejectedValue(new Error("connection reset"));

      // The invoice exists, so the caller gets it — the run is not reported as nothing.
      await expect((service as any).generateInvoiceFromTemplate(ri)).resolves.toEqual({
        id: "inv-1",
      });

      const write = prisma.recurringInvoice.update.mock.calls[0][0];
      expect(write.data.lastRunStatus).toBe("FAILED");
      // NOT the claim's "interrupted before the invoice was created" — that text is false
      // here, and the web card turns a retryable failure into a Run Now that would bill
      // this already-invoiced cycle a second time.
      expect(write.data.lastError).toContain(
        "The invoice was created but the run could not be finalized",
      );
      expect(write.data.lastError).toContain("connection reset");
      expect(write.data).not.toHaveProperty("nextRunAt");
    });

    it("REG-B106 T18 — SUCCESS is recorded only after the invoice is created and linked", async () => {
      const ri = template({ nextRunAt: new Date(2026, 6, 15) });
      const calls: string[] = [];
      prisma.recurringInvoice.updateMany.mockImplementation(() => {
        calls.push("claim");
        return Promise.resolve({ count: 1 });
      });
      invoices.create.mockImplementation(() => {
        calls.push("create");
        return Promise.resolve({ id: "inv-1" });
      });
      prisma.invoice.update.mockImplementation(() => {
        calls.push("link");
        return Promise.resolve({ id: "inv-1" });
      });
      prisma.recurringInvoice.update.mockImplementation((a: any) => {
        calls.push("status:" + a.data.lastRunStatus);
        return Promise.resolve({});
      });

      await (service as any).generateInvoiceFromTemplate(ri);

      expect(calls).toEqual(["claim", "create", "link", "status:SUCCESS"]);
      const successWrite = prisma.recurringInvoice.update.mock.calls[0][0];
      expect(successWrite.data).toEqual({ lastRunStatus: "SUCCESS", lastError: null });
      expect(prisma.recurringInvoice.updateMany).toHaveBeenCalledTimes(1);
    });

    it("REG-B106 T19 — the claim itself stamps a provisional FAILED outcome before the invoice is created", async () => {
      const ri = template({ nextRunAt: new Date(2026, 6, 15) });
      prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
      invoices.create.mockResolvedValue({ id: "inv-1" });

      await (service as any).generateInvoiceFromTemplate(ri);

      const claimCall = prisma.recurringInvoice.updateMany.mock.calls[0][0];
      expect(claimCall.data).toHaveProperty("nextRunAt");
      expect(claimCall.data).toHaveProperty("lastRunAt");
      expect(claimCall.data.lastRunStatus).toBe("FAILED");
      expect(typeof claimCall.data.lastError).toBe("string");
      expect(claimCall.data.lastError.length).toBeGreaterThan(0);
    });
  });

  describe("recurring template item replace (R25, B92)", () => {
    it("REG-B92 T31 — item replacement runs inside one tenantTransaction with tenantId stamped on nested creates", async () => {
      prisma.recurringInvoice.findUnique.mockResolvedValue({ id: "ri-1", customerId: "c1" });
      const calls: string[] = [];
      prisma.recurringInvoiceItem.deleteMany.mockImplementation(() => {
        calls.push("delete");
        return Promise.resolve({ count: 1 });
      });
      prisma.recurringInvoice.update.mockImplementation((a: any) => {
        calls.push("update");
        return Promise.resolve({ id: "ri-1", ...a.data });
      });

      await service.update("ri-1", {
        items: [{ description: "d", qty: 1, unitPrice: 5 } as any],
      });

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["delete", "update"]);
      // Asserted at the top level, not inside the mock: an assertion that only runs
      // when the call happens can never fail on the call being absent.
      expect(prisma.recurringInvoiceItem.deleteMany).toHaveBeenCalledWith({
        where: { recurringInvoiceId: "ri-1" },
      });
      const updateCall = prisma.recurringInvoice.update.mock.calls[0][0];
      expect(updateCall.data.items.create[0]).toMatchObject({
        description: "d",
        qty: 1,
        unitPrice: 5,
        discount: 0,
        taxRate: 0,
        tenantId: "test-tenant",
      });
    });
  });
});
