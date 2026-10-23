/**
 * SA-856 rule 5 (W-693), a GUARD (green on master, labelled as such): a recurring template line carries an AGREED price,
 * billed verbatim each cycle (invoice-line-override.ts:35-37: recurring invoices never reach the override path). The
 * customer's current tier or special prices never re-price it at generation; only the pack is read live (B646). The fix
 * for W-693 lives in the web form (the price is set at set-up from the customer's own price); this pins that the generator
 * stays unchanged.
 */
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

// A tier-3 customer; the product's tier-3 price (8.00) differs from what the template agreed (10.00).
const LIVE_PRODUCTS = [
  {
    id: "p-cola",
    unitsPerBox: null,
    isActive: true,
    pricePerUnit: "10.00",
    priceTier3: "8.00",
  },
];
const template = {
  id: "ri-1",
  customerId: "cust-tier3",
  customer: { id: "cust-tier3", pricingTier: 3 },
  frequency: "MONTHLY",
  dayOfMonth: 1,
  discount: 0,
  shippingFee: 0,
  notes: null,
  terms: null,
  autoSend: false,
  nextRunAt: new Date("2026-07-01"),
  items: [
    {
      description: "Cola",
      productId: "p-cola",
      qty: 2,
      unitPrice: "10.00",
      discount: 0,
      taxRate: 0,
      unitLabel: null,
    },
    {
      description: "Delivery fee",
      productId: null,
      qty: 1,
      unitPrice: "5.00",
      discount: 0,
      taxRate: 0,
      unitLabel: null,
    },
  ],
};

describe("recurring generation bills the template's agreed price verbatim (SA-856 guard)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoices = { create: jest.fn().mockResolvedValue({ id: "inv-1" }) };
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: invoices },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        { provide: NotificationsService, useValue: { sendToUser: jest.fn().mockResolvedValue(1) } },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
    prisma.invoice.update.mockResolvedValue({ id: "inv-1" });
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" });
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.product.findMany.mockResolvedValue(LIVE_PRODUCTS);
  });

  it("a tier-3 customer's line agreed at 10.00 is billed 10.00, never re-priced to the tier-3 8.00", async () => {
    await (service as any).generateInvoiceFromTemplate(template);
    const items = invoices.create.mock.calls[0][0].items as any[];
    expect(items[0]).toMatchObject({ productId: "p-cola", qty: 2, unitPrice: 10 });
    expect(items[1]).toMatchObject({ productId: null, qty: 1, unitPrice: 5 });
  });

  it("the only live product read at generation is the pack (no price columns are selected)", async () => {
    await (service as any).generateInvoiceFromTemplate(template);
    const reads = prisma.product.findMany.mock.calls.map((c: any[]) => c[0]?.select ?? {});
    for (const select of reads) {
      expect(Object.keys(select).filter((k) => /price|tier/i.test(k))).toEqual([]);
    }
    expect(prisma.customerPrice?.findMany ?? jest.fn()).not.toHaveBeenCalled();
  });
});
