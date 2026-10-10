/**
 * #2520 (SA-495a, tier 1): the PERSISTED OVERDUE status uses the tenant's zone.
 *
 * F2's executed #2518 proof: a PATCH of terms at 23:30 CDT on the due day stamped OVERDUE, because
 * the status writer had no zone (UTC's day had already ended). `statusFromPayments`'s timeZone
 * is now REQUIRED, so every writer passes the tenant's zone, and `markOverdue` runs per tenant under
 * @LeaderCron (OverdueSweepService), each on its own zone's day. Zones are passed as data (jest
 * cannot move the host zone). Bootstrap copied from invoices.service.b2256-due-date.spec.ts.
 */
// @LeaderCron runs its tick inside a try-mode advisory lock; grant it (the precedent in
// authorization-expiry.service.spec.ts), keeping every other db-locks export real.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
}));

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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { InvoiceStatus } from "@prisma/client";

import {
  markOverdueForTenant,
  OverdueSweepService,
  overdueSweepMode,
} from "./overdue-sweep.service";
import { tenantTimeZone } from "../common/tenant-time-zone";
import * as fs from "fs";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import * as path from "path";

describe("#2520 — persisted OVERDUE in the tenant zone", () => {
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
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
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
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  afterEach(() => jest.useRealTimers());
  const at = (iso: string) =>
    jest.useFakeTimers({
      now: new Date(iso),
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
  const CHICAGO = "America/Chicago"; // CDT (UTC-5) on 2026-10-01
  const tenantZone = (tz: string | null) => {
    jest.spyOn(prisma, "getTenantId").mockReturnValue("test-tenant");
    prisma.tenantConfig.findUnique.mockResolvedValue(
      tz ? { timezone: tz, invoiceNotes: null, invoiceTerms: null } : null,
    );
  };

  describe("F1: a PATCH of terms on the due day (the executed #2518 finding)", () => {
    const sent = {
      id: "inv-2520",
      status: InvoiceStatus.SENT,
      total: 100,
      dueDate: new Date("2026-09-20T00:00:00.000Z"),
      internalNotes: null,
      payments: [],
    };
    const patchAt = async (iso: string) => {
      at(iso);
      tenantZone(CHICAGO);
      prisma.invoice.findUnique.mockResolvedValue(sent);
      prisma.invoice.update.mockResolvedValue({ id: sent.id });
      await service.updateTerms(sent.id, { dueDate: "2026-10-01" });
      return prisma.invoice.update.mock.calls[0][0].data.status;
    };

    it("23:30 CDT on the due day ⇒ stays SENT", async () => {
      expect(await patchAt("2026-10-02T04:30:00.000Z")).toBe(InvoiceStatus.SENT);
    });

    it("00:30 CDT the next day ⇒ OVERDUE", async () => {
      expect(await patchAt("2026-10-02T05:30:00.000Z")).toBe(InvoiceStatus.OVERDUE);
    });

    it("control: a tenant with no zone uses UTC — the same instant is OVERDUE", async () => {
      at("2026-10-02T04:30:00.000Z");
      tenantZone(null);
      prisma.invoice.findUnique.mockResolvedValue(sent);
      prisma.invoice.update.mockResolvedValue({ id: sent.id });
      await service.updateTerms(sent.id, { dueDate: "2026-10-01" });
      expect(prisma.invoice.update.mock.calls[0][0].data.status).toBe(InvoiceStatus.OVERDUE);
    });
  });

  describe("markOverdue: @LeaderCron, per tenant, each on its own zone's day", () => {
    // 04:30Z on Oct 2 is 23:30 Oct 1 in Chicago and 13:30 Oct 2 in Tokyo.
    const now = new Date("2026-10-02T04:30:00.000Z");
    const zones: Record<string, string | null> = {
      "t-chi": CHICAGO,
      "t-tyo": "Asia/Tokyo",
      "t-utc": null,
    };
    const ORIGINAL = process.env.OVERDUE_SWEEP_MODE;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.OVERDUE_SWEEP_MODE;
      else process.env.OVERDUE_SWEEP_MODE = ORIGINAL;
    });

    const sweep = () => {
      const tenantCtx = { run: jest.fn((_id: string, fn: () => unknown) => fn()) };
      prisma.tenant.findMany.mockResolvedValue(Object.keys(zones).map((id) => ({ id })));
      prisma.tenantConfig.findUnique.mockImplementation(async (args: any) =>
        zones[args.where.tenantId] ? { timezone: zones[args.where.tenantId] } : null,
      );
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.count.mockResolvedValue(2);
      const svc = new OverdueSweepService(prisma as any, tenantCtx as any);
      const log = jest.spyOn((svc as any).logger, "log").mockImplementation(() => undefined);
      const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation(() => undefined);
      return { svc, tenantCtx, log, warn };
    };
    const cutoffFor = (fn: jest.Mock, tenantId: string) =>
      fn.mock.calls.find((c: any[]) => c[0].where.tenantId === tenantId)![0].where.dueDate.lt;

    it("enforced: flips every billing-live tenant with an explicit tenant filter, each in its own zone", async () => {
      process.env.OVERDUE_SWEEP_MODE = "enforced";
      at(now.toISOString());
      const { svc, tenantCtx } = sweep();
      await svc.runScheduled();
      expect(prisma.tenant.findMany.mock.calls[0][0].where.status.in).toEqual(["TRIAL", "ACTIVE"]);
      expect(tenantCtx.run.mock.calls.map((c: any[]) => c[0])).toEqual(["t-chi", "t-tyo", "t-utc"]);
      expect(prisma.invoice.count).not.toHaveBeenCalled();
      // An invoice due Oct 1: still grace in Chicago, overdue in Tokyo and in UTC.
      const due = new Date("2026-10-01T00:00:00.000Z");
      expect(due < cutoffFor(prisma.invoice.updateMany, "t-chi")).toBe(false);
      expect(due < cutoffFor(prisma.invoice.updateMany, "t-tyo")).toBe(true);
      expect(due < cutoffFor(prisma.invoice.updateMany, "t-utc")).toBe(true);
      // #2567: the write itself: one updateMany per tenant, and it sets OVERDUE and nothing else.
      expect(prisma.invoice.updateMany).toHaveBeenCalledTimes(3);
      for (const c of prisma.invoice.updateMany.mock.calls)
        expect(c[0].data).toEqual({ status: "OVERDUE" });
    });

    it("B2: only SENT and VIEWED are ever flipped (never PARTIAL)", async () => {
      const { svc } = sweep();
      await svc.markOverdue(now, "enforced");
      for (const c of prisma.invoice.updateMany.mock.calls)
        expect(c[0].where.status.in).toEqual(["SENT", "VIEWED"]);
    });

    it.each(["dark"])(
      "dark (mode %s — emergency dark-back): the SAME where as a COUNT, one log line by tenant id, nothing written",
      async (v) => {
        if (v === undefined) delete process.env.OVERDUE_SWEEP_MODE;
        else process.env.OVERDUE_SWEEP_MODE = v;
        at(now.toISOString());
        const { svc, log } = sweep();
        await svc.runScheduled();
        expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
        expect(prisma.invoice.count).toHaveBeenCalledTimes(3);
        for (const c of prisma.invoice.count.mock.calls)
          expect(c[0].where).toEqual(
            expect.objectContaining({ status: { in: ["SENT", "VIEWED"] } }),
          );
        const due = new Date("2026-10-01T00:00:00.000Z");
        expect(due < cutoffFor(prisma.invoice.count, "t-chi")).toBe(false);
        expect(log).toHaveBeenCalledTimes(1);
        expect(String(log.mock.calls[0][0])).toBe(
          "markOverdue [dark]: 6 invoice(s) WOULD flip (nothing written) across 3 tenant(s), 0 failed; per tenant t-chi=2, t-tyo=2, t-utc=2",
        );
      },
    );

    it("off: runs NO query and logs that it is off", async () => {
      process.env.OVERDUE_SWEEP_MODE = "off";
      const { svc, log } = sweep();
      await svc.runScheduled();
      expect(prisma.tenant.findMany).not.toHaveBeenCalled();
      expect(prisma.invoice.count).not.toHaveBeenCalled();
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(String(log.mock.calls[0][0])).toMatch(/\[off\].*ran no query/);
    });

    it("an unknown value runs DARK with a warning (fail closed toward no writes)", async () => {
      process.env.OVERDUE_SWEEP_MODE = "true";
      const { svc, warn } = sweep();
      await svc.runScheduled();
      expect(warn.mock.calls[0][0]).toMatch(/OVERDUE_SWEEP_MODE="true" is not off\|dark\|enforced/);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(prisma.invoice.count).toHaveBeenCalledTimes(3);
      expect(overdueSweepMode({ OVERDUE_SWEEP_MODE: " Enforced " }).mode).toBe("enforced");
    });

    // #2567: a set-but-blank value ("" or whitespace) is a misconfiguration: it runs dark WITH the
    // warning. Only a truly unset variable is the silent default.
    it.each(["", "  ", "\t"])("a blank value %j runs dark with a warning", async (v) => {
      process.env.OVERDUE_SWEEP_MODE = v;
      expect(overdueSweepMode()).toEqual({ mode: "dark", unknown: v });
      const { svc, warn } = sweep();
      await svc.runScheduled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/is not off\|dark\|enforced; running dark/);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });

    it("an unset value is the silent enforced default (owner 2026-10-10); dark-back is explicit", () => {
      expect(overdueSweepMode({})).toEqual({ mode: "enforced", unknown: null });
      expect(overdueSweepMode({ OVERDUE_SWEEP_MODE: "dark" }).mode).toBe("dark");
    });

    it("one tenant failing never stops the others", async () => {
      const { svc } = sweep();
      prisma.invoice.updateMany
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ count: 2 });
      const res = await svc.markOverdue(now, "enforced");
      expect(res).toEqual({ mode: "enforced", tenants: 3, rows: 4, failed: 1 });
    });

    it("fails closed without a tenant id (never an unscoped sweep)", async () => {
      await expect(markOverdueForTenant(prisma as any, "", now)).rejects.toThrow(/tenant id/);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });

    it("is scheduled with @LeaderCron under a stable key, and InvoicesService no longer carries it", () => {
      const src = fs.readFileSync(path.join(__dirname, "overdue-sweep.service.ts"), "utf8");
      expect(src).toMatch(
        /@LeaderCron\("5 \* \* \* \*", "invoices\.markOverdue"\)\s*\n\s*async runScheduled\(\): Promise<void> \{/,
      );
      const inv = fs.readFileSync(path.join(__dirname, "invoices.service.ts"), "utf8");
      expect(inv).not.toMatch(/async markOverdue\(/);
      const mod = fs.readFileSync(path.join(__dirname, "invoices.module.ts"), "utf8");
      expect(mod).toMatch(/OverdueSweepService/);
    });
  });

  it("B3: the zone comes from an EXPLICIT tenant id when there is no ambient tenant", async () => {
    jest.spyOn(prisma, "getTenantId").mockReturnValue(undefined as any);
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: CHICAGO });
    await expect(tenantTimeZone(prisma as any, { tenantId: "t-explicit" })).resolves.toBe(CHICAGO);
    expect(prisma.tenantConfig.findUnique.mock.calls[0][0].where).toEqual({
      tenantId: "t-explicit",
    });
    prisma.tenantConfig.findUnique.mockClear();
    await expect(tenantTimeZone(prisma as any)).resolves.toBeNull();
    expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
    const cn = fs.readFileSync(
      path.join(__dirname, "..", "credit-notes/credit-notes.service.ts"),
      "utf8",
    );
    expect(cn).toMatch(
      /async settleOrderCreditsInTx\([\s\S]*?tenantTimeZone\(this\.prisma, \{ tenantId \}\)/,
    );
  });

  it("every persisted-status writer passes the tenant zone (the required parameter, counted)", () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const calls = (src: string) => src.match(/statusFromPayments\(/g)?.length ?? 0;
    // 10 writers + the injected price-adjustment dep in invoices.service (voidPayment's writer moved verbatim
    // to payment-void-tx.ts, SA-762r, counted next); in credit notes the 3 settlement writers + #2536's
    // voidPreview (a read-only preview of the status after a void).
    expect(calls(read("invoices/invoices.service.ts"))).toBe(11);
    expect(calls(read("invoices/payment-void-tx.ts"))).toBe(1);
    expect(read("invoices/payment-void-tx.ts")).toMatch(
      /statusFromPayments\(\s*totalPaid,[\s\S]*?\btz,/,
    );
    expect(calls(read("credit-notes/credit-notes.service.ts"))).toBe(4);
    for (const rel of ["invoices/invoices.service.ts", "credit-notes/credit-notes.service.ts"])
      expect(read(rel)).not.toMatch(/recomputeStatus\(/);
  });
});
