import { REMINDER_INVOICE_INCLUDE } from "./invoice-reminder-email";
import { SEND_SNAPSHOT_INCLUDE } from "./invoice-send-snapshot";

/**
 * W-1185: a plain invoice line counts in its selling unit, read from the loaded `product.unit`. Both
 * loaders that feed the "Items" count (the PDF/send snapshot and the reminder) must select it; if one
 * stops, the count silently reads pcs with every other test green.
 */
describe("the invoice item-count loaders select product.unit (W-1185)", () => {
  it("the send/PDF snapshot selects the product's unit", () => {
    expect(SEND_SNAPSHOT_INCLUDE.items.include.product.select.unit).toBe(true);
  });

  it("the reminder loader selects the product's unit", () => {
    expect(REMINDER_INVOICE_INCLUDE.items.include.product.select.unit).toBe(true);
  });
});
