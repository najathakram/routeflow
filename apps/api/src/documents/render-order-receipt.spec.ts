import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { RECEIPT_FOOTER_MAX_CHARS } from "../system-config/receipt-footer";
import { buildReceiptModel } from "./receipt-model";
import { renderOrderReceipt } from "./render-order-receipt";
import { BRANDING, INVOICE, orderFixture, paymentsFixture } from "./receipt.fixtures";

const ZONE = "America/New_York";
const render = (
  order = orderFixture(),
  invoices = [INVOICE],
  payments = paymentsFixture(),
  branding = BRANDING,
  zone = ZONE,
) => renderOrderReceipt(order, invoices, payments, branding, zone);

/**
 * SA-751r: ONE receipt model feeds the print view and the email. The renderer is pure and works from stored rows only
 * (order, invoices, payments, branding, zone). Placeholders only (acme).
 */
describe("buildReceiptModel (stored rows -> the shared ReceiptModel)", () => {
  const model = buildReceiptModel(orderFixture(), [INVOICE], paymentsFixture(), BRANDING, ZONE);

  it("prices every line through computeLineSubtotal (a boxed line is prorated, never qty x unitPrice) and drops cancelled lines", () => {
    expect(model.lines.map((l) => [l.name, l.total, l.detail])).toEqual([
      ["Cola", 7.5, "3 × $2.50"],
      ["Chips", 15, "1 box + 3 pcs × $12.00 per box"],
      ["Loose candy", 4, "1 × $4.00"],
    ]);
  });

  it("carries ONE money model: Subtotal - Discounts + Tax + Adjustments = Total, with the stored 8% named", () => {
    expect(model).toMatchObject({
      subtotal: 27.5,
      discounts: 1,
      tax: 2.12,
      adjustments: 0,
      taxRatePercent: 8,
      total: 28.62,
      paid: 28.62,
      balanceDue: 0,
      orderNumber: "ORD-1001",
      invoiceNumber: "INV-2001",
      invoiceId: "inv-1",
    });
  });

  it("labels the tender in the till's order (cash first, then card) and shows Paid, not Balance, when covered", () => {
    expect(model.methodLabel).toBe("Cash + Card");
    expect(model.showPaid).toBe(true);
    expect(model.showBalance).toBe(false);
    expect(model.onAccount).toBe(false);
  });

  it("reads the sale time in the tenant's zone (not the server's), and falls back to UTC for an unknown zone", () => {
    expect(model.dateLabel).toBe("Oct 7, 2026, 11:15 AM");
    const bad = buildReceiptModel(
      orderFixture(),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      "Nowhere/Zone",
    );
    expect(bad.dateLabel).toBe("Oct 7, 2026, 3:15 PM");
  });

  it("builds the header from the branding and omits the customer for a walk-in", () => {
    expect(model.header).toEqual({
      name: "Acme Test Store",
      addressLines: ["1 Main St", "Springfield, IL 62701"],
      phone: "555-0100",
    });
    expect(model.customerName).toBe("Acme Test Customer");
    const walkIn = buildReceiptModel(
      orderFixture({ customer: { businessName: "Walk-in customer", isWalkIn: true } }),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(walkIn.customerName).toBeNull();
  });

  it("an unpaid named-customer sale is on account with the balance owing; nothing paid shows no Paid row", () => {
    const m = buildReceiptModel(
      orderFixture(),
      [{ ...INVOICE, status: "SENT" }],
      [],
      BRANDING,
      ZONE,
    );
    expect(m).toMatchObject({
      onAccount: true,
      showPaid: false,
      showBalance: true,
      balanceDue: 28.62,
      paid: 0,
    });
    expect(m.methodLabel).toBeNull();
  });

  it("counts PAID payments on live invoices only (a DRAFT / VOID payment and a void invoice's payment never count)", () => {
    const m = buildReceiptModel(
      orderFixture(),
      [INVOICE, { id: "inv-void", invoiceNumber: "INV-2000", status: "VOID" }],
      [
        { invoiceId: "inv-1", method: "CASH", amount: "10.00", status: "PAID" },
        { invoiceId: "inv-1", method: "CASH", amount: "5.00", status: "VOID" },
        { invoiceId: "inv-1", method: "CASH", amount: "7.00", status: "DRAFT" },
        { invoiceId: "inv-void", method: "CASH", amount: "50.00", status: "PAID" },
      ],
      BRANDING,
      ZONE,
    );
    expect(m.paid).toBe(10);
    expect(m.balanceDue).toBe(18.62);
    expect(m.invoiceNumber).toBe("INV-2001");
  });

  it("store credit is a tender too, named as such; an unnamed method is Other", () => {
    const m = buildReceiptModel(
      orderFixture(),
      [INVOICE],
      [
        { invoiceId: "inv-1", method: "CREDIT_NOTE", amount: "8.62", status: "PAID" },
        { invoiceId: "inv-1", method: "ZELLE", amount: "20.00", status: "PAID" },
      ],
      BRANDING,
      ZONE,
    );
    expect(m.methodLabel).toBe("Other + Store credit");
  });

  it("names a variant by its parent, and falls back to 'Item' for a line with no name at all", () => {
    const m = buildReceiptModel(
      orderFixture({
        lineItems: [
          {
            id: "a",
            name: null,
            status: "DELIVERED",
            qty: "1",
            unitPrice: "1.00",
            unitsPerBox: null,
            boxes: null,
            pieces: null,
            product: {
              name: "Strawberry",
              variantName: "Strawberry",
              parentProductId: "p-1",
              parent: { name: "Vape 50K" },
            },
          },
          {
            id: "b",
            name: null,
            status: "DELIVERED",
            qty: "1",
            unitPrice: "1.00",
            unitsPerBox: null,
            boxes: null,
            pieces: null,
            product: null,
          },
        ],
      }),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(m.lines.map((l) => l.name)).toEqual(["Vape 50K - Strawberry", "Item"]);
  });

  it("a model with no footer, no customer line to print and no cash handed over is null-safe (never undefined)", () => {
    const bare = buildReceiptModel(
      orderFixture({ customer: null }),
      [INVOICE],
      paymentsFixture(),
      { ...BRANDING, footer: undefined },
      ZONE,
    );
    expect(bare.footer).toBeNull();
    expect(bare.customerName).toBeNull();
    expect(bare.tendered).toBeNull();
    expect(bare.change).toBeNull();
  });

  it("splits what is left after tax into Adjustments (a re-price, a credit, regulated tax), never into Tax", () => {
    const m = buildReceiptModel(
      orderFixture({ total: "29.62" }),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(m).toMatchObject({ tax: 2.12, adjustments: 1, taxRatePercent: 8, total: 29.62 });
    const neg = buildReceiptModel(
      orderFixture({ total: "27.62" }),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(neg.adjustments).toBe(-1);
  });

  it("names the rate only when the stored rate reproduces the stored tax to the cent (the shared explainedTaxRatePercent rule)", () => {
    const wrong = buildReceiptModel(
      orderFixture({ tax: "2.50", total: "29.00" }),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(wrong.taxRatePercent).toBeNull();
    expect(wrong.tax).toBe(2.5);
    const mixed = buildReceiptModel(
      orderFixture(),
      [{ ...INVOICE, items: [{ taxRate: "0.0800" }, { taxRate: "0.0700" }] }],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(mixed.taxRatePercent).toBeNull();
    const noRows = buildReceiptModel(
      orderFixture(),
      [{ id: "inv-1", invoiceNumber: "INV-2001", status: "PAID" }],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(noRows.taxRatePercent).toBeNull();
  });

  it("a legacy invoice whose lines all store a 0 rate names no rate (never inferred from the header tax)", () => {
    const legacy = buildReceiptModel(
      orderFixture(),
      [{ ...INVOICE, items: [{ taxRate: "0" }, { taxRate: "0" }, { taxRate: "0" }] }],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(legacy.taxRatePercent).toBeNull();
  });

  it("no tax at all: Tax 0 (row hidden) and no rate", () => {
    const m = buildReceiptModel(
      orderFixture({ tax: "0.00", total: "26.50" }),
      [INVOICE],
      paymentsFixture([{ invoiceId: "inv-1", method: "CASH", amount: "26.50", status: "PAID" }]),
      BRANDING,
      ZONE,
    );
    expect(m).toMatchObject({ tax: 0, adjustments: 0, taxRatePercent: null });
  });

  it("cash handed over (Order.counterCashTendered) shows Tendered and the Change due on the cash applied; none stored shows neither", () => {
    const m = buildReceiptModel(
      orderFixture({ counterCashTendered: "50.00" }),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(m.tendered).toBe(50);
    expect(m.change).toBe(30); // 20.00 of the sale was cash
    expect(m.tenderedAsEntered).toBe(false);
    const exact = buildReceiptModel(
      orderFixture({ counterCashTendered: "20.00" }),
      [INVOICE],
      paymentsFixture(),
      BRANDING,
      ZONE,
    );
    expect(exact.change).toBe(0);
  });

  it("caps the footer at 200 characters", () => {
    const m = buildReceiptModel(
      orderFixture(),
      [INVOICE],
      paymentsFixture(),
      { ...BRANDING, footer: "x".repeat(300) },
      ZONE,
    );
    expect(m.footer).toHaveLength(200);
  });

  it("cuts the footer by code points, never through a surrogate pair (the one cap the settings route enforces)", () => {
    const m = buildReceiptModel(
      orderFixture(),
      [INVOICE],
      paymentsFixture(),
      { ...BRANDING, footer: "\u{1F600}".repeat(250) },
      ZONE,
    );
    expect(Array.from(m.footer ?? "")).toHaveLength(RECEIPT_FOOTER_MAX_CHARS);
    expect(m.footer).toBe("\u{1F600}".repeat(RECEIPT_FOOTER_MAX_CHARS));
    // a lone surrogate would break the email's encoding
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(m.footer ?? "")).toBe(false);
  });

  it("uses the settings route's constant: there is no second footer cap", () => {
    expect(RECEIPT_FOOTER_MAX_CHARS).toBe(200);
  });
});

describe("renderOrderReceipt (email)", () => {
  const out = render();

  it("returns the model it rendered, a subject naming the business and the order, and html + a plain-text alternative", () => {
    expect(out.model.total).toBe(28.62);
    expect(out.subject).toBe("Your receipt from Acme Test Store (Order ORD-1001)");
    expect(out.html).toContain("<!DOCTYPE html>");
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("prints the same lines as the print view: numbers, every line and its detail, subtotal, Tax (rate), total, tender, paid", () => {
    for (const body of [out.html, out.text]) {
      expect(body).toContain("ORD-1001");
      expect(body).toContain("INV-2001");
      expect(body).toContain("Cola");
      expect(body).toContain("3 × $2.50");
      expect(body).toContain("1 box + 3 pcs × $12.00 per box");
      expect(body).toContain("$15.00");
      expect(body).toContain("Subtotal");
      expect(body).toContain("$27.50");
      expect(body).toContain("Discounts");
      expect(body).toContain("-$1.00");
      expect(body).toContain("$5.00"); // the struck list price of the discounted line
      expect(body).toContain("Tax (8%)");
      expect(body).toContain("$2.12");
      expect(body).not.toContain("Adjustments");
      expect(body).not.toContain("Tax and adjustments");
      expect(body).toContain("Total");
      expect(body).toContain("$28.62");
      expect(body).toContain("Payment method");
      expect(body).toContain("Cash + Card");
      expect(body).toContain("Paid");
      expect(body).not.toContain("Cancelled item");
      expect(body).not.toContain("99.00");
    }
  });

  it("prints an Adjustments row only when something remains after tax, and plain Tax when no rate is named", () => {
    const adj = render(orderFixture({ total: "29.62", tax: "2.50" }), [INVOICE], paymentsFixture());
    for (const body of [adj.html, adj.text]) {
      expect(body).toContain("Adjustments");
      expect(body).toContain("$0.62");
      expect(body).toMatch(/Tax(?! \()/);
      expect(body).not.toContain("Tax (");
    }
  });

  it("prints the customer line for a named customer only, and Tendered / Change when cash was handed over", () => {
    for (const body of [out.html, out.text]) expect(body).toContain("Customer: Acme Test Customer");
    const walkIn = render(
      orderFixture({
        customer: { businessName: "Walk-in customer", isWalkIn: true },
        counterCashTendered: "50.00",
      }),
    );
    for (const body of [walkIn.html, walkIn.text]) {
      expect(body).not.toContain("Customer:");
      expect(body).toContain("Tendered");
      expect(body).toContain("$50.00");
      expect(body).toContain("Change");
      expect(body).toContain("$30.00");
    }
    const named = render(
      orderFixture({ customer: { businessName: "Acme <b>Test</b>", isWalkIn: false } }),
    );
    expect(named.html).toContain("Customer: Acme &lt;b&gt;Test&lt;/b&gt;");
  });

  it("prints zeros as $0.00, never a dash or an empty cell, and never NaN", () => {
    const free = render(
      orderFixture({ total: "0.00", tax: "0.00", lineItems: [orderFixture().lineItems[2]] }),
      [INVOICE],
      [],
    );
    for (const body of [free.html, free.text]) {
      expect(body).toContain("$0.00");
      expect(body).not.toMatch(/NaN|undefined|null/);
    }
    expect(free.html).not.toMatch(/>\s*[—–-]\s*</);
  });

  it("shows the on-account balance instead of Paid when nothing was taken", () => {
    const unpaid = render(orderFixture(), [{ ...INVOICE, status: "SENT" }], []);
    for (const body of [unpaid.html, unpaid.text]) {
      expect(body).toContain("On account");
      expect(body).toContain("Balance due");
    }
  });

  it("HTML-escapes every tenant- and catalogue-typed string (business name, address, product, footer): a script tag never survives (SA-762r F6)", () => {
    const evil = '<script>alert("x")</script>';
    const o = orderFixture({
      lineItems: [
        {
          ...orderFixture().lineItems[2],
          name: `Candy ${evil}`,
        },
      ],
    });
    const r = render(o, [INVOICE], paymentsFixture(), {
      ...BRANDING,
      businessName: `Acme ${evil}`,
      street: `1 ${evil}`,
      footer: `Thanks ${evil} & come again`,
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain(
      "Thanks &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; come again",
    );
    // the plain-text part is not HTML: it carries the footer as typed
    expect(r.text).toContain("Thanks");
  });

  it("strips CR / LF from a business name in the subject (no header injection)", () => {
    const r = render(orderFixture(), [INVOICE], paymentsFixture(), {
      ...BRANDING,
      businessName: "Acme\r\nBcc: x@example.com",
    });
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it("falls back to a plain subject and header when the business has no name on file", () => {
    const r = render(orderFixture(), [INVOICE], paymentsFixture(), {
      ...BRANDING,
      businessName: "",
    });
    expect(r.subject).toBe("Your receipt (Order ORD-1001)");
  });

  it("prints the footer only when the model carries one", () => {
    expect(out.html).not.toContain("Thanks for");
    const withFooter = render(orderFixture(), [INVOICE], paymentsFixture(), {
      ...BRANDING,
      footer: "Thanks for shopping",
    });
    expect(withFooter.html).toContain("Thanks for shopping");
    expect(withFooter.text).toContain("Thanks for shopping");
  });
});

/**
 * G4, snapshot-free: for a spread of carts the money the email prints is the money the model holds, and the model's lines
 * add up to the order's total once the Tax and Adjustments rows are counted. A deterministic generator (no Math.random) so a red run
 * reproduces.
 */
describe("print/email parity: the totals are the model's totals (property)", () => {
  let seed = 20261010;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const money = (n: number) => `$${n.toFixed(2)}`;

  it.each(Array.from({ length: 40 }, (_, i) => i))("cart %i", () => {
    const n = 1 + Math.floor(next() * 5);
    const lineItems = Array.from({ length: n }, (_, i) => {
      const boxed = next() < 0.4;
      const unitPrice = roundMoney(0.5 + next() * 40);
      if (boxed) {
        const upb = 2 + Math.floor(next() * 23);
        const boxes = Math.floor(next() * 4);
        const pieces = Math.floor(next() * upb);
        return {
          id: `l${i}`,
          name: `Boxed ${i}`,
          status: "DELIVERED",
          qty: String(boxes * upb + pieces || 1),
          unitPrice: unitPrice.toFixed(2),
          unitsPerBox: upb,
          boxes,
          pieces,
          product: null,
        };
      }
      return {
        id: `l${i}`,
        name: `Plain ${i}`,
        status: "DELIVERED",
        qty: String(1 + Math.floor(next() * 9)),
        unitPrice: unitPrice.toFixed(2),
        unitsPerBox: null,
        boxes: null,
        pieces: null,
        product: null,
      };
    });
    const net = roundMoney(
      lineItems.reduce(
        (s, l) =>
          s +
          computeLineSubtotal({
            unitPrice: Number(l.unitPrice),
            qty: Number(l.qty),
            boxes: l.boxes,
            pieces: l.pieces,
            unitsPerBox: l.unitsPerBox,
          }),
        0,
      ),
    );
    const tax = roundMoney(net * 0.0825);
    const total = roundMoney(net + tax);
    const order = orderFixture({ lineItems, total: total.toFixed(2), tax: tax.toFixed(2) });
    const paid = roundMoney(total * (next() < 0.5 ? 1 : 0.5));
    const r = render(
      order,
      [INVOICE],
      [{ invoiceId: "inv-1", method: "CASH", amount: paid.toFixed(2), status: "PAID" }],
    );

    expect(roundMoney(r.model.lines.reduce((s, l) => s + l.total, 0))).toBe(net);
    expect(
      roundMoney(r.model.subtotal - r.model.discounts + r.model.tax + r.model.adjustments),
    ).toBe(r.model.total);
    expect(r.model.total).toBe(total);
    for (const body of [r.html, r.text]) {
      expect(body).toContain(money(r.model.subtotal));
      expect(body).toContain(money(r.model.total));
      expect(body).toContain(money(r.model.paid));
      for (const l of r.model.lines) expect(body).toContain(money(l.total));
    }
    if (r.model.balanceDue > 0) expect(r.text).toContain(money(r.model.balanceDue));
  });
});
