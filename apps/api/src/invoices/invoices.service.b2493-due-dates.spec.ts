/**
 * #2493 item 4 — the #2256 literal-day rule on the two from-order paths #2256 did not pin
 * (createPartialFromOrder, and createInvoiceFromOrderWithTenant, the worker path), and the import
 * CSV's "Due Date" (item 2).
 *
 * Zones are passed as DATA, never through `process.env.TZ`: jest hands each test file a COPY of the
 * environment, so assigning TZ there never reaches Node's zone cache (the analytics.service
 * .calendar.spec.ts lesson, archived L-047). A host-zone-dependent read is pinned with a stub Date
 * whose local and UTC calendar days differ, which discriminates on every host including UTC CI.
 *
 * Split out of invoices.service.spec.ts per the size ratchet. Same bootstrap as
 * invoices.service.b2256-due-date.spec.ts, duplicated deliberately so this file stays
 * self-contained.
 */

// Prevent Jest from traversing ESM-only dependencies
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));

jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { InvoiceStatus } from "@prisma/client";

import { importCalendarDay } from "../import/import.service";
import { isOverdue, overdueCutoff } from "../common/calendar-date";
import { recomputeInvoiceStatus } from "./invoice-status";
import { applyInvoiceStatusFilters } from "./invoice-list-query";
import { markOverdueForTenant } from "./overdue-sweep.service";
import * as fs from "fs";
import * as path from "path";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

