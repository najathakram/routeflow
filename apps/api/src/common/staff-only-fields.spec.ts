import { readFileSync } from "fs";
import { join } from "path";
import {
  CUSTOMER_INVOICE_FIELDS,
  CUSTOMER_INVOICE_ITEM_FIELDS,
  CUSTOMER_ORDER_FIELDS,
  CUSTOMER_ORDER_ITEM_FIELDS,
  CUSTOMER_PAYMENT_FIELDS,
  invoiceDetailFor,
  orderFor,
  ordersFor,
  pickCustomerInvoiceFields,
  pickCustomerOrderFields,
  toCustomerOrder,
} from "./staff-only-fields";
import {
  INVOICE_LEAK_KEYS,
  LINE_LEAK_KEYS,
  ORDER_LEAK_KEYS,
  PAYMENT_LEAK_KEYS,
  expectNoStaffLeaks,
  leakyInvoice,
  leakyOrder,
  leakyPayment,
} from "./testing/customer-leak-fixtures";

/**
 * Customer-facing order and invoice responses are an ALLOWLIST projection, never "everything but
 * the staff keys": a column added to Order / OrderItem / Invoice / InvoicePayment tomorrow stays
 * staff-only until someone lists it. The helpers return a COPY (a staff caller holding the same row
 * is unaffected) and never mutate their input. Fixtures are placeholders.
 */
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
type Row = Record<string, any>;

