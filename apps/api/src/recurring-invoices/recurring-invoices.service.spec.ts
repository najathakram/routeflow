// `@LeaderCron` wraps every cron tick in a Postgres advisory lock (common/cron-lock.ts).
// These specs invoke the tick directly and have no database, so the lock is a PASS-THROUGH here:
// it must still call the body — a mock that skipped it would make every assertion below measure
// a tick that never ran.
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
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * Locks the pause/resume contract. `deactivate()` (DELETE) sets isActive=false;
 * `activate()` (POST /:id/activate) sets it back to true — the ONLY resume path,
 * since update() never maps isActive and the ValidationPipe rejects a partial
 * `{ isActive }` PATCH body.
 */
describe("RecurringInvoicesService (pause/resume)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
    // findOne() (called by activate/deactivate) needs the row to exist.
    prisma.recurringInvoice.findUnique.mockResolvedValue({ id: "ri-1", isActive: false });
    prisma.recurringInvoice.update.mockImplementation((a: any) =>
      Promise.resolve({ id: "ri-1", ...a.data }),
    );
  });

  it("activate() sets isActive=true", async () => {
    const res = await service.activate("ri-1");
    expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({
      where: { id: "ri-1" },
      data: { isActive: true },
    });
    expect(res.isActive).toBe(true);
  });

  it("deactivate() sets isActive=false", async () => {
    const res = await service.deactivate("ri-1");
    expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({
      where: { id: "ri-1" },
      data: { isActive: false },
    });
    expect(res.isActive).toBe(false);
  });

  it("activate() 404s when the template is missing", async () => {
    prisma.recurringInvoice.findUnique.mockResolvedValue(null);
    await expect(service.activate("nope")).rejects.toThrow();
    expect(prisma.recurringInvoice.update).not.toHaveBeenCalled();
  });
});

// R5 — auto-send must ACTUALLY email the customer (was mark-as-sent-only, which flipped
// the invoice to SENT without any email despite the "Auto-send to customer" setting).
describe("RecurringInvoicesService (auto-send honesty, R5)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock; send: jest.Mock; sendEmail: jest.Mock };

  const template = (autoSend: boolean) => ({
    id: "ri-1",
    customerId: "c1",
    discount: 0,
    shippingFee: 0,
    notes: null,
    terms: null,
    autoSend,
    frequency: "MONTHLY",
    dayOfWeek: null,
    dayOfMonth: 1,
    nextRunAt: new Date("2026-07-01"),
    items: [{ description: "x", productId: null, qty: 1, unitPrice: 10, discount: 0, taxRate: 0 }],
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
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" });
    // CAS claim (updateMany) must succeed for generation to proceed at all — see B9.
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
  });

  it("auto-send EMAILS the invoice (sendEmail), not the mark-as-sent-only path", async () => {
    await (service as any).generateInvoiceFromTemplate(template(true));
    expect(invoices.sendEmail).toHaveBeenCalledWith("inv-1");
    expect(invoices.send).not.toHaveBeenCalled();
  });

  it("does NOT send anything when autoSend is off", async () => {
    await (service as any).generateInvoiceFromTemplate(template(false));
    expect(invoices.sendEmail).not.toHaveBeenCalled();
    expect(invoices.send).not.toHaveBeenCalled();
  });

  it("still completes generation (no throw) and advances the schedule when the email fails", async () => {
    invoices.sendEmail.mockRejectedValueOnce({ response: { code: "EMAIL_NOT_CONFIGURED" } });
    await expect(
      (service as any).generateInvoiceFromTemplate(template(true)),
    ).resolves.toBeDefined();
    // The invoice is left generated (DRAFT) and the cycle was still claimed (nextRunAt advanced).
    expect(prisma.recurringInvoice.updateMany).toHaveBeenCalled();
  });
});

// B9 — the cycle must be claimed (CAS on nextRunAt) BEFORE the invoice is created, not
// after. Previously the advance was the last statement, so runNow racing the cron (or a
// crash after create) could mint a duplicate invoice for the same cycle.
describe("RecurringInvoicesService (cycle claim, B9)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock; send: jest.Mock; sendEmail: jest.Mock };

  const template = () => ({
    id: "ri-1",
    customerId: "c1",
    discount: 0,
    shippingFee: 0,
    notes: null,
    terms: null,
    autoSend: false,
    frequency: "MONTHLY",
    dayOfWeek: null,
    dayOfMonth: 1,
    nextRunAt: new Date("2026-07-01"),
    items: [{ description: "x", productId: null, qty: 1, unitPrice: 10, discount: 0, taxRate: 0 }],
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

  it("returns null and creates no invoice when the CAS claim matches nothing (already claimed by a racing caller)", async () => {
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 0 });

    const result = await (service as any).generateInvoiceFromTemplate(template());

    expect(result).toBeNull();
    expect(invoices.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    // T20 (pin, R18): a lost claim records no outcome either.
    expect(prisma.recurringInvoice.update).not.toHaveBeenCalled();
  });

  it("claims the cycle via updateMany BEFORE creating the invoice, and advances nextRunAt exactly once on the happy path", async () => {
    const callOrder: string[] = [];
    prisma.recurringInvoice.updateMany.mockImplementation((args: any) => {
      callOrder.push("claim");
      expect(args.where).toEqual({ id: "ri-1", nextRunAt: new Date("2026-07-01") });
      expect(args.data.nextRunAt).toBeInstanceOf(Date);
      return Promise.resolve({ count: 1 });
    });
    invoices.create.mockImplementation(() => {
      callOrder.push("create");
      return Promise.resolve({ id: "inv-1" });
    });

    const result = await (service as any).generateInvoiceFromTemplate(template());

    expect(result).toEqual({ id: "inv-1" });
    expect(callOrder).toEqual(["claim", "create"]);
    expect(prisma.recurringInvoice.updateMany).toHaveBeenCalledTimes(1);
    // No trailing advance — the CAS claim above is the only nextRunAt write.
    // (R13, B106: the happy path legitimately calls recurringInvoice.update once more
    // to record the SUCCESS outcome after the invoice is linked — the pin's real intent
    // is "no second nextRunAt write", so it is asserted directly rather than via a
    // blanket "never called".)
    const nextRunWrites = prisma.recurringInvoice.update.mock.calls.filter(
      (c: any) => "nextRunAt" in (c[0]?.data ?? {}),
    );
    expect(nextRunWrites).toHaveLength(0);
  });
});

