/**
 * #2520 (SA-495a, tier 1): the PERSISTED OVERDUE status uses the tenant's zone.
 *
 * F2's executed #2518 proof: a PATCH of terms at 23:30 CDT on the due day stamped OVERDUE, because
 * the status writer had no zone (UTC's day had already ended). `recomputeInvoiceStatus`'s timeZone
 * is now REQUIRED, so every writer passes the tenant's zone, and `markOverdue` runs per tenant under
 * @LeaderCron (OverdueSweepService), each on its own zone's day. Zones are passed as data (jest
 * cannot move the host zone). Bootstrap copied from invoices.service.b2256-due-date.spec.ts.
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

import { markOverdueForTenant, OverdueSweepService } from "./overdue-sweep.service";
import * as fs from "fs";
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

    const sweep = () => {
      const tenantCtx = { run: jest.fn((_id: string, fn: () => unknown) => fn()) };
      prisma.tenant.findMany.mockResolvedValue(Object.keys(zones).map((id) => ({ id })));
      prisma.tenantConfig.findUnique.mockImplementation(async (args: any) =>
        zones[args.where.tenantId] ? { timezone: zones[args.where.tenantId] } : null,
      );
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      return { svc: new OverdueSweepService(prisma as any, tenantCtx as any), tenantCtx };
    };
    const cutoffFor = (tenantId: string) =>
      prisma.invoice.updateMany.mock.calls.find((c: any[]) => c[0].where.tenantId === tenantId)![0]
        .where.dueDate.lt;

    it("sweeps every billing-live tenant with an explicit tenant filter, each in its own zone", async () => {
      const { svc, tenantCtx } = sweep();
      const res = await svc.markOverdue(now);
      expect(prisma.tenant.findMany.mock.calls[0][0].where.status.in).toEqual(["TRIAL", "ACTIVE"]);
      expect(tenantCtx.run.mock.calls.map((c: any[]) => c[0])).toEqual(["t-chi", "t-tyo", "t-utc"]);
      expect(res).toEqual({ tenants: 3, flipped: 3, failed: 0 });
      // An invoice due Oct 1: still grace in Chicago, overdue in Tokyo and in UTC.
      const due = new Date("2026-10-01T00:00:00.000Z");
      expect(due < cutoffFor("t-chi")).toBe(false);
      expect(due < cutoffFor("t-tyo")).toBe(true);
      expect(due < cutoffFor("t-utc")).toBe(true);
      for (const c of prisma.invoice.updateMany.mock.calls)
        expect(c[0].where.status.in).toEqual(["SENT", "VIEWED", "PARTIAL"]);
    });

    it("one tenant failing never stops the others", async () => {
      const { svc } = sweep();
      prisma.invoice.updateMany
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ count: 2 });
      const res = await svc.markOverdue(now);
      expect(res).toEqual({ tenants: 3, flipped: 4, failed: 1 });
    });

    it("fails closed without a tenant id (never an unscoped sweep)", async () => {
      await expect(markOverdueForTenant(prisma as any, "", now)).rejects.toThrow(/tenant id/);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });

    it("is scheduled with @LeaderCron under a stable key, and InvoicesService no longer carries it", () => {
      const src = fs.readFileSync(path.join(__dirname, "overdue-sweep.service.ts"), "utf8");
      expect(src).toMatch(
        /@LeaderCron\("5 \* \* \* \*", "invoices\.markOverdue"\)\s*\n\s*async runScheduled\(\): Promise<void> \{\s*\n\s*await this\.markOverdue\(\);/,
      );
      const inv = fs.readFileSync(path.join(__dirname, "invoices.service.ts"), "utf8");
      expect(inv).not.toMatch(/async markOverdue\(/);
      const mod = fs.readFileSync(path.join(__dirname, "invoices.module.ts"), "utf8");
      expect(mod).toMatch(/OverdueSweepService/);
    });
  });

  it("every persisted-status writer passes the tenant zone (the required parameter, counted)", () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const calls = (src: string) => src.match(/recomputeInvoiceStatus\(/g)?.length ?? 0;
    // 11 writers + the injected price-adjustment dep in invoices.service; 3 in credit notes.
    expect(calls(read("invoices/invoices.service.ts"))).toBe(12);
    expect(calls(read("credit-notes/credit-notes.service.ts"))).toBe(3);
    for (const rel of ["invoices/invoices.service.ts", "credit-notes/credit-notes.service.ts"])
      expect(read(rel)).not.toMatch(/recomputeStatus\(/);
  });
});
