/**
 * Test fixtures for the customer-facing allowlist (common/staff-only-fields.ts).
 *
 * `leaky*()` return a row shaped like what the services read for STAFF: every staff-internal column
 * the audit found on a customer-reachable response, plus `futureStaffColumn` on each level — a column
 * that does not exist yet, which stands for "whatever the next migration adds". A denylist leaks it;
 * an allowlist cannot. `expectNoStaffLeaks` walks a whole response and fails on ANY leak key at ANY
 * depth. Placeholders only (acme-style ids); no client data.
 */

export const ORDER_LEAK_KEYS = [
  "idempotencyKey",
  "skipAutoMerge",
  "routeRunId",
  "templateId",
  "commissionRatePct",
  "futureStaffColumn",
] as const;
export const LINE_LEAK_KEYS = ["overrideReason", "overriddenBy", "futureStaffColumn"] as const;
export const INVOICE_LEAK_KEYS = [
  "internalNotes",
  "writeOffReason",
  "feeForPaymentId",
  "recurringInvoiceId",
  "invoiceGroupId",
  "deliveryBatchId",
  "futureStaffColumn",
] as const;
export const PAYMENT_LEAK_KEYS = [
  "notes",
  "imageKey",
  "bankCharges",
  "bounceReason",
  "replacesPaymentId",
  "futureStaffColumn",
] as const;

/** Every leak key the walk refuses. `notes` is allowed on orders / lines / invoices (printed), refused on payments only. */
const ANY_DEPTH_LEAKS = new Set<string>([
  "averageCost", // a product's cost (the fixture's product carries it)
  "creditLimit", // a customer's commercial terms (the fixture's customer carries it)
  ...ORDER_LEAK_KEYS,
  ...LINE_LEAK_KEYS,
  ...INVOICE_LEAK_KEYS,
  ...PAYMENT_LEAK_KEYS.filter((k) => k !== "notes"),
]);

const filled = (keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, k === "skipAutoMerge" ? true : `staff-${k}`]));

export const leakyLine = () => ({
  id: "li-1",
  productId: "p-1",
  qty: 2,
  unitPrice: 5,
  subtotal: 10,
  status: "PENDING",
  ...filled(LINE_LEAK_KEYS),
  product: { id: "p-1", name: "Widget", unit: "ea", averageCost: 1, futureStaffColumn: "x" },
});

export const leakyPayment = (over: Record<string, unknown> = {}) => ({
  id: "pay-1",
  amount: 3,
  method: "CASH",
  status: "PAID",
  paidAt: new Date("2026-10-01T00:00:00.000Z"),
  ...filled(PAYMENT_LEAK_KEYS),
  ...over,
});

export const leakyOrder = () => ({
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "PENDING",
  notes: "customer note",
  total: 10,
  ...filled(ORDER_LEAK_KEYS),
  customer: { id: "cust-1", businessName: "Acme Buyer", creditLimit: 500, notes: "staff crm note" },
  lineItems: [leakyLine()],
  invoices: [
    {
      id: "inv-draft",
      invoiceNumber: "INV-D",
      status: "DRAFT",
      total: 10,
      ...filled(INVOICE_LEAK_KEYS),
    },
    {
      id: "inv-sent",
      invoiceNumber: "INV-S",
      status: "SENT",
      total: 10,
      ...filled(INVOICE_LEAK_KEYS),
    },
  ],
});

export const leakyInvoice = (status = "SENT") => ({
  id: "inv-1",
  customerId: "cust-1",
  invoiceNumber: "INV-1",
  status,
  total: 20,
  notes: "printed on the invoice",
  ...filled(INVOICE_LEAK_KEYS),
  items: [{ ...leakyLine(), description: "Widget" }],
  payments: [
    leakyPayment({ id: "p-paid", status: "PAID" }),
    leakyPayment({ id: "p-draft", status: "DRAFT" }),
    leakyPayment({ id: "p-void", status: "VOID" }),
  ],
});

/** Fails (listing each path) when ANY staff-internal key appears anywhere in `value`; a payment's `notes` too. */
export function expectNoStaffLeaks(value: unknown): void {
  const found: string[] = [];
  const walk = (v: unknown, path: string, inPayment: boolean) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, inPayment));
    if (!v || typeof v !== "object" || v instanceof Date) return;
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
      const here = `${path}.${key}`;
      if (ANY_DEPTH_LEAKS.has(key) || (key === "notes" && inPayment)) found.push(here);
      walk(child, here, inPayment || key === "payments");
    }
  };
  walk(value, "$", false);
  expect(found).toEqual([]);
}
