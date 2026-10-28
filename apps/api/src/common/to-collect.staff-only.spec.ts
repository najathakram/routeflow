import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import {
  CUSTOMER_INVOICE_FIELDS,
  CUSTOMER_ORDER_FIELDS,
  invoiceDetailFor,
  orderFor,
} from "./staff-only-fields";

/**
 * SA-1026 A-G9: "To collect" and its intent are STAFF-ONLY. The buyer, a statement and a customer email never carry the
 * `toCollect` key, the `expectedPaymentMethod` column or the words "To collect". The buyer projections are ALLOWLISTS, so
 * the new fields are staff-only by construction; this spec pins that and scans the buyer-facing code so a later edit that
 * starts to read them fails here.
 */
const SRC = join(__dirname, "..");
const NAMES = /toCollect|expectedPaymentMethod|to-collect|To collect/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".d.ts"))
      out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join("/");

describe("the buyer allowlists never name the new fields", () => {
  it("CUSTOMER_INVOICE_FIELDS and CUSTOMER_ORDER_FIELDS omit toCollect and expectedPaymentMethod", () => {
    for (const list of [CUSTOMER_INVOICE_FIELDS, CUSTOMER_ORDER_FIELDS] as readonly string[][]) {
      expect(list).not.toContain("toCollect");
      expect(list).not.toContain("expectedPaymentMethod");
    }
  });

  it("a CUSTOMER's invoice detail and order drop both, a staff reader keeps the row as read", () => {
    const inv = {
      id: "i1",
      status: "SENT",
      total: 10,
      expectedPaymentMethod: "CHECK",
      toCollect: "TO_COLLECT",
    };
    const ord = { id: "o1", status: "DELIVERED", toCollect: "TO_COLLECT" };
    const buyer = { sub: "u1", role: "CUSTOMER" } as never;
    const staff = { sub: "u2", role: "OPERATOR" } as never;
    expect(JSON.stringify(invoiceDetailFor(buyer, inv))).not.toMatch(NAMES);
    expect(JSON.stringify(orderFor(buyer, ord))).not.toMatch(NAMES);
    expect(invoiceDetailFor(staff, inv)).toBe(inv);
    expect(orderFor(staff, ord)).toBe(ord);
  });
});

describe("buyer-facing code never reads them", () => {
  const buyerFacing = [
    ...files(join(SRC, "buyer")).filter((f) => !/buyer-admin/.test(f)),
    ...files(join(SRC, "email")),
    ...["invoice-pdf.service.ts", "invoice-pdf-item.ts", "invoice-pdf-variant.ts"].map((n) =>
      join(SRC, "invoices", n),
    ),
  ];

  it("has files to scan", () => {
    expect(buyerFacing.length).toBeGreaterThan(10);
  });

  it("no buyer, email or PDF file references toCollect, expectedPaymentMethod or 'To collect'", () => {
    const offenders = buyerFacing.filter((f) => NAMES.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the buyer's own statement builder (before the staff builder) never names them", () => {
    const text = readFileSync(join(SRC, "customers", "customer-statement.ts"), "utf8");
    const buyerHalf = text
      .slice(0, text.indexOf("export async function buildOperatorStatement"))
      .replace(/^import .*$/gm, "");
    expect(buyerHalf).not.toMatch(/toCollect|expectedPaymentMethod|To collect/);
  });

  it("the staff builder gates the key on the staff-only flag (the buyer route calls it without)", () => {
    const text = readFileSync(join(SRC, "customers", "customer-statement.ts"), "utf8");
    expect(text).toMatch(/opts\?\.includeExposure\s*\?\s*\{\s*toCollect:/);
  });
});