describe("the allowlists", () => {
  it.each([
    ["order", CUSTOMER_ORDER_FIELDS, ORDER_LEAK_KEYS],
    ["order line", CUSTOMER_ORDER_ITEM_FIELDS, LINE_LEAK_KEYS],
    ["invoice", CUSTOMER_INVOICE_FIELDS, INVOICE_LEAK_KEYS],
    ["invoice line", CUSTOMER_INVOICE_ITEM_FIELDS, LINE_LEAK_KEYS],
    ["payment", CUSTOMER_PAYMENT_FIELDS, PAYMENT_LEAK_KEYS],
  ] as const)("%s: none of the known staff-internal columns is listed", (_n, allowed, leaks) => {
    for (const key of leaks) expect(allowed as readonly string[]).not.toContain(key);
  });

  it("every entry is unique", () => {
    for (const list of [
      CUSTOMER_ORDER_FIELDS,
      CUSTOMER_ORDER_ITEM_FIELDS,
      CUSTOMER_INVOICE_FIELDS,
      CUSTOMER_INVOICE_ITEM_FIELDS,
      CUSTOMER_PAYMENT_FIELDS,
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe("pickCustomerOrderFields", () => {
  it("drops every known staff-internal column and a column that does not exist yet, at every level", () => {
    const out = pickCustomerOrderFields(leakyOrder()) as Row;
    expectNoStaffLeaks(out);
    expect(out.lineItems[0]).not.toHaveProperty("overrideReason");
    expect(out).not.toHaveProperty("idempotencyKey");
    expect(out).not.toHaveProperty("futureStaffColumn");
  });

  it("keeps what the buyer screens read, projects relations, drops the rest", () => {
    const out = pickCustomerOrderFields(leakyOrder()) as Row;
    expect(out).toMatchObject({ id: "ord-1", orderNumber: "ORD-1", status: "PENDING", total: 10 });
    expect(out.notes).toBe("customer note");
    expect(out.customer).toEqual({ id: "cust-1", businessName: "Acme Buyer" });
    expect(out.lineItems[0]).toMatchObject({ id: "li-1", qty: 2, unitPrice: 5, subtotal: 10 });
    expect(out.lineItems[0].product).toEqual({ id: "p-1", name: "Widget", unit: "ea" });
  });

  it("keeps the derived order parts a buyer screen reads and trims their staff parts", () => {
    const out = pickCustomerOrderFields({
      ...leakyOrder(),
      editWindow: { editable: true, editableUntil: null, closedReason: null },
      routeRun: { status: "ACTIVE", startedAt: null, driverId: "drv-1" },
      changeRequests: [{ id: "cr-1", type: "ADD_ITEM", status: "PENDING", requestedById: "u-1" }],
      _count: { changeRequests: 1 },
    }) as Row;
    expect(out.editWindow).toEqual({ editable: true, editableUntil: null, closedReason: null });
    expect(out.routeRun).toEqual({ status: "ACTIVE", startedAt: null });
    expect(out.changeRequests).toEqual([{ id: "cr-1", type: "ADD_ITEM", status: "PENDING" }]);
    expect(out._count).toEqual({ changeRequests: 1 });
  });

  it("keeps a shipped order's fulfilment and shipment fields (the buyer's shipment card reads them)", () => {
    const shippedAt = new Date("2026-10-01T15:00:00.000Z");
    const out = toCustomerOrder({
      ...leakyOrder(),
      fulfillPath: "SHIP",
      shippingCarrier: "UPS",
      shippingTrackingNumber: "1Z999",
      shippedAt,
    }) as Row;
    expect(out).toMatchObject({
      fulfillPath: "SHIP",
      shippingCarrier: "UPS",
      shippingTrackingNumber: "1Z999",
      shippedAt,
    });
  });

  it("drops DRAFT invoices from the order's invoice list and keeps a lean stub of the rest", () => {
    const out = pickCustomerOrderFields(leakyOrder()) as Row;
    expect(out.invoices).toEqual([
      { id: "inv-sent", invoiceNumber: "INV-S", status: "SENT", total: 10 },
    ]);
  });

  it("never mutates its input", () => {
    const input = leakyOrder();
    const snapshot = json(input);
    pickCustomerOrderFields(input);
    expect(json(input)).toEqual(snapshot);
  });

  it("is null-safe and passes a non-object through", () => {
    expect(pickCustomerOrderFields(null)).toBeNull();
    expect(pickCustomerOrderFields(undefined)).toBeUndefined();
    expect(pickCustomerOrderFields("x")).toBe("x");
    expect(pickCustomerOrderFields({ id: "o", idempotencyKey: "k" })).toEqual({ id: "o" });
  });

  it("is idempotent (the service and the controller may both apply it)", () => {
    const once = pickCustomerOrderFields(leakyOrder());
    expect(pickCustomerOrderFields(once)).toEqual(once);
  });
});

describe("pickCustomerInvoiceFields", () => {
  it("drops every known staff-internal column and a future one, at every level", () => {
    const out = pickCustomerInvoiceFields(leakyInvoice()) as Row;
    expectNoStaffLeaks(out);
    expect(out).not.toHaveProperty("writeOffReason");
    expect(out.payments[0]).not.toHaveProperty("imageKey");
    expect(out.payments[0]).not.toHaveProperty("bounceReason");
  });

  it("keeps what the buyer screens read; without the option every payment row stays", () => {
    const out = pickCustomerInvoiceFields(leakyInvoice()) as Row;
    expect(out).toMatchObject({ id: "inv-1", invoiceNumber: "INV-1", total: 20 });
    expect(out.notes).toBe("printed on the invoice");
    expect(out.items[0]).toMatchObject({ id: "li-1", description: "Widget", unitPrice: 5 });
    expect(out.payments.map((p: Row) => p.id)).toEqual(["p-paid", "p-draft", "p-void"]);
    expect(out.payments[0]).toMatchObject({ amount: 3, method: "CASH", status: "PAID" });
  });

  it("keeps a payment's credit note and trims it to what the buyer sees", () => {
    const out = pickCustomerInvoiceFields({
      payments: [
        leakyPayment({
          creditNote: { id: "cn-1", creditNoteNumber: "CN-1", amount: 5, createdById: "u-1" },
        }),
      ],
    }) as Row;
    expect(out.payments[0].creditNote).toEqual({ id: "cn-1", creditNoteNumber: "CN-1", amount: 5 });
  });

  it("names the levy apart from the tax: regularTaxAmount and one charge per category, from the raw lines (row 398)", () => {
    const out = pickCustomerInvoiceFields({
      id: "inv-1",
      taxAmount: 5.4,
      items: [
        {
          id: "li-1",
          categoryTaxAmount: "2.80",
          trackedCategoryId: "cat-1",
          trackedCategory: { id: "cat-1", name: "CRV", invoiceTreatment: "LINE_TAX" },
          categoryTaxType: "DEPOSIT_PER_CONTAINER",
          staffOnlyCost: 9,
        },
        { id: "li-2", categoryTaxAmount: 0 },
      ],
    }) as Row;
    expect(out.taxAmount).toBe(5.4); // the stored header, unchanged
    expect(out.regularTaxAmount).toBe(2.6);
    // the key is opaque (the buyer never receives a category id: trackedCategoryId is off the projected line on purpose)
    expect(out.chargeLines).toEqual([{ key: "0", label: "CRV deposit", amount: 2.8 }]);
    // the raw category row and the snapshot columns are still not on the buyer's line
    expect(out.items[0]).not.toHaveProperty("trackedCategory");
    expect(out.items[0]).not.toHaveProperty("categoryTaxType");
    expect(out.items[0]).not.toHaveProperty("staffOnlyCost");
  });

  it("names an older line by its category's type: no frozen categoryTaxType (before the B297 migration) still reads 'CRV deposit'", () => {
    const out = pickCustomerInvoiceFields({
      taxAmount: 5.4,
      items: [
        {
          id: "li-1",
          categoryTaxAmount: "2.80",
          categoryTaxType: null,
          trackedCategoryId: "cat-1",
          // what InvoicesService.findOne selects for the category row (id, name, taxType, invoiceTreatment)
          trackedCategory: {
            id: "cat-1",
            name: "CRV",
            taxType: "DEPOSIT_PER_CONTAINER",
            invoiceTreatment: "LINE_TAX",
          },
        },
      ],
    }) as Row;
    expect(out.chargeLines).toEqual([{ key: "0", label: "CRV deposit", amount: 2.8 }]);
  });

  it("is idempotent for a levied invoice: a second pass over the projection keeps the named charges", () => {
    const raw = {
      taxAmount: 7.4,
      items: [
        {
          id: "a",
          categoryTaxAmount: 2.8,
          trackedCategoryId: "c1",
          trackedCategory: { id: "c1", name: "CRV", taxType: "DEPOSIT_PER_CONTAINER" },
        },
        {
          id: "b",
          categoryTaxAmount: 2,
          trackedCategoryId: "c2",
          trackedCategory: { id: "c2", name: "Tobacco", taxType: "EXCISE_PER_UNIT" },
        },
      ],
    };
    const once = pickCustomerInvoiceFields(raw) as Row;
    expect(once.chargeLines.map((c: Row) => c.label)).toEqual(["CRV deposit", "Tobacco excise"]);
    expect(pickCustomerInvoiceFields(once)).toEqual(once);
  });

  it("an invoice with no levy has the whole header as regular tax and no charges; a list row (no items) adds neither", () => {
    const flat = pickCustomerInvoiceFields({ taxAmount: 3.3, items: [{ id: "a" }] }) as Row;
    expect(flat.regularTaxAmount).toBe(3.3);
    expect(flat.chargeLines).toEqual([]);
    const list = pickCustomerInvoiceFields({ taxAmount: 3.3 }) as Row;
    expect(list).not.toHaveProperty("regularTaxAmount");
    expect(list).not.toHaveProperty("chargeLines");
  });

  it("confirmedPaymentsOnly keeps only PAID payment rows", () => {
    const out = pickCustomerInvoiceFields(leakyInvoice(), { confirmedPaymentsOnly: true }) as Row;
    expect(out.payments.map((p: Row) => p.id)).toEqual(["p-paid"]);
  });

  it("never mutates its input", () => {
    const input = leakyInvoice();
    const snapshot = json(input);
    pickCustomerInvoiceFields(input, { confirmedPaymentsOnly: true });
    expect(json(input)).toEqual(snapshot);
  });

  it("is null-safe and idempotent", () => {
    expect(pickCustomerInvoiceFields(null)).toBeNull();
    expect(pickCustomerInvoiceFields({ id: "i", internalNotes: "x" })).toEqual({ id: "i" });
    const once = pickCustomerInvoiceFields(leakyInvoice());
    expect(pickCustomerInvoiceFields(once)).toEqual(once);
  });
});

describe("customer-facing PDFs never render a staff-only field", () => {
  const renderers = [
    "../invoices/invoice-pdf.service.ts",
    "../invoices/invoice-pdf-item.ts",
    "../invoices/invoice-pdf-variant.ts",
    "../buyer/statement-pdf.service.ts",
    "../buyer/statement.service.ts",
  ];
  const names = ["overrideReason", "overriddenBy", "commissionRatePct", "internalNotes"];

  it.each(renderers)("%s references none of them", (rel) => {
    const src = readFileSync(join(__dirname, rel), "utf8");
    for (const name of names) expect(src).not.toContain(name);
    // A payment's `notes` never reaches a renderer either.
    expect(src).not.toMatch(/payments?\b[^;\n]*\.notes\b/);
    expect(src).not.toMatch(/\bp(ayment)?\.notes\b/);
  });
});

// The role gate the services call (kept out of orders.service / invoices.service, which sit at their
// size-ratchet caps): a CUSTOMER gets the projected copy, anyone else the value exactly as read.
describe("orderFor / ordersFor / invoiceDetailFor: the CUSTOMER gate", () => {
  const customer = { role: "CUSTOMER" };
  const staff = { role: "OPERATOR" };

  it("a CUSTOMER gets the projection of an order, a page of orders and an invoice detail", () => {
    expectNoStaffLeaks(orderFor(customer, leakyOrder()));
    const page = ordersFor(customer, [leakyOrder(), leakyOrder()]);
    expect(page).toHaveLength(2);
    for (const row of page) expectNoStaffLeaks(row);
    expectNoStaffLeaks(invoiceDetailFor(customer, leakyInvoice()));
  });

  it("anyone else (staff, no user) gets the SAME object back, untouched", () => {
    const order = leakyOrder();
    const rows = [leakyOrder()];
    const invoice = leakyInvoice();
    for (const caller of [staff, undefined, null, {}]) {
      expect(orderFor(caller, order)).toBe(order);
      expect(ordersFor(caller, rows)).toBe(rows);
      expect(invoiceDetailFor(caller, invoice)).toBe(invoice);
    }
  });
});

// ─── OOS PR2 (SA-714 R3d): the buyer-visible `backordered` flag is DERIVED, never the raw marker ───
describe("toCustomerOrder: the derived backordered flag follows the seller's visibility", () => {
  const order = (marker?: unknown) => ({
    id: "o1",
    status: "CONFIRMED",
    lineItems: [
      {
        id: "li-1",
        qty: 2,
        unitPrice: 5,
        // Seller-internal columns: never in a buyer response, the marker included.
        ...(marker !== undefined ? { backorderPieces: marker } : {}),
        costPrice: 3,
      },
    ],
  });
  const line = (res: unknown) =>
    (res as { lineItems: Array<Record<string, unknown>> }).lineItems[0];

  it("show: a backordered line carries backordered:true and a normal line backordered:false", () => {
    expect(line(toCustomerOrder(order(4), { backorderVisibility: "show" })).backordered).toBe(true);
    expect(line(toCustomerOrder(order(0), { backorderVisibility: "show" })).backordered).toBe(
      false,
    );
  });

  it("hide (and no option at all): NO trace of backorders reaches the buyer", () => {
    for (const out of [
      toCustomerOrder(order(4), { backorderVisibility: "hide" }),
      toCustomerOrder(order(4)),
      toCustomerOrder(order(4), {}),
    ]) {
      expect("backordered" in line(out)).toBe(false);
      expect("backorderPieces" in line(out)).toBe(false);
    }
  });

  it("the raw marker is NEVER in a buyer response, under show either", () => {
    const out = line(toCustomerOrder(order(4), { backorderVisibility: "show" }));
    expect("backorderPieces" in out).toBe(false);
    expect("costPrice" in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(["backordered", "id", "qty", "unitPrice"]);
  });

  it("a line with no marker column yet (today) gets no flag even under show", () => {
    expect("backordered" in line(toCustomerOrder(order(), { backorderVisibility: "show" }))).toBe(
      false,
    );
  });

  it("no marker or backorder column name is in the line allowlist (a new column stays staff-only)", () => {
    for (const k of CUSTOMER_ORDER_ITEM_FIELDS) {
      expect(k).not.toMatch(/backorder/i);
    }
  });

  it("orderFor / ordersFor pass the option to a CUSTOMER and leave staff untouched", () => {
    const o = order(4);
    const customer = { role: "CUSTOMER" };
    expect(line(orderFor(customer, o, { backorderVisibility: "show" })).backordered).toBe(true);
    expect(line(ordersFor(customer, [o], { backorderVisibility: "show" })[0]).backordered).toBe(
      true,
    );
    expect(orderFor({ role: "OPERATOR" }, o, { backorderVisibility: "show" })).toBe(o);
  });
});
