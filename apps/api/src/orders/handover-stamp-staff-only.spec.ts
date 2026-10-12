import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Row 342 OWNER RULING: who handed an order over (cashier, register) is shown on STAFF views only, never on a customer copy:
 * the receipt, the invoice PDF and the emails. The stamp's helpers are read by exactly the staff reads (orders / invoices
 * findOne) and Today's sales; a customer-copy source that names one is a new leak, so this scan goes red on it.
 */
const SRC = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory()
      ? walk(p)
      : p.endsWith(".ts") && !p.endsWith(".spec.ts")
        ? [p]
        : [];
  });
const STAMP = /handedOverBy|HANDOVER_SOLD_BY_SELECT|stampHandedOverBy|seesHandOverStamp/;

describe("hand-over stamp stays off customer copies (row 342)", () => {
  const customerCopies = [
    ...readdirSync(join(SRC, "invoices"))
      .filter(
        (n) => /pdf|attachment|receipt/i.test(n) && n.endsWith(".ts") && !n.endsWith(".spec.ts"),
      )
      .map((n) => join(SRC, "invoices", n)),
    ...walk(join(SRC, "email")),
  ];

  it("there are customer-copy sources to scan", () => {
    expect(customerCopies.length).toBeGreaterThan(3);
  });

  it.each(customerCopies.map((p) => [p.slice(SRC.length + 1), p]))(
    "%s never names the stamp",
    (_n, p) => {
      expect(readFileSync(p, "utf8")).not.toMatch(STAMP);
    },
  );

  it("only the staff reads import the stamp helpers", () => {
    const users = walk(SRC)
      .filter((p) => STAMP.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(SRC.length + 1))
      .sort();
    expect(users).toEqual([
      "invoices/invoices.service.ts",
      "orders/counter-sale/counter-sale-today.ts",
      "orders/handover-stamp.ts",
      "orders/orders.service.ts",
    ]);
  });
});
