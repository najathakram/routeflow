/**
 * SA-674b: while its order is with the carrier, the SHIPMENT invoice refuses line and quantity changes
 * (a cut only synced invoicedQty, so DELIVERED re-billed it as a second invoice; and it moved no stock).
 * Price, discount and notes stay editable. A dedicated file: invoices.service.spec.ts is at its ceiling.
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));
// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

import { carrierLineChange, invoiceOrderWithCarrier } from "./invoice-carrier-lock";

const ROW = {
  id: "item-1",
  productId: null,
  description: "Widget",
  qty: 4,
  boxes: null,
  pieces: null,
  unitPrice: 5,
  discount: 0,
  subtotal: 20,
  taxRate: 0,
};

describe("carrierLineChange (pure)", () => {
  const m = (row: any, productChanged = false) => ({ row, untouched: false, productChanged });
  it("a qty cut, a removal, an added line and a product swap are line changes", () => {
    expect(carrierLineChange([{ ...ROW, qty: 2 } as any], [m(ROW)], [ROW])).toBe(
      "changes a quantity",
    );
    expect(carrierLineChange([], [], [ROW])).toBe("removes a line");
    expect(carrierLineChange([ROW as any, { qty: 1 } as any], [m(ROW), m(null)], [ROW])).toBe(
      "adds a line",
    );
    expect(carrierLineChange([ROW as any], [m(ROW, true)], [ROW])).toBe("changes a line's product");
  });
  it("#3219 N2: a boxed line's null pieces resent as 0 is not a quantity change", () => {
    const boxed = { ...ROW, boxes: 2, pieces: null };
    expect(
      carrierLineChange([{ ...boxed, pieces: 0, unitPrice: 4 } as any], [m(boxed)], [boxed]),
    ).toBeNull();
  });

  it("a price or discount change on the same lines is not", () => {
    expect(
      carrierLineChange([{ ...ROW, unitPrice: 4, discount: 1 } as any], [m(ROW)], [ROW]),
    ).toBeNull();
  });
});

describe("InvoicesService.update() — SA-674b shipment invoice of an order with the carrier", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
    reserveNextTx: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // units_v1 guard reads the parent invoice

    const module: TestingModule = await Test.createTestingModule({
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
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            syncInvoiceEntries: jest.fn(),
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
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const draft = {
    id: "inv-ship",
    orderId: "ord-1",
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-0100",
    status: InvoiceStatus.DRAFT,
    subtotal: 20,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 20,
    notes: null,
    terms: null,
    dueDate: null,
    issueDate: new Date(),
  };
  const arrange = (mode: string, orderStatus = "OUT_FOR_DELIVERY") => {
    (service as any).featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue(mode) };
    prisma.invoice.findUnique.mockResolvedValue(draft);
    prisma.invoice.findFirst.mockResolvedValue({ ...draft, items: [] });
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      tenantId: "t-1",
      orderNumber: "ORD-1",
      status: orderStatus,
      fulfillPath: "SHIP",
      shippedAt: new Date("2026-10-01T00:00:00Z"),
    });
    prisma.invoiceItem.findMany.mockResolvedValue([ROW]);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draft);
  };
  const noWrites = () => {
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
  };
  const conflict = {
    status: 409,
    response: expect.objectContaining({ code: "INVOICE_WITH_CARRIER_NO_LINE_CHANGE" }),
  };

  it("ship -> cut the invoice qty -> 409, nothing written (so DELIVERED has no cut to re-bill)", async () => {
    arrange("ship");
    await expect(
      service.update("inv-ship", { items: [{ ...ROW, qty: 2 }] } as any),
    ).rejects.toMatchObject(conflict);
    noWrites();
  });

  it("ship -> remove the line or add one -> 409", async () => {
    arrange("ship");
    await expect(service.update("inv-ship", { items: [] } as any)).rejects.toMatchObject(conflict);
    await expect(
      service.update("inv-ship", {
        items: [ROW, { description: "Extra", qty: 1, unitPrice: 3 }],
      } as any),
    ).rejects.toMatchObject(conflict);
    noWrites();
  });

  it("ship -> change the price -> saved", async () => {
    arrange("ship");
    await service.update("inv-ship", { items: [{ ...ROW, unitPrice: 4 }] } as any);
    expect(prisma.invoice.update).toHaveBeenCalled();
  });

  it("SA-689 a: the carrier state is read UNDER the invoice row lock — an order reopened to the carrier between the pre-read and the lock is refused", async () => {
    arrange("ship", "DELIVERED"); // delivered: its invoice is editable and not with the carrier
    let status = "DELIVERED";
    prisma.order.findFirst.mockImplementation(async () => ({
      id: "ord-1",
      tenantId: "t-1",
      orderNumber: "ORD-1",
      status,
      fulfillPath: "SHIP",
      shippedAt: new Date("2026-10-01T00:00:00Z"),
    }));
    // a reopen to PARTIALLY_DELIVERED commits while this edit waits for the Order / Invoice row locks
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        ...prisma.forTenant(),
        $executeRaw: jest.fn(async () => {
          status = "PARTIALLY_DELIVERED";
          return 0;
        }),
        $queryRaw: jest.fn().mockResolvedValue([]),
      }),
    );
    await expect(
      service.update("inv-ship", { items: [{ ...ROW, qty: 2 }] } as any),
    ).rejects.toMatchObject(conflict);
    noWrites();
  });

  it("control: an UNSET-mode business keeps today's edit (a delivered order's invoice)", async () => {
    arrange("unset", "DELIVERED");
    await service.update("inv-ship", { items: [{ ...ROW, qty: 2 }] } as any);
    expect(prisma.invoice.update).toHaveBeenCalled();
  });
});

describe("invoiceOrderWithCarrier — the mode gate (#3219 N1)", () => {
  const deps = (mode: string, status: string) => ({
    featureConfig: { getEffectiveMode: jest.fn().mockResolvedValue(mode) },
    prisma: {
      forTenant: () => ({
        order: {
          findFirst: jest.fn().mockResolvedValue({
            id: "ord-1",
            tenantId: "t-1",
            status,
            fulfillPath: "SHIP",
            shippedAt: new Date("2026-10-01T00:00:00Z"),
          }),
        },
        orderRevision: { findFirst: jest.fn().mockResolvedValue(null) },
      }),
    } as any,
  });
  it("an OUT_FOR_DELIVERY order is with the carrier only for a business billing at shipment", async () => {
    expect(await invoiceOrderWithCarrier(deps("ship", "OUT_FOR_DELIVERY"), "ord-1")).toBe(true);
    expect(await invoiceOrderWithCarrier(deps("unset", "OUT_FOR_DELIVERY"), "ord-1")).toBe(false);
    expect(await invoiceOrderWithCarrier(deps("ship", "OUT_FOR_DELIVERY"), null)).toBe(false);
  });
});