// T4 (pin, R1) — same-month boundary guard: an operator-set first run earlier in the
// month than dayOfMonth still lands on that month's occurrence, not next month.
// T2 (pin, R2) — the dom-31 clamp. NOT a B46 proof: a month-end `from` is rolled into
// the next month by the unconditional `+1 day` BEFORE the buggy `setDate(1)` compare is
// reached, and `Math.min(dom, daysInMonth)` already clamps, so dom 31 passes today and
// must keep passing after the fix.
describe("RecurringInvoicesService (calcNextRunAt MONTHLY pins)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
  });

  it("dayOfMonth 15, from 2026-07-10 (earlier in the same month) -> 2026-07-15", () => {
    const result = (service as any).calcNextRunAt("MONTHLY", null, 15, new Date(2026, 6, 10));
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(6); // July
    expect(result.getDate()).toBe(15);
  });

  it("pin (T2, R2): dayOfMonth 31 clamps 2026-01-31 -> Feb 28 -> Mar 31", () => {
    const first = (service as any).calcNextRunAt("MONTHLY", null, 31, new Date(2026, 0, 31));
    expect(first.getFullYear()).toBe(2026);
    expect(first.getMonth()).toBe(1); // February (2026 is not a leap year)
    expect(first.getDate()).toBe(28);

    const second = (service as any).calcNextRunAt("MONTHLY", null, 31, first);
    expect(second.getFullYear()).toBe(2026);
    expect(second.getMonth()).toBe(2); // March
    expect(second.getDate()).toBe(31);
  });
});

// T8 (pin, R3) — WEEKLY/BIWEEKLY next-run computation is unchanged by the MONTHLY fix.
describe("RecurringInvoicesService (calcNextRunAt WEEKLY/BIWEEKLY, pin)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
  });

  it("WEEKLY dayOfWeek 1, from Mon 2026-07-13 -> next Monday 2026-07-20", () => {
    const result = (service as any).calcNextRunAt("WEEKLY", 1, null, new Date(2026, 6, 13));
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(6); // July
    expect(result.getDate()).toBe(20);
  });

  it("BIWEEKLY dayOfWeek 1, from Mon 2026-07-13 -> 2026-07-27 (next Monday + 7 days)", () => {
    const result = (service as any).calcNextRunAt("BIWEEKLY", 1, null, new Date(2026, 6, 13));
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(6); // July
    expect(result.getDate()).toBe(27);
  });

  it("WEEKLY dayOfWeek 3, from Mon 2026-07-13 -> 2026-07-15 (next Wednesday)", () => {
    const result = (service as any).calcNextRunAt("WEEKLY", 3, null, new Date(2026, 6, 13));
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(6); // July
    expect(result.getDate()).toBe(15);
  });
});

// T21 (pin, R19) — the midnight cron must keep going after one template throws:
// generateInvoiceFromTemplate is wrapped in a per-template try/catch, so a failure on
// the first due template still leaves the second one attempted. This passes today and
// must keep passing once B106's outcome recording is added inside that same path.
describe("RecurringInvoicesService (cron continues past a failing template, pin)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock; send: jest.Mock; sendEmail: jest.Mock };

  const template = (id: string) => ({
    id,
    customerId: "c1",
    discount: 0,
    shippingFee: 0,
    notes: null,
    terms: null,
    autoSend: false,
    frequency: "MONTHLY",
    dayOfWeek: null,
    dayOfMonth: 1,
    nextRunAt: new Date("2026-07-01"),
    items: [{ description: "x", productId: null, qty: 1, unitPrice: 10, discount: 0, taxRate: 0 }],
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoices = {
      create: jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ id: "inv-2" }),
      send: jest.fn().mockResolvedValue({ id: "inv-2" }),
      sendEmail: jest.fn().mockResolvedValue({ success: true }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id: string, fn: () => unknown) => fn()) },
        },
        { provide: InvoicesService, useValue: invoices },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);

    prisma.tenant.findMany.mockResolvedValue([{ id: "t1" }]);
    prisma.recurringInvoice.findMany.mockResolvedValue([template("ri-1"), template("ri-2")]);
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" });
    prisma.invoice.update.mockResolvedValue({ id: "inv-2" });
  });

  it("attempts the second due template after the first one throws", async () => {
    await service.generateDueRecurringInvoices();
    expect(invoices.create).toHaveBeenCalledTimes(2);
  });
});
