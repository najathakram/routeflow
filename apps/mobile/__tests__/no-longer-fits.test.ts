import { readFileSync } from "fs";
import { join } from "path";

/**
 * W-769 (owner 7b = A, SA-910 Part 2 step 4, SA-922 answer 4), mirrors web's invoice page: a payment the api marks
 * `noLongerFits` shows the ONE shared sentence (packages/types) on the mobile invoice, with a Void action through the
 * EXISTING payment PATCH (`status: "VOID"`). Master: the helper and the copy do not exist (the RED).
 */
const FLAG = "No longer fits this invoice: void it or move it to the customer's credit.";

describe("the no-longer-fits flag (mobile, W-769)", () => {
  const load = () => require("../lib/payment-no-longer-fits");

  it("a flagged unconfirmed row reads the shared sentence; a row that still fits reads nothing", () => {
    const { noLongerFitsCopy } = load();
    expect(noLongerFitsCopy({ status: "DRAFT", noLongerFits: true })).toBe(FLAG);
    expect(noLongerFitsCopy({ status: "DRAFT", noLongerFits: false })).toBeNull();
    expect(noLongerFitsCopy({ status: "PAID" })).toBeNull();
  });

  it("Void is the existing PATCH body with status VOID (amount and method kept, the DTO requires them)", () => {
    const { voidPaymentBody } = load();
    expect(voidPaymentBody({ amount: "100.00", method: "CHECK" })).toEqual({
      amount: 100,
      method: "CHECK",
      status: "VOID",
    });
  });

  it("the copy is the ONE constant in packages/types (no mobile-local sentence)", () => {
    const src = readFileSync(join(__dirname, "..", "lib/payment-no-longer-fits.ts"), "utf8");
    expect(src).toMatch(/from "@routeflow\/types/);
    expect(src).not.toContain("No longer fits this invoice");
  });

  it("the invoice screen shows the flag and offers Void on the flagged row", () => {
    const screen = readFileSync(
      join(__dirname, "..", "app/(operator)/(tabs)/invoices/[id].tsx"),
      "utf8",
    );
    expect(screen).toMatch(/noLongerFitsCopy\(/);
    expect(screen).toMatch(/voidPaymentBody\(/);
  });
});
