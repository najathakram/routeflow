/**
 * B325 (SA-964, BT-5): the cron-generated recurring invoice used to be dated the previous calendar day for US tenants.
 * On master it is fixed: this path passes NO issueDate (a clock instant would be a calendar stamp), so
 * `InvoicesService.create` dates it with `startOfCalendarDay(now, tenant zone)` (invoices.service.ts, "#2197"), the same
 * helper the NY issueDate cases in invoices.service.spec.ts / invoice-issue-date-b2197.db.spec.ts pin. This spec pins the
 * recurring half: near midnight UTC for a New York tenant the generator still hands create() no issueDate and no instant
 * the tenant could read as another day. Harness copied from recurring-invoices.agreed-price.spec.ts.
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

describe("B325 pin: a recurring invoice is dated by InvoicesService.create on the tenant's day", () => {
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

  afterEach(() => jest.useRealTimers());

  it("at 02:00Z on the 28th (22:00 EDT on the 27th) the generated invoice carries no issueDate of its own", async () => {
    jest.useFakeTimers({
      now: new Date("2026-10-28T02:00:00Z"),
      doNotFake: ["setTimeout", "setInterval", "setImmediate", "nextTick", "queueMicrotask"],
    });
    await (service as any).generateInvoiceFromTemplate(template);
    const dto = invoices.create.mock.calls[0][0];
    expect(dto).not.toHaveProperty("issueDate");
  });

  it("and the day create() would fall back to for that tenant is the 27th, not the UTC 28th", () => {
    const { startOfCalendarDay } = jest.requireActual("../common/calendar-date");
    expect(
      startOfCalendarDay(new Date("2026-10-28T02:00:00Z"), "America/New_York").toISOString(),
    ).toBe("2026-10-27T00:00:00.000Z");
  });
});
