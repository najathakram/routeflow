/**
 * #2656 / SA-549 — a recurring template is a server path that accepts a per-line taxRate, so its
 * create and update refuse an NSF-described line with a rate > 0 (400 NSF_LINE_UNTAXED) before any
 * read or write; the same line at 0 goes through.
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
import { NSF_FEE_DESCRIPTION_PREFIX } from "@routeflow/pricing";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { assertNsfLinesUntaxed } from "../invoices/nsf-line-tax-guard";

describe("RecurringInvoicesService — #2656 an NSF-described template line is never taxed", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // The mocked create enforces the REAL guard (as InvoicesService.create does), so a template line
    // that reaches it with a taxed NSF rate throws the 400 — exactly what real PG shows (F2 case (e)).
    invoices = {
      create: jest.fn(async (dto: any) => {
        assertNsfLinesUntaxed(dto.items ?? []);
        return { id: "inv-1" };
      }),
    };
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
            // The unattended run screens the template first (blockedTemplateLines → checkLinesSellable).
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        { provide: NotificationsService, useValue: { sendToUser: jest.fn() } },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
  });

  const nsfLine = (taxRate: number) => ({
    description: `${NSF_FEE_DESCRIPTION_PREFIX} #3`,
    qty: 1,
    unitPrice: 25,
    taxRate,
  });
  const codeOf = (e: any) => (e?.getResponse?.() as any)?.code;

  it("create(): rate > 0 ⇒ 400 NSF_LINE_UNTAXED before the customer is even read", async () => {
    const caught: any = await service
      .create({ customerId: "c-1", frequency: "MONTHLY", items: [nsfLine(0.08)] } as any)
      .catch((e) => e);
    expect(codeOf(caught)).toBe("NSF_LINE_UNTAXED");
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(prisma.recurringInvoice.create).not.toHaveBeenCalled();
  });

  it("update(): rate > 0 ⇒ 400 before any read", async () => {
    const caught: any = await service
      .update("ri-1", { items: [nsfLine(0.05)] } as any)
      .catch((e) => e);
    expect(codeOf(caught)).toBe("NSF_LINE_UNTAXED");
    expect(prisma.recurringInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.recurringInvoice.update).not.toHaveBeenCalled();
  });

  it("create(): the same line at 0 passes the guard (reaches the customer read)", async () => {
    prisma.customer.findUnique.mockResolvedValue(null); // then the normal 404 — past the guard
    const caught: any = await service
      .create({ customerId: "c-1", frequency: "MONTHLY", items: [nsfLine(0)] } as any)
      .catch((e) => e);
    expect(codeOf(caught)).toBeUndefined();
    expect(prisma.customer.findUnique).toHaveBeenCalled();
  });

  // Lead's Opus (#2673) per B142 "billing must never pause": the UNATTENDED nightly run never refuses a
  // legacy template whose NSF line still carries a rate — it bills that line at 0 and logs it.
  // What it guards (SA-549e): WITHOUT the fold the taxed NSF line reaches create, the guard throws
  // 400 NSF_LINE_UNTAXED, the run records FAILED and issues NO invoice — billing pauses (B142).
  it("the nightly run on a legacy taxed-NSF template generates the invoice, NSF line at 0, logged; no 400", async () => {
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" });
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.update.mockResolvedValue({ id: "inv-1" });
    prisma.product.findMany.mockResolvedValue([]);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    const template = {
      id: "ri-1",
      customerId: "cust-1",
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
          description: "Cola 12pk",
          productId: null,
          qty: 1,
          unitPrice: 100,
          discount: 0,
          taxRate: 0.075,
          unitLabel: null,
        },
        { ...nsfLine(0.08), productId: null, discount: 0, unitLabel: null },
      ],
    };

    const outcome: any = await (service as any)
      .generateInvoiceFromTemplate(template)
      .catch((e: unknown) => ({ failed: e }));
    // B142: the nightly run never pauses — no NSF_LINE_UNTAXED failure, and the invoice IS issued.
    expect(codeOf(outcome?.failed)).toBeUndefined();
    expect(outcome?.failed).toBeUndefined();
    expect(invoices.create).toHaveBeenCalledTimes(1);
    const items = invoices.create.mock.calls[0][0].items;
    expect(items[0].taxRate).toBe(0.075); // goods keep their rate
    expect(items[1].taxRate).toBe(0); // the NSF line is billed untaxed, never refused
    // Exactly ONE warn, for the one NSF line (SA-549e).
    expect(
      warn.mock.calls.filter((c: any[]) => /NSF fee line .*billed at 0/.test(String(c[0]))),
    ).toHaveLength(1);
  });

  // SA-549e: "Run now" (unattended = false) is an operator deciding — it KEEPS the 400, before the cycle
  // is claimed, so nothing is issued or written.
  const armRun = () => {
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" });
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.update.mockResolvedValue({ id: "inv-1" });
    prisma.product.findMany.mockResolvedValue([]);
  };
  const tmpl = (items: any[]) => ({
    id: "ri-1",
    customerId: "cust-1",
    frequency: "MONTHLY",
    dayOfMonth: 1,
    discount: 0,
    shippingFee: 0,
    notes: null,
    terms: null,
    autoSend: false,
    nextRunAt: new Date("2026-07-01"),
    items,
  });
  const goodsLine = {
    description: "Cola 12pk",
    productId: null,
    qty: 1,
    unitPrice: 100,
    discount: 0,
    taxRate: 0.075,
    unitLabel: null,
  };

  it("Run now on a legacy taxed-NSF template ⇒ 400 NSF_LINE_UNTAXED; nothing claimed or issued", async () => {
    armRun();
    const caught: any = await (service as any)
      .generateInvoiceFromTemplate(
        tmpl([goodsLine, { ...nsfLine(0.08), productId: null, discount: 0, unitLabel: null }]),
        false,
      )
      .catch((e: unknown) => e);
    expect(codeOf(caught)).toBe("NSF_LINE_UNTAXED");
    expect(prisma.recurringInvoice.updateMany).not.toHaveBeenCalled(); // the cycle is not claimed
    expect(invoices.create).not.toHaveBeenCalled();
  });

  it.each([
    ["nightly", true],
    ["Run now", false],
  ])(
    "a template with no NSF line is unchanged on the %s run: goods keep their rate, no warn",
    async (_n, unattended) => {
      armRun();
      const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
      await (service as any).generateInvoiceFromTemplate(tmpl([goodsLine]), unattended);
      expect(invoices.create).toHaveBeenCalledTimes(1);
      expect(invoices.create.mock.calls[0][0].items[0].taxRate).toBe(0.075);
      expect(warn.mock.calls.filter((c: any[]) => /NSF fee line/.test(String(c[0])))).toHaveLength(
        0,
      );
    },
  );
});
