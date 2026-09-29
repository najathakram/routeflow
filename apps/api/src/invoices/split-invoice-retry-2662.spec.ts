import { ServiceUnavailableException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * #2662 — createSplitInvoices (reached through the office path, createInvoiceFromOrder) refuses cleanly
 * when its creation does not complete: under lock contention the transaction can outlive Prisma's
 * interactive-tx timeout (P2028) — Prisma rolls it back, so the caller gets a retryable 503 saying
 * nothing was saved — and a create that yields no invoice stops before anything reads it. Neither is
 * ever a raw 500 or a TypeError. (Kept out of invoices.service.spec.ts, which sits at its size cap.)
 */
describe("#2662 createSplitInvoices — transaction timeout / missing invoice", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: InvoicesService;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });
    service = new InvoicesService(
      prisma as any,
      { emitInvoiceUpdated: jest.fn(), emitOrderStatusChanged: jest.fn() } as any,
      {} as any, // email
      {} as any, // pdf
      { get: jest.fn().mockResolvedValue(null) } as any,
      { writeSaleEntries: jest.fn() } as any,
      { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) } as any,
      {
        settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
        autoApplyOldestCreditsInTx: jest
          .fn()
          .mockResolvedValue({ applied: 0, invoiceStatus: null }),
      } as any,
      { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() } as any,
      {} as any, // storage
      { hasFlag: jest.fn().mockResolvedValue(false) } as any,
      { syncInvoiceCommissionSafe: jest.fn(), syncOrderInvoices: jest.fn() } as any,
      { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") } as any,
      { assertLinesSellable: jest.fn().mockResolvedValue(undefined) } as any,
      { can: jest.fn().mockResolvedValue(false) } as any, // EntitlementAuthority (#2241)
    );
    jest
      .spyOn(service as any, "resolveDefaultTerms")
      .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
    jest
      .spyOn(service as any, "resolveTenantInvoiceDefaults")
      .mockResolvedValue({ notes: null, terms: null, timezone: null });
    jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-1");
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-2662",
      customerId: "cust-1",
      orderNumber: "ORD-2662",
      subtotal: 20,
      tax: 0,
      lineItems: [
        {
          id: "li-1",
          productId: "p1",
          name: null,
          qty: 2,
          invoicedQty: 0,
          unitPrice: 10,
          originalPrice: null,
          priceType: "STANDARD",
          // #2645's whole-basis CAS reads every one of these off the line (null = none).
          subtotal: 20,
          promoFreeUnits: 0,
          categoryTaxAmount: 0,
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: false,
          boxes: null,
          unitsPerBox: null,
          unitLabel: null,
          notes: null,
          trackedCategoryId: null,
          trackedSubcategoryId: null,
          product: { name: "Widget", unitsPerBox: 0 },
        },
      ],
    });
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
  });

  it("control: the office path creates the invoice", async () => {
    prisma.invoice.create.mockResolvedValue({ id: "inv-1", items: [], payments: [], customer: {} });
    await expect(service.createInvoiceFromOrder("ord-2662")).resolves.toBeDefined();
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
  });

  it("a transaction timeout (P2028) is a 503 that says nothing was saved — never a raw 500", async () => {
    const timeout = Object.assign(
      new Error(
        "Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms",
      ),
      { code: "P2028" },
    );
    prisma.tenantTransaction.mockRejectedValueOnce(timeout);
    const err = await service.createInvoiceFromOrder("ord-2662").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
    expect(String((err as Error).message)).toMatch(/nothing was saved.*retry/i);
  });

  // #2624 (F-05 #2093) flags each created invoice with its group's restrictedLines right after the
  // create. The #2662 guard must come FIRST: with the flag line above it, a null create throws a
  // TypeError assigning onto null (the pre-guard 500) instead of the retryable 503.
  it("a null create throws the retry 503 BEFORE any restrictedLines write (guard above the #2624 flag)", async () => {
    prisma.invoice.create.mockResolvedValue(null);
    const err = await service.createInvoiceFromOrder("ord-2662").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(String((err as Error).message)).toMatch(/nothing was saved.*retry/i);
  });

  it("a create that yields no invoice stops cleanly (503) before anything reads it — never a TypeError", async () => {
    prisma.invoice.create.mockResolvedValue(undefined);
    const err = await service.createInvoiceFromOrder("ord-2662").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
  });
});
