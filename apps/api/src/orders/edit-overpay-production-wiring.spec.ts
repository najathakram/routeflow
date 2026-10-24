/**
 * SA-763r P-3: production wiring of the overpay judge. updateOrderItems calls the judge and the price follow on
 * `this.invoicesService`; in production that is the REAL InvoicesService injected by Nest (no facade, no proxy),
 * so the two methods must exist on the class and OrdersService must be constructed against that class. A spec
 * that hand-builds OrdersService with a partial `invoicesService` is a harness gap (they spread
 * testing/invoice-edit-stubs.ts); the judge now fails CLEARLY when the dependency is incomplete.
 */
import "reflect-metadata";

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { InvoicesService } from "../invoices/invoices.service";
import { OrdersService } from "./orders.service";
import { assertEditCannotOverpay } from "./edit-overpay-judge";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

describe("overpay judge: production wiring", () => {
  it("OrdersService's Nest-injected invoices dependency is the real InvoicesService class", () => {
    const params: unknown[] = Reflect.getMetadata("design:paramtypes", OrdersService);
    expect(params).toContain(InvoicesService);
    const names = new Set(params.map((p) => (p as { name?: string })?.name));
    expect(names.has("InvoicesService")).toBe(true);
  });

  it("the real class exposes every method updateOrderItems reaches on it for the judge and the follow", () => {
    for (const m of ["projectEditedInvoiceTotals", "followPartialPrices"] as const)
      expect(typeof InvoicesService.prototype[m]).toBe("function");
  });

  it("the shared stub covers exactly those two methods", () => {
    expect(Object.keys(INVOICE_EDIT_STUBS).sort()).toEqual([
      "followPartialPrices",
      "projectEditedInvoiceTotals",
    ]);
  });

  it("an incomplete invoices dependency fails CLEARLY, not with 'is not a function'", async () => {
    const tx = { $executeRaw: jest.fn(), invoicePayment: { findMany: jest.fn() } };
    await expect(
      assertEditCannotOverpay({ invoices: {} as never, tenantId: "t" }, tx, "ord-1", {
        resync: false,
        partials: true,
      }),
    ).rejects.toThrow(/no projectEditedInvoiceTotals.*real InvoicesService/);
  });
});