describe("InvoicesService — #2493 due dates under a negative-offset process zone", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
  };
  const mockEmailService = {
    sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };
  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };
  const mockNumbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };

  beforeEach(async () => {
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();
    // #2070: createPartialFromOrder's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: mockCreditNotes },
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const day25 = new Date("2026-09-25T00:00:00.000Z");
  const OFFSET = "2026-09-25T23:30:00-05:00";
  const UTC_MIDNIGHT = "2026-09-25T20:00:00-04:00";

  const orderWith = (over: Record<string, unknown> = {}) => ({
    id: "ord-2493",
    customerId: "cust-1",
    orderNumber: "ORD-2493",
    subtotal: 20,
    tax: 0,
    shippingFee: 0,
    lineItems: [
      {
        id: "li-1",
        productId: "p1",
        name: null,
        qty: 2,
        invoicedQty: 0,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 10,
        subtotal: 20,
        originalPrice: null,
        priceType: "STANDARD",
        product: { name: "Widget", unitsPerBox: 0 },
      },
    ],
    ...over,
  });

  const seed = () => {
    jest
      .spyOn(service as any, "resolveDefaultTerms")
      .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
    jest
      .spyOn(service as any, "resolveTenantInvoiceDefaults")
      .mockResolvedValue({ notes: null, terms: null, timezone: "America/Los_Angeles" });
    jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-2493");
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false, defaultPaymentTerms: null });
    prisma.orderItem.update.mockResolvedValue({});
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ ...args.data, id: "inv-2493", items: [], payments: [], customer: {} }),
    );
  };

  it("createPartialFromOrder: dto dueDate and depositDueDate keep the literal day", async () => {
    seed();
    prisma.order.findUnique.mockResolvedValue(orderWith());
    await service.createPartialFromOrder("ord-2493", {
      items: [{ orderItemId: "li-1", qty: 2 }],
      dueDate: OFFSET,
      depositPercent: 50,
      depositDueDate: UTC_MIDNIGHT,
    } as any);
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.dueDate).toEqual(day25);
    expect(data.depositDueDate).toEqual(day25);
  });

  it("createPartialFromOrder: override dueDate and depositDueDate keep the literal day", async () => {
    seed();
    prisma.order.findUnique.mockResolvedValue(orderWith());
    await service.createPartialFromOrder(
      "ord-2493",
      { items: [{ orderItemId: "li-1", qty: 2 }] } as any,
      {
        dueDate: UTC_MIDNIGHT,
        depositPercent: 50,
        depositDueDate: OFFSET,
      },
    );
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.dueDate).toEqual(day25);
    expect(data.depositDueDate).toEqual(day25);
  });

  it("createInvoiceFromOrderWithTenant: override dueDate and depositDueDate keep the literal day", async () => {
    seed();
    prisma.order.findFirst.mockResolvedValue(orderWith());
    await service.createInvoiceFromOrderWithTenant("ord-2493", "test-tenant", {
      dueDate: OFFSET,
      depositPercent: 50,
      depositDueDate: UTC_MIDNIGHT,
    });
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.dueDate).toEqual(day25);
    expect(data.depositDueDate).toEqual(day25);
  });

  it("createInvoiceFromOrderWithTenant: an override that names no day is a 400", async () => {
    seed();
    prisma.order.findFirst.mockResolvedValue(orderWith());
    await expect(
      service.createInvoiceFromOrderWithTenant("ord-2493", "test-tenant", {
        dueDate: "2026-02-31",
      }),
    ).rejects.toThrow("dueDate must be a calendar date (YYYY-MM-DD)");
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  describe("import CSV 'Due Date' (item 2): importCalendarDay", () => {
    it.each([
      ["a bare ISO day", "2026-09-25"],
      ["an ISO datetime at an offset", OFFSET],
      ["an ISO instant at UTC midnight of the next day", UTC_MIDNIGHT],
      ["a US-style date", "09/25/2026"],
      ["a written date", "25 Sep 2026"],
      ["surrounding whitespace", "  2026-09-25  "],
    ])("%s → the day it names", (_label, raw) => {
      expect(importCalendarDay(raw)).toEqual(day25);
    });

    it("a non-ISO value reads the LOCAL calendar day of its own parse, never the UTC one", () => {
      // What `new Date("09/25/2026")` is on a host EAST of UTC: local Sep 25 00:00 = UTC Sep 24,
      // and west of UTC a late-evening parse is local Sep 25 / UTC Sep 26. Stubbed both ways so the
      // pin discriminates on any host (a getUTC* mutation turns it red).
      const stub = (utcDay: number) =>
        ({
          getTime: () => 0,
          getFullYear: () => 2026,
          getMonth: () => 8,
          getDate: () => 25,
          getUTCFullYear: () => 2026,
          getUTCMonth: () => 8,
          getUTCDate: () => utcDay,
        }) as unknown as Date;
      expect(importCalendarDay("09/25/2026", () => stub(24))).toEqual(day25);
      expect(importCalendarDay("09/25/2026", () => stub(26))).toEqual(day25);
    });

    it.each([
      ["", null],
      [null, null],
      ["not a date", null],
      ["2026-02-31", null],
    ])("%j → null (no due date), never an Invalid Date", (raw, expected) => {
      expect(importCalendarDay(raw)).toBe(expected);
    });
  });
  // ─── Item 3 (SA-488): OVERDUE only once the due day has ENDED in the tenant's zone ─────────────
  describe("item 3 — the one overdue rule (SA-488)", () => {
    const LA = "America/Los_Angeles"; // PDT (UTC-7) on 2026-09-25
    const due = new Date("2026-09-25T00:00:00.000Z");
    // 20:00 PDT on the due day = 03:00Z on the 26th (past the UTC end of the day).
    const eveningOfDueDayLA = new Date("2026-09-26T03:00:00.000Z");
    const at2330LA = new Date("2026-09-26T06:30:00.000Z"); // 23:30 PDT, still the due day
    const at0030LA = new Date("2026-09-26T07:30:00.000Z"); // 00:30 PDT, the day after

    /** The oracle, independent of calendar-date.ts: the calendar day `instant` falls on in `tz`. */
    const localDay = (instant: Date, tz: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(instant);

    it.each([
      ["UTC", "2026-09-25"],
      [LA, "2026-09-25"],
      ["Asia/Kolkata", "2026-09-25"],
      ["Pacific/Kiritimati", "2026-09-25"],
      ["Pacific/Pago_Pago", "2026-09-25"],
      // DST eves east of UTC (the review's case): the NEXT day starts on the other offset.
      ["Australia/Sydney", "2026-10-03"], // AEST +10 → AEDT +11 at 02:00 on Oct 4
      ["Pacific/Auckland", "2026-09-26"], // NZST +12 → NZDT +13 at 02:00 on Sep 27
      [LA, "2026-10-31"], // PDT -7 → PST -8 at 02:00 on Nov 1
    ])(
      "boundary table in %s (due %s): overdue exactly when the zone's day has moved past the due day",
      (tz, dueDay) => {
        const d = new Date(`${dueDay}T00:00:00.000Z`);
        // The true local midnight after the due day, found from the oracle alone.
        let lo = d.getTime() - 86_400_000;
        let hi = d.getTime() + 2 * 86_400_000;
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (localDay(new Date(mid), tz) > dueDay) hi = mid;
          else lo = mid;
        }
        expect(isOverdue(d, new Date(hi - 1), tz)).toBe(false);
        expect(isOverdue(d, new Date(hi), tz)).toBe(true);
        // Sweep D-1 .. D+2 every 15 minutes: the predicate, its SQL twin and the oracle agree.
        for (let t = d.getTime() - 86_400_000; t <= d.getTime() + 2 * 86_400_000; t += 900_000) {
          const now = new Date(t);
          const expected = localDay(now, tz) > dueDay;
          expect(isOverdue(d, now, tz)).toBe(expected);
          expect(d < overdueCutoff(now, tz)).toBe(expected);
        }
      },
    );

    it("no due date is never overdue", () => {
      expect(isOverdue(null, at0030LA, LA)).toBe(false);
    });

    it("recomputeStatus ± zone: a US tenant is NOT overdue at 20:00 local on the due day", () => {
      expect(recomputeInvoiceStatus(0, 100, due, "SENT" as any, LA, eveningOfDueDayLA)).toBe(
        "SENT",
      );
      expect(recomputeInvoiceStatus(0, 100, due, "SENT" as any, LA, at0030LA)).toBe("OVERDUE");
      // No zone: UTC — the due day ended at 00:00Z on the 26th.
      expect(recomputeInvoiceStatus(0, 100, due, "SENT" as any, null, eveningOfDueDayLA)).toBe(
        "OVERDUE",
      );
      // Payments and terminal states still win over the date.
      expect(recomputeInvoiceStatus(10, 100, due, "SENT" as any, LA, at0030LA)).toBe("PARTIAL");
      expect(recomputeInvoiceStatus(0, 100, due, "DRAFT" as any, LA, at0030LA)).toBe("DRAFT");
    });

    describe("five paths agree at 23:30 vs 00:30 local (LA tenant)", () => {
      afterEach(() => jest.useRealTimers());
      const at = (now: Date) =>
        jest.useFakeTimers({ now, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
      const tenantLA = () => {
        prisma.tenantConfig.findUnique.mockResolvedValue({
          invoiceNotes: null,
          invoiceTerms: null,
          timezone: LA,
        });
        jest.spyOn(prisma, "getTenantId").mockReturnValue("test-tenant");
      };

      it.each([
        ["23:30 local (still the due day)", at2330LA, false],
        ["00:30 local (the day after)", at0030LA, true],
      ])("%s", async (_label, now, overdue) => {
        at(now);
        tenantLA();
        // 1. the predicate  2. recomputeStatus
        expect(isOverdue(due, now, LA)).toBe(overdue);
        expect(recomputeInvoiceStatus(0, 100, due, "SENT" as any, LA, now) === "OVERDUE").toBe(
          overdue,
        );
        // 3. the list filter (isOverdue=true): the row is selected iff dueDate < where.dueDate.lt
        const where: any = {};
        applyInvoiceStatusFilters(where, { isOverdue: true } as any, LA);
        expect(due < where.dueDate.lt).toBe(overdue);
        // 4. the overdue cron (#2520: per tenant, OverdueSweepService)
        prisma.$executeRaw.mockResolvedValue(0);
        await markOverdueForTenant(prisma as any, "test-tenant", now);
        // SA-770: the sweep's UPDATE carries the cutoff as a bound ISO instant
        const swept = (prisma.$executeRaw.mock.calls[0][0] as { values: unknown[] }).values.find(
          (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v),
        ) as string;
        expect(due < new Date(swept)).toBe(overdue);
        // 5. the KPI summary buckets on the TENANT's today, whatever day the viewer sends
        prisma.invoice.findMany.mockResolvedValue([
          { id: "inv-due", total: 100, dueDate: due, status: "SENT", payments: [] },
        ]);
        prisma.invoice.count.mockResolvedValue(0);
        prisma.$queryRaw.mockResolvedValue([{ avgDays: 0 }]);
        const kpi = await service.getKpiSummary("2026-09-20", {
          sub: "op",
          role: "OPERATOR",
        } as any);
        expect(kpi.overdue).toBe(overdue ? 100 : 0);
        expect(kpi.dueToday).toBe(overdue ? 0 : 100);
      });
    });

    it("no raw `dueDate < now` compare survives in the overdue paths (tripwire, with a control)", () => {
      const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      const raw = /dueDate\)? *(<|>=) *(now|new Date\(\))|dueDate: \{ lt: (now|new Date\(\)) \}/;
      expect(raw.test("if (inv.dueDate && inv.dueDate < now) x();")).toBe(true); // control
      for (const rel of [
        "invoices/invoices.service.ts",
        "invoices/invoice-status.ts",
        "invoices/invoice-list-query.ts",
        "credit-notes/credit-notes.service.ts",
        "bookkeeping/bookkeeping.service.ts",
      ]) {
        expect({ rel, hit: raw.test(read(rel)) }).toEqual({ rel, hit: false });
      }
    });
  });
});
