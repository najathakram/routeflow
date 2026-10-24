import { stampOverrideNames } from "./restriction-override-names";
import {
  pickCustomerInvoiceFields,
  pickCustomerOrderFields,
  toCustomerOrder,
} from "./staff-only-fields";

/**
 * Row 510: a STAFF read of an order or invoice resolves the overriding user's name onto each stamped line
 * (`restrictionOverrideByName`, null when the user is gone) with ONE query; a buyer read never gets it.
 */
const db = (users: Array<{ id: string; username: string | null; deletedAt?: Date | null }>) => ({
  user: { findMany: jest.fn().mockResolvedValue(users) },
});

describe("stampOverrideNames", () => {
  it("adds the resolved name to each stamped line, null for a user that is gone, one query", async () => {
    const lines = [
      { id: "1", restrictionOverrideBy: "u1" },
      { id: "2", restrictionOverrideBy: "u1" },
      { id: "3", restrictionOverrideBy: "gone" },
      { id: "5", restrictionOverrideBy: "removed" },
      { id: "4", restrictionOverrideBy: null },
    ];
    const d = db([
      { id: "u1", username: "pat" },
      { id: "removed", username: "old-timer", deletedAt: new Date("2026-09-01T00:00:00Z") },
    ]);
    await stampOverrideNames(d, lines, { role: "OPERATOR" });
    expect(lines).toEqual([
      { id: "1", restrictionOverrideBy: "u1", restrictionOverrideByName: "pat" },
      { id: "2", restrictionOverrideBy: "u1", restrictionOverrideByName: "pat" },
      { id: "3", restrictionOverrideBy: "gone", restrictionOverrideByName: null },
      { id: "5", restrictionOverrideBy: "removed", restrictionOverrideByName: null },
      { id: "4", restrictionOverrideBy: null },
    ]);
    expect(d.user.findMany).toHaveBeenCalledTimes(1);
    expect(d.user.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ["u1", "gone", "removed"] },
    });
  });

  it("reads nothing when no line is stamped, and nothing for a CUSTOMER viewer", async () => {
    const d = db([]);
    await stampOverrideNames(d, [{ restrictionOverrideBy: null }, {}], { role: "OPERATOR" });
    await stampOverrideNames(d, [{ restrictionOverrideBy: "u1" }], { role: "CUSTOMER" });
    await stampOverrideNames(d, undefined, { role: "OPERATOR" });
    expect(d.user.findMany).not.toHaveBeenCalled();
  });

  it("the buyer projections drop the name even if it were present", () => {
    const line = {
      id: "l",
      productId: "p",
      qty: 1,
      unitPrice: 1,
      subtotal: 1,
      restrictionOverrideBy: "u1",
      restrictionOverrideByName: "pat",
    };
    const outs = [
      toCustomerOrder({ id: "o", status: "PENDING", lineItems: [line] }).lineItems[0],
      pickCustomerOrderFields({ id: "o", status: "PENDING", lineItems: [line] }).lineItems[0],
      pickCustomerInvoiceFields({ id: "i", status: "SENT", payments: [], items: [line] }).items[0],
    ];
    for (const out of outs)
      expect(Object.keys(out).filter((k) => k.startsWith("restrictionOverride"))).toEqual([]);
  });
});
