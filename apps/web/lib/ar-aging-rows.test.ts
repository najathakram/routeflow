/**
 * #1529 (B87) / SA-517 PR-B: the AR Aging Summary groups invoices by customer. A customer row is
 * marked when any of its invoices carries an overdue deposit (the API's per-row `depositOverdue`,
 * PR-A #2603), and one summary line reports the API's top-level `depositOverdue {count,
 * outstanding}`. Buckets and totals are untouched — the marker never moves an amount.
 */
import { depositOverdueLine, groupArAgingByCustomer } from "./ar-aging-rows";

const row = (id: string, customerId: string, balance: number, depositOverdue?: boolean) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  customer: { id: customerId, businessName: `Acme ${customerId}` },
  total: balance,
  balance,
  status: "SENT",
  ...(depositOverdue === undefined ? {} : { depositOverdue }),
});

describe("groupArAgingByCustomer (#1529)", () => {
  it("sums each customer's balance per bucket, exactly as before", () => {
    const grouped = groupArAgingByCustomer({
      current: [row("i1", "c1", 100), row("i2", "c1", 50), row("i3", "c2", 20)],
      days1_30: [row("i4", "c1", 5)],
    });
    expect(grouped.c1.buckets).toEqual({ current: 150, days1_30: 5 });
    expect(grouped.c2.buckets).toEqual({ current: 20 });
    expect(grouped.c1.name).toBe("Acme c1");
  });

  it("marks a customer when ANY of its invoices has an overdue deposit, in any bucket", () => {
    const grouped = groupArAgingByCustomer({
      current: [row("i1", "c1", 100, false), row("i2", "c2", 50, true)],
      days1_30: [row("i3", "c1", 5, true)],
    });
    expect(grouped.c1.depositOverdue).toBe(true);
    expect(grouped.c2.depositOverdue).toBe(true);
  });

  it("an API without the deposit fields (older response) marks nobody", () => {
    const grouped = groupArAgingByCustomer({ current: [row("i1", "c1", 100)] });
    expect(grouped.c1.depositOverdue).toBe(false);
  });
});

describe("depositOverdueLine (#1529)", () => {
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  it("reads count and outstanding, singular and plural", () => {
    expect(depositOverdueLine({ count: 1, outstanding: 250 }, fmt)).toBe(
      "1 deposit overdue · $250.00 outstanding",
    );
    expect(depositOverdueLine({ count: 3, outstanding: 650.5 }, fmt)).toBe(
      "3 deposits overdue · $650.50 outstanding",
    );
  });

  it("no overdue deposit (or an older response without the field) ⇒ no line", () => {
    expect(depositOverdueLine({ count: 0, outstanding: 0 }, fmt)).toBeNull();
    expect(depositOverdueLine(undefined, fmt)).toBeNull();
  });
});
