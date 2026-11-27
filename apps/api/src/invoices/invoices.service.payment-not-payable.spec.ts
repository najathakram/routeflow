// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.draft-payment.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => unknown) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import * as fs from "fs";
import * as path from "path";
import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { paymentRefusal, standalonePaymentRefusal } from "./invoice-send-guard";

/**
 * SA-1299 P4 (B1396, Tier 1): money lands only on an issued invoice. ONE refusal (`paymentRefusal`) serves every
 * caller of `writeInvoicePayment` (the staff route, the counter tender, the pickup hand-over) and the standalone
 * writer; STRIPE_SETTLE keeps its one exemption. Each refusal is the coded 400 INVOICE_NOT_PAYABLE with a `reason`,
 * and nothing is written. Its own file: invoices.service.spec.ts is at its size-ratchet ceiling.
 */
describe("InvoicesService: B1396 a payment never lands on an invoice that is not payable", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: { sendInvoice: jest.fn() } },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn(), getAll: jest.fn().mockResolvedValue({}), set: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: { autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }) },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = module.get(InvoicesService);
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 3 } as any);
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => ({
      id: "pay-1",
      ...data,
    }));
    // The staff writer reads inside tenantTransaction with a raw lock first.
    prisma.tenantTransaction.mockImplementation(async (fn: any) =>
      fn({ ...(prisma.forTenant() as any), $executeRaw: jest.fn().mockResolvedValue(0) }),
    );
  });

  const NOT_PAYABLE = ["DRAFT", "VOID", "WRITTEN_OFF"] as const;
  const refusedWith = (reason: string) =>
    expect.objectContaining({
      response: expect.objectContaining({ code: "INVOICE_NOT_PAYABLE", reason }),
    });
  const nothingWritten = () => {
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.advancePayment.create).not.toHaveBeenCalled();
  };

  it("the code is in the shared list under its own name", () => {
    expect(API_ERROR_CODES.INVOICE_NOT_PAYABLE).toBe("INVOICE_NOT_PAYABLE");
  });

  describe("paymentRefusal is the one decision", () => {
    it.each(NOT_PAYABLE)("%s is refused with its own reason", (s) => {
      expect(paymentRefusal(s as InvoiceStatus)).toBe(s);
    });
    it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE", "PAID"])("%s is payable", (s) => {
      expect(paymentRefusal(s as InvoiceStatus)).toBeNull();
    });
    it("standalonePaymentRefusal adds only the STRIPE_SETTLE exemption for a DRAFT", () => {
      expect(standalonePaymentRefusal(InvoiceStatus.DRAFT, "STAFF_ALLOCATION")).toBe("DRAFT");
      expect(standalonePaymentRefusal(InvoiceStatus.DRAFT, "STRIPE_SETTLE")).toBeNull();
      expect(standalonePaymentRefusal(InvoiceStatus.VOID, "STRIPE_SETTLE")).toBe("VOID");
      expect(standalonePaymentRefusal(InvoiceStatus.WRITTEN_OFF, "STRIPE_SETTLE")).toBe(
        "WRITTEN_OFF",
      );
    });
  });

  describe("(a, b) the staff route, counter tender and pickup writer: recordPayment", () => {
    it.each(NOT_PAYABLE)("a %s invoice: coded 400 with the reason, zero writes", async (status) => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        status,
        total: 100,
        orderId: null,
        payments: [],
      } as any);
      const err: any = await service
        .recordPayment("inv-1", { amount: 20, method: "CASH" } as any)
        .catch((e: unknown) => e);
      expect(err).toEqual(refusedWith(status));
      expect(err.getStatus()).toBe(400);
      nothingWritten();
    });
  });

  describe("(a, b) the standalone writer", () => {
    const alloc = {
      customerId: "cust-1",
      method: "CASH",
      totalAmount: 100,
      status: "PAID",
      allocations: [{ invoiceId: "inv-1", amount: 100 }],
    } as any;
    const invoiceIs = (status: string) =>
      prisma.invoice.findFirst.mockResolvedValue({
        id: "inv-1",
        status,
        total: 100,
        dueDate: null,
        payments: [],
      } as any);

    it.each(NOT_PAYABLE)("a %s invoice: coded 400 with the reason, zero writes", async (status) => {
      invoiceIs(status);
      const err: any = await service
        .recordStandalonePayment(alloc, { source: "STAFF_ALLOCATION" })
        .catch((e: unknown) => e);
      expect(err).toEqual(refusedWith(status));
      expect(err.getStatus()).toBe(400);
      nothingWritten();
    });

    it("control: STRIPE_SETTLE onto a DRAFT invoice still records PAID (the processor already took the money)", async () => {
      invoiceIs("DRAFT");
      await service.recordStandalonePayment(alloc, { source: "STRIPE_SETTLE" } as any);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });

    it("control: a SENT invoice takes the payment", async () => {
      invoiceIs("SENT");
      await service.recordStandalonePayment(alloc, { source: "STAFF_ALLOCATION" });
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Inventory pins (class, not instance): the refusal has ONE copy, both writers throw through the one builder, and
 * only the known callers reach `writeInvoicePayment`, so a new payment path cannot skip the helper silently.
 */
describe("B1396 inventory: every invoice payment writer goes through the one refusal", () => {
  const apiSrc = path.join(__dirname, "..");
  const src = (rel: string) => fs.readFileSync(path.join(apiSrc, rel), "utf8");
  const service = src("invoices/invoices.service.ts");
  const guard = src("invoices/invoice-send-guard.ts");

  it("writeInvoicePayment refuses through assertPayable, before the review gate and any write", () => {
    const body = service.slice(service.indexOf("private async writeInvoicePayment("));
    const at = body.indexOf("assertPayable(inv.status)");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(body.indexOf("assertOrderReviewed"));
    expect(at).toBeLessThan(body.indexOf("invoicePayment.create"));
  });

  it("the standalone writer refuses through assertStandalonePayable, before any write", () => {
    const at = service.indexOf("assertStandalonePayable(invoice.status");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(service.indexOf("assertUnconfirmedAllocationFits(", at));
  });

  it("the service has no refusal of its own: no status compare, no hand-built message", () => {
    expect(service).not.toMatch(/paymentRefusal\(|standalonePaymentRefusal\(/);
    expect(service).not.toMatch(/Cannot record payment on/);
    expect(service).not.toMatch(/is \$\{refused\}/);
  });

  it("both asserts and the standalone refusal delegate to paymentRefusal: one copy of the rule", () => {
    const fn = guard.slice(guard.indexOf("export function standalonePaymentRefusal"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/return paymentRefusal\(status\)/);
    const assertFn = guard.slice(guard.indexOf("export function assertPayable"));
    expect(assertFn.slice(0, assertFn.indexOf("\n}"))).toMatch(/paymentRefusal\(status\)/);
    // the rule itself (which statuses refuse) is written once, in paymentRefusal
    expect(guard.match(/InvoiceStatus\.WRITTEN_OFF\) return/g)).toHaveLength(1);
  });

  it("only the staff route, the counter tender and the pickup hand-over call recordPayment", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "testing") walk(p);
        } else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) {
          if (/\b(invoices|invoicesService)\.recordPayment\(/.test(fs.readFileSync(p, "utf8")))
            callers.push(path.relative(apiSrc, p).replace(/\\/g, "/"));
        }
      }
    };
    walk(apiSrc);
    expect(callers.sort()).toEqual([
      "invoices/invoices.controller.ts",
      "orders/counter-sale/counter-sale.service.ts",
      "orders/counter-sale/pickup-complete.service.ts",
    ]);
  });

  it("green guards: the counter sale and the pickup hand-over issue every invoice BEFORE they record payment", () => {
    const counter = src("orders/counter-sale/counter-sale.service.ts");
    expect(counter.indexOf("this.orders.createSale(")).toBeGreaterThan(-1);
    expect(counter.indexOf("this.orders.createSale(")).toBeLessThan(
      counter.indexOf("this.invoices.recordPayment("),
    );
    expect(counter).toMatch(/deliveredNow: true/);
    const pickup = src("orders/counter-sale/pickup-complete.service.ts");
    expect(pickup.indexOf("this.invoices.send(inv.id")).toBeGreaterThan(-1);
    expect(pickup.indexOf("this.invoices.send(inv.id")).toBeLessThan(
      pickup.indexOf("this.invoices.recordPayment("),
    );
  });
});
