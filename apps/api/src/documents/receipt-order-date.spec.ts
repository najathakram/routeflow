import { buildReceiptModel } from "./receipt-model";
import { BRANDING, INVOICE, orderFixture, paymentsFixture } from "./receipt.fixtures";

/**
 * W-1188 PR-1b (R19): a counter sale rung on Nov 9 and dated Nov 6 prints the SALE day, and carries the entry time as
 * its own label; an undated sale prints exactly as before and carries no entered label. Placeholders only (acme).
 */
const ZONE = "America/Chicago";
const ENTERED = new Date("2026-11-09T22:12:00.000Z"); // Nov 9, 4:12 PM in Chicago
const build = (over: Parameters<typeof orderFixture>[0]) =>
  buildReceiptModel(orderFixture(over), [INVOICE], paymentsFixture(), BRANDING, ZONE);

describe("receipt: a dated counter sale (W-1188 R19)", () => {
  it("R19: dateLabel is the chosen day (not the entry time) and enteredLabel is the entry instant", () => {
    const m = build({ createdAt: ENTERED, orderDate: new Date("2026-11-06T00:00:00.000Z") });
    expect(m.dateLabel).toBe("Fri, Nov 6, 2026");
    expect(m.enteredLabel).toBe("Nov 9, 2026, 4:12 PM");
  });

  it("an undated counter sale prints the entry time and has no entered label (guard)", () => {
    const m = build({ createdAt: ENTERED, orderDate: null });
    expect(m.dateLabel).toBe("Nov 9, 2026, 4:12 PM");
    expect("enteredLabel" in m).toBe(false);
  });

  it("a counter sale dated to its own entry day is not dated (guard)", () => {
    const m = build({ createdAt: ENTERED, orderDate: new Date("2026-11-09T00:00:00.000Z") });
    expect(m.dateLabel).toBe("Nov 9, 2026, 4:12 PM");
    expect("enteredLabel" in m).toBe(false);
  });

  it("a future-dated sale prints the future day", () => {
    const m = build({ createdAt: ENTERED, orderDate: new Date("2026-11-16T00:00:00.000Z") });
    expect(m.dateLabel).toBe("Mon, Nov 16, 2026");
    expect(m.enteredLabel).toBe("Nov 9, 2026, 4:12 PM");
  });
});
