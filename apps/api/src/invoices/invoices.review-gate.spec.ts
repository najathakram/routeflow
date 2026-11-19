/**
 * SA-1124 PR-1b: the review gate on invoices, rows G1-G4 at the module boundary (mocked prisma; the same rows against
 * a real database are in order-review-gate.db.spec.ts). Each row pins what master does for the same call (the flag
 * never consulted) beside what the gate changes. A spec of its own: invoices.service.spec.ts is size-ratchet capped.
 *
 * Open flag = `orderReviewFlag.findMany` answering a PRICE_CHANGED_OFFLINE row; resolved = it answers [].
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
// A payment with a reference runs under the payment-ref advisory lock (a pooled connection); pass-through here.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => unknown) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AfterCommit } from "../common/after-commit";
import { createMockPrisma } from "../testing/prisma-mock";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

describe("InvoicesService: the review gate on an order with an open price flag (SA-1124 PR-1b)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let sendInvoice: jest.Mock;
  let sendCredits: { autoApplyOldestCreditsInTx: jest.Mock };
  let systemGet: jest.Mock;

  const FLAG = [{ kind: "PRICE_CHANGED_OFFLINE" }];
  const open = () => prisma.orderReviewFlag.findMany.mockResolvedValue(FLAG as any);
  const resolved = () => prisma.orderReviewFlag.findMany.mockResolvedValue([] as any);
  const refused = (err: any) => {
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: "ORDER_REVIEW_REQUIRED",
      orderId: "ord-1",
      openKinds: ["PRICE_CHANGED_OFFLINE"],
    });
  };

  beforeEach(async () => {
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();
    sendInvoice = jest.fn().mockResolvedValue({ delivered: true, transport: "resend" });
    sendCredits = {
      autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    };
    systemGet = jest.fn().mockResolvedValue(null);
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendInvoice, isEmailConfigured: jest.fn().mockResolvedValue(true) },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: systemGet, getAll: async () => ({}), set: jest.fn() },
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
          useValue: {
            ...sendCredits,
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
          },
        },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn(), notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: () => ({ can: () => Promise.resolve(false) }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(InvoicesService);
    // #2070: createInvoiceFromOrder's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 2 } as any);
    prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => ({
      id: "pay-1",
      ...data,
    }));
  });

  // ── G1: send ────────────────────────────────────────────────────────────────────────────────
  describe("G1: send() and sendEmail()", () => {
    // A DELIVERED order's DRAFT invoice (route completion made it): unlocked, so the review gate is the only refusal.
    const seedDraft = (orderId: string | null) => {
      const row = {
        id: "i1",
        orderId,
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
        invoiceNumber: "INV-1",
        customerId: "c1",
        total: 10,
        dueDate: null,
        customer: { businessName: "Acme", email: "buyer@example.test" },
      };
      prisma.invoice.findUnique.mockResolvedValue(row as any);
      prisma.order.findFirst.mockResolvedValue({
        status: "DELIVERED",
        orderNumber: "ORD-1",
        fulfillPath: "DELIVER",
      } as any);
      prisma.invoice.update.mockResolvedValue({
        ...row,
        status: InvoiceStatus.SENT,
      } as any);
    };

    it("send: 409 ORDER_REVIEW_REQUIRED while flagged, nothing written", async () => {
      seedDraft("ord-1");
      open();
      refused(await service.send("i1").catch((e) => e));
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("send: 200 once the flag is resolved (master's value for the same call, unchanged)", async () => {
      seedDraft("ord-1");
      resolved();
      await expect(service.send("i1")).resolves.toMatchObject({ id: "i1" });
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: InvoiceStatus.SENT }) }),
      );
    });

    it("send: an invoice with no order never asks the gate (a manual invoice is untouched)", async () => {
      seedDraft(null);
      open();
      await expect(service.send("i1")).resolves.toBeDefined();
      expect(prisma.orderReviewFlag.findMany).not.toHaveBeenCalled();
    });

    it("sendEmail does not route through send(): it carries the same guard, before any email work", async () => {
      seedDraft("ord-1");
      open();
      const e1 = await service.sendEmail("i1").catch((e) => e);
      refused(e1);
      expect(sendInvoice).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("sendReminder still refuses an un-issued invoice (400) first", async () => {
      seedDraft("ord-1");
      open();
      const err = await service.sendReminder("i1").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
    });

    // S3: exempt driver cash can issue a flagged order's invoice, so a reminder must not go out for the unreviewed price
    const seedIssued = (orderId: string | null) => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "i1",
        orderId,
        status: InvoiceStatus.SENT,
        invoiceNumber: "INV-1",
        customerId: "c1",
        total: 100,
        dueDate: null,
        customer: { id: "c1", businessName: "Acme", contactName: "A", email: "buyer@example.test" },
        items: [],
        payments: [],
      } as any);
    };

    it("sendReminder: 409 ORDER_REVIEW_REQUIRED on a flagged order's issued invoice, nothing emailed", async () => {
      seedIssued("ord-1");
      open();
      const err = await service.sendReminder("i1").catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "ORDER_REVIEW_REQUIRED",
        orderId: "ord-1",
        openKinds: ["PRICE_CHANGED_OFFLINE"],
      });
    });

    it("sendReminder: the same issued invoice passes the gate once the flag is resolved, and an order-less one never asks", async () => {
      seedIssued("ord-1");
      resolved();
      const after = await service.sendReminder("i1").catch((e) => e);
      expect(after).not.toBeInstanceOf(ConflictException);
      expect(prisma.orderReviewFlag.findMany).toHaveBeenCalledTimes(1);
      prisma.orderReviewFlag.findMany.mockClear();
      seedIssued(null);
      open();
      const none = await service.sendReminder("i1").catch((e) => e);
      expect(none).not.toBeInstanceOf(ConflictException);
      expect(prisma.orderReviewFlag.findMany).not.toHaveBeenCalled();
    });
  });

  // ── G2: payments ───────────────────────────────────────────────────────────────────────────
  describe("G2: payments", () => {
    const seedSent = () => {
      const row = {
        id: "inv-1",
        orderId: "ord-1",
        customerId: "cust-1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [],
      };
      prisma.invoice.findUnique.mockResolvedValue(row as any);
      prisma.invoice.findFirst.mockResolvedValue(row as any);
      prisma.invoice.update.mockResolvedValue({ ...row, customer: {}, payments: [] } as any);
      prisma.invoicePayment.findMany.mockResolvedValue([] as any);
    };
    const dto = () =>
      ({
        customerId: "cust-1",
        totalAmount: 40,
        method: "CASH",
        allocations: [{ invoiceId: "inv-1", amount: 40 }],
      }) as any;

    it("recordPayment: 409 while flagged, no payment row", async () => {
      seedSent();
      open();
      refused(
        await service.recordPayment("inv-1", { amount: 10, method: "CASH" } as any).catch((e) => e),
      );
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("recordPayment: records once the flag is resolved", async () => {
      seedSent();
      resolved();
      await service.recordPayment("inv-1", { amount: 10, method: "CASH" } as any);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });

    it("recordStandalonePayment (STAFF_ALLOCATION): 409 while flagged, no payment row", async () => {
      seedSent();
      open();
      refused(
        await service
          .recordStandalonePayment(dto(), { source: "STAFF_ALLOCATION" })
          .catch((e) => e),
      );
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it.each([
      ["a missing source", {}],
      ["an unknown source", { source: "SOMETHING_ELSE" }],
      ["a lower-case look-alike", { source: "stripe_settle" }],
    ])("recordStandalonePayment with %s is gated, never exempt (fail closed)", async (_n, opts) => {
      seedSent();
      open();
      refused(await service.recordStandalonePayment(dto(), opts as any).catch((e) => e));
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("recordStandalonePayment (STAFF_ALLOCATION): an unflagged order records (master's value)", async () => {
      seedSent();
      resolved();
      await service.recordStandalonePayment(dto(), { source: "STAFF_ALLOCATION" });
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });

    it("recordStandalonePayment (STRIPE_SETTLE): records while flagged and never asks the gate; the flag stays open", async () => {
      seedSent();
      open();
      await service.recordStandalonePayment(dto(), { source: "STRIPE_SETTLE" });
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.orderReviewFlag.findMany).not.toHaveBeenCalled();
      expect(prisma.orderReviewFlag.updateMany).not.toHaveBeenCalled();
      expect(prisma.orderReviewFlag.update).not.toHaveBeenCalled();
    });

    it("recordDeliveryPaymentInTx (driver cash): records while flagged and never asks the gate; the flag stays open", async () => {
      open();
      jest.spyOn(service, "findOpenOrderDraft").mockResolvedValue(null as any);
      jest.spyOn(service, "reconcileOrderDeliveredInvoices").mockResolvedValue(undefined as any);
      jest.spyOn(service, "createInvoiceFromOrder").mockResolvedValue([] as any);
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" } as any);
      const inv = {
        id: "inv-1",
        orderId: "ord-1",
        total: 100,
        status: "SENT",
        dueDate: null,
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        payments: [],
      };
      prisma.invoice.findMany.mockResolvedValue([inv] as any);
      prisma.invoice.findUnique.mockResolvedValue(inv as any);
      prisma.invoice.update.mockResolvedValue({} as any);
      prisma.paymentCounter.upsert.mockResolvedValue({ next: 1 } as any);
      const out = await service.recordDeliveryPaymentInTx(
        prisma as any,
        new AfterCommit(),
        ["ord-1"],
        100,
        "CASH",
        null,
        null,
      );
      expect(out.applied).toBe(100);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.orderReviewFlag.findMany).not.toHaveBeenCalled();
      expect(prisma.orderReviewFlag.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── G3 / G4: creating the invoice and the deposit mirror ─────────────────────────────────
  describe("G3 / G4: a DRAFT invoice is never blocked, and the deposit mirror stays a DRAFT", () => {
    const order = {
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      subtotal: 100,
      tax: 0,
      status: "PENDING",
      lineItems: [
        {
          id: "li-1",
          productId: "p1",
          name: null,
          qty: 2,
          invoicedQty: 0,
          unitPrice: 50,
          originalPrice: null,
          priceType: "STANDARD",
          product: { name: "Widget", unitsPerBox: 0 },
        },
      ],
    };

    beforeEach(() => {
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-DEP");
      prisma.customer.findFirst.mockResolvedValue({
        isTaxExempt: false,
        defaultPaymentTerms: null,
        defaultDepositPercent: null,
      });
      systemGet.mockImplementation((key: string) => {
        if (key === "invoice.depositDefaultPercent") return Promise.resolve("30");
        if (key === "invoice.depositCollectAtOrder") return Promise.resolve("true");
        return Promise.resolve(null);
      });
      prisma.order.findUnique.mockResolvedValue(order as any);
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-dep-1", ...args.data, items: [], payments: [], customer: {} }),
      );
    });

    it("G3/G4 master value: no open flag, deposit-at-order on: the mirror is issued through send()", async () => {
      resolved();
      const send = jest.spyOn(service, "send").mockResolvedValue({ id: "inv-dep-1" } as any);
      await service.createInvoiceFromOrder("ord-1");
      expect(send).toHaveBeenCalledWith("inv-dep-1", { allowPreDelivery: true });
    });

    it("G4: an open price flag with deposit-at-order on: createInvoiceFromOrder returns the DRAFT, never calls send, never throws", async () => {
      open();
      const send = jest.spyOn(service, "send").mockResolvedValue({ id: "inv-dep-1" } as any);
      const out = await service.createInvoiceFromOrder("ord-1");
      expect(send).not.toHaveBeenCalled();
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(1);
      expect((out as any[])[0].status).toBe(InvoiceStatus.DRAFT);
    });

    it("G3: createInvoiceFromOrder on a flagged order creates its DRAFT (the gate never blocks DRAFT creation)", async () => {
      open();
      systemGet.mockResolvedValue(null); // no deposit: the plain route-completion shape
      const out = await service.createInvoiceFromOrder("ord-1");
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
      expect((out as any[])[0].status).toBe(InvoiceStatus.DRAFT);
    });

    // The tenant-keyed reads of the fire-and-forget path: deposit 30 percent, collected at order placement.
    const withTenantConfig = () =>
      prisma.systemConfig.findFirst.mockImplementation(async ({ where }: any) =>
        where.key === "invoice.depositDefaultPercent"
          ? { value: "30" }
          : where.key === "invoice.depositCollectAtOrder"
            ? { value: "true" }
            : null,
      );

    it("G4 (shipment path): the inline deposit flip in createInvoiceFromOrderWithTenant leaves a flagged order's mirror DRAFT", async () => {
      open();
      prisma.order.findFirst.mockResolvedValue(order as any);
      withTenantConfig();
      const out = await service.createInvoiceFromOrderWithTenant("ord-1", "test-tenant");
      expect(prisma.invoice.update).not.toHaveBeenCalled(); // the SENT flip is the only update on this path
      expect((out as any[])[0].status).toBe(InvoiceStatus.DRAFT);
      // the context-less shipment path reads the flag with the tenant named, never ambient
      expect(prisma.orderReviewFlag.findMany.mock.calls[0][0].where).toMatchObject({
        orderId: "ord-1",
        tenantId: "test-tenant",
      });
    });

    it("G4 (shipment path) master value: no open flag, the same call flips the deposit mirror to SENT", async () => {
      resolved();
      prisma.order.findFirst.mockResolvedValue(order as any);
      withTenantConfig();
      prisma.invoice.update.mockResolvedValue({
        id: "inv-dep-1",
        status: InvoiceStatus.SENT,
      } as any);
      await service.createInvoiceFromOrderWithTenant("ord-1", "test-tenant");
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: InvoiceStatus.SENT }) }),
      );
    });
  });
});
