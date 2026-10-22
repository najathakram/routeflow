import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import {
  buildCounterReceipt,
  receiptModelFromOrder,
  type ReceiptBusinessProfile,
} from "@/lib/counter-receipt";
import { CounterReceiptView } from "./CounterReceiptView";

/**
 * SA-762r (Web-1 #9): what the customer reads. Live and reprint render through the SAME view; the customer name, the
 * Tax / Adjustments split and the footer are checked on the paper, and the footer can only ever be text.
 */
const live = (
  over: {
    customerName?: string | null;
    total?: number;
    profile?: ReceiptBusinessProfile;
    tax?: number;
    taxRatePercent?: number | null;
  } = {},
) =>
  buildCounterReceipt({
    receipt: {
      // the server-owned tax figure and stored rate (SA-762r); the default sale is $40.00 + 8.25% tax
      tax: over.tax ?? 3.3,
      taxRatePercent: over.taxRatePercent === undefined ? 8.25 : over.taxRatePercent,
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: over.total ?? 43.3,
      paid: over.total ?? 43.3,
      balanceDue: 0,
      method: "CARD",
      paymentRecorded: true,
    },
    lines: [{ tempId: "a", name: "Cola", unitPrice: 10, qty: 4 }],
    enteredTender: null,
    profile: over.profile ?? { taxRate: 8.25 },
    customerName: over.customerName,
    now: new Date("2026-10-07T15:15:00.000Z"),
  });

const reprint = (
  over: {
    customerName?: string | null;
    total?: number;
    tax?: number;
    profile?: ReceiptBusinessProfile;
  } = {},
) =>
  receiptModelFromOrder({
    order: {
      orderNumber: "ORD-1",
      total: over.total ?? 43.3,
      tax: over.tax ?? 3.3,
      lineItems: [{ id: "l1", name: "Cola", qty: 4, unitPrice: 10 }],
    },
    sale: {
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      paid: over.total ?? 43.3,
      balanceDue: 0,
      methods: [{ method: "CASH", amount: over.total ?? 43.3 }],
      createdAt: "2026-10-07T15:15:00.000Z",
      customerName: over.customerName,
    },
    profile: over.profile ?? null,
  });

const show = (model: ReturnType<typeof live>, props: { reprintLabel?: string } = {}) =>
  render(<CounterReceiptView model={model} {...props} />);

describe("customer name", () => {
  it("a named customer prints on the live receipt and the reprint; a walk-in prints none", () => {
    const a = show(live({ customerName: "Acme Co" }));
    expect(screen.getByTestId("receipt-customer")).toHaveTextContent("Customer: Acme Co");
    a.unmount();
    const b = show(reprint({ customerName: "Acme Co" }), { reprintLabel: "Reprint" });
    expect(screen.getByTestId("receipt-customer")).toHaveTextContent("Customer: Acme Co");
    b.unmount();
    show(live());
    expect(screen.queryByTestId("receipt-customer")).toBeNull();
  });

  it("a walk-in reprint prints none", () => {
    show(reprint({ customerName: null }), { reprintLabel: "Reprint" });
    expect(screen.queryByTestId("receipt-customer")).toBeNull();
  });
});

describe("tax and adjustments", () => {
  it("the live receipt prints Tax (8.25%) from the server's tax and rate, and no Adjustments row", () => {
    show(live());
    expect(screen.getByTestId("receipt-tax")).toHaveTextContent("Tax (8.25%)");
    expect(screen.getByTestId("receipt-tax")).toHaveTextContent("$3.30");
    expect(screen.queryByTestId("receipt-adjustment")).toBeNull();
  });

  it("the reprint prints Tax with no percent, and no Tendered / Change without a stored tender", () => {
    show(reprint(), { reprintLabel: "Reprint" });
    const tax = screen.getByTestId("receipt-tax");
    expect(tax).toHaveTextContent("Tax");
    expect(tax).toHaveTextContent("$3.30");
    expect(tax.textContent).not.toMatch(/%/);
    expect(screen.queryByTestId("receipt-tendered")).toBeNull();
    expect(screen.queryByTestId("receipt-change")).toBeNull();
    expect(screen.queryByTestId("receipt-adjustment")).toBeNull();
  });

  it("Adjustments prints only when non-zero, as its own row beside Tax", () => {
    show(reprint({ total: 44.3 }), { reprintLabel: "Reprint" });
    expect(screen.getByTestId("receipt-tax")).toHaveTextContent("$3.30");
    expect(screen.getByTestId("receipt-adjustment")).toHaveTextContent("Adjustments");
    expect(screen.getByTestId("receipt-adjustment")).toHaveTextContent("$1.00");
  });

  it("a sale with no tax prints no Tax row at all", () => {
    show(reprint({ total: 40, tax: 0 }), { reprintLabel: "Reprint" });
    expect(screen.queryByTestId("receipt-tax")).toBeNull();
    expect(screen.queryByTestId("receipt-adjustment")).toBeNull();
  });
});

describe("footer", () => {
  it("prints the settings footer, line breaks kept, on the live receipt and the reprint", () => {
    const profile = { taxRate: 8.25, receiptFooter: "Thanks for shopping!\nNo returns on tobacco" };
    show(live({ profile }));
    const f = screen.getByTestId("receipt-footer");
    expect(f).toHaveTextContent("Thanks for shopping!");
    expect(f.textContent).toBe("Thanks for shopping!\nNo returns on tobacco");
    expect(f.className).toContain("whitespace-pre-line");
  });

  it("prints no footer element when none is set", () => {
    show(live());
    expect(screen.queryByTestId("receipt-footer")).toBeNull();
  });

  it("markup in the footer is shown as text, never parsed", () => {
    const evil = '<img src=x onerror="alert(1)"><b>hi</b>';
    const { container } = show(live({ profile: { receiptFooter: evil } }));
    expect(screen.getByTestId("receipt-footer").textContent).toBe(evil);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("counter receipt files never inject markup (SA-762r F6)", () => {
  const FILES = [
    path.join(__dirname, "CounterReceiptView.tsx"),
    path.join(__dirname, "CounterReceiptBody.tsx"),
    path.join(__dirname, "../../../../lib/counter-receipt.ts"),
  ];
  it.each(FILES)("%s has no dangerouslySetInnerHTML or innerHTML", (file) => {
    const src = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

describe("reprint after a return (SA-838a): the paper", () => {
  type Sale = Parameters<typeof receiptModelFromOrder>[0]["sale"];
  /** the money rows below Total, as the paper reads them, top to bottom: "Label value" per line */
  const paper = (over: Partial<Sale>) => {
    const model = receiptModelFromOrder({
      order: {
        orderNumber: "ORD-1",
        total: 12.5,
        tax: 0,
        lineItems: [{ id: "l1", name: "Cola", qty: 5, unitPrice: 2.5 }],
      },
      sale: {
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        paid: 12.5,
        balanceDue: 0,
        methods: [],
        createdAt: "2026-10-07T15:15:00.000Z",
        ...over,
      },
      profile: null,
    });
    const { container } = render(<CounterReceiptView model={model} />);
    const rows = Array.from(container.querySelectorAll("dl > div")).map((r) =>
      Array.from(r.children)
        .map((c) => c.textContent)
        .join(" "),
    );
    return rows.slice(rows.findIndex((r) => r.startsWith("Total")) + 1);
  };
  const none = { applied: 0, refunded: 0, kept: 0, pending: false };
  /** Total $12.50, Cash $5.00 */
  const cash5 = {
    paid: 5,
    balanceDue: 7.5,
    methods: [{ method: "CASH" as const, amount: 5 }],
    tenderPaid: 5,
    tenderMethods: [{ method: "CASH" as const, amount: 5 }],
  };

  it("(1a) refund done: Payment method Cash $5.00, Paid $5.00, Refunded $2.50 (returned items), Balance due $7.50", () => {
    expect(paper({ ...cash5, returnLines: { ...none, refunded: 2.5 } })).toEqual([
      "Payment method Cash $5.00",
      "Paid $5.00",
      "Refunded $2.50 (returned items)",
      "Balance due $7.50",
    ]);
  });

  it("(1b) credit kept: Payment method Cash $5.00, Paid $5.00, Credit kept $2.50 (returned items), Balance due $7.50", () => {
    expect(paper({ ...cash5, returnLines: { ...none, kept: 2.5 } })).toEqual([
      "Payment method Cash $5.00",
      "Paid $5.00",
      "Credit kept $2.50 (returned items)",
      "Balance due $7.50",
    ]);
  });

  it("(1c) credit applied: Payment method Cash $5.00, Paid $5.00, Returned −$2.50, Balance due $5.00", () => {
    expect(
      paper({
        ...cash5,
        paid: 7.5,
        balanceDue: 5,
        methods: [
          { method: "CASH", amount: 5 },
          { method: "STORE_CREDIT", amount: 2.5 },
        ],
        returnLines: { ...none, applied: 2.5 },
      }),
    ).toEqual(["Payment method Cash $5.00", "Paid $5.00", "Returned −$2.50", "Balance due $5.00"]);
  });

  it("(2) pending: Payment method Cash $5.00, Paid $5.00, Balance due $7.50, Return in progress", () => {
    expect(paper({ ...cash5, returnLines: { ...none, pending: true } })).toEqual([
      "Payment method Cash $5.00",
      "Paid $5.00",
      "Balance due $7.50",
      "Return in progress",
    ]);
  });

  it("(a) prints Payment method Cash $6.25, Paid $6.25, Returned −$6.25 (no Store credit, no Balance due)", () => {
    expect(
      paper({
        methods: [
          { method: "CASH", amount: 6.25 },
          { method: "STORE_CREDIT", amount: 6.25 },
        ],
        tenderPaid: 6.25,
        tenderMethods: [{ method: "CASH", amount: 6.25 }],
        returnLines: { ...none, applied: 6.25 },
      }),
    ).toEqual(["Payment method Cash $6.25", "Paid $6.25", "Returned −$6.25"]);
  });

  it("(b) prints Payment method Advance $5.00 + Cash $7.50, Paid $12.50, Refunded $2.50 (returned items)", () => {
    expect(
      paper({
        methods: [
          { method: "ADVANCE", amount: 5 },
          { method: "CASH", amount: 7.5 },
        ],
        tenderPaid: 12.5,
        tenderMethods: [
          { method: "ADVANCE", amount: 5 },
          { method: "CASH", amount: 7.5 },
        ],
        returnLines: { ...none, refunded: 2.5 },
      }),
    ).toEqual([
      "Payment method Advance $5.00 + Cash $7.50",
      "Paid $12.50",
      "Refunded $2.50 (returned items)",
    ]);
  });

  it("(c) prints Payment method Advance $12.50, Paid $12.50, Credit kept $3.00 (returned items)", () => {
    expect(
      paper({
        methods: [{ method: "ADVANCE", amount: 12.5 }],
        tenderPaid: 12.5,
        tenderMethods: [{ method: "ADVANCE", amount: 12.5 }],
        returnLines: { ...none, kept: 3 },
      }),
    ).toEqual([
      "Payment method Advance $12.50",
      "Paid $12.50",
      "Credit kept $3.00 (returned items)",
    ]);
  });

  it("(d) another order's store credit prints as the tender Store credit", () => {
    expect(
      paper({
        methods: [{ method: "STORE_CREDIT", amount: 12.5 }],
        tenderPaid: 12.5,
        tenderMethods: [{ method: "STORE_CREDIT", amount: 12.5 }],
        returnLines: none,
      }),
    ).toEqual(["Payment method Store credit $12.50", "Paid $12.50"]);
  });

  it("the carrier order B of sale A's INLINE return prints NO return line, and Paid adds up", () => {
    expect(
      paper({
        methods: [
          { method: "CASH", amount: 7 },
          { method: "STORE_CREDIT", amount: 5.5 },
        ],
        tenderPaid: 12.5,
        tenderMethods: [
          { method: "CASH", amount: 7 },
          { method: "STORE_CREDIT", amount: 5.5 },
        ],
        returnLines: none,
      }),
    ).toEqual(["Payment method Cash $7.00 + Store credit $5.50", "Paid $12.50"]);
  });

  it("sale A, whose own INLINE return was carried on B and applied, prints its own Returned line", () => {
    expect(
      paper({
        methods: [
          { method: "CASH", amount: 7 },
          { method: "STORE_CREDIT", amount: 5.5 },
        ],
        tenderPaid: 7,
        tenderMethods: [{ method: "CASH", amount: 7 }],
        returnLines: { ...none, applied: 5.5 },
      }),
    ).toEqual(["Payment method Cash $7.00", "Paid $7.00", "Returned −$5.50"]);
  });

  it("an on-account sale with only its own return credit prints Returned −$6.25 and Balance due $6.25", () => {
    expect(
      paper({
        paid: 6.25,
        balanceDue: 6.25,
        methods: [{ method: "STORE_CREDIT", amount: 6.25 }],
        tenderPaid: 0,
        tenderMethods: [],
        returnLines: { ...none, applied: 6.25 },
      }),
    ).toEqual(["Returned −$6.25", "Balance due $6.25"]);
  });

  it("two own returns: applied and refunded and pending each print once, in the pinned order", () => {
    expect(
      paper({
        ...cash5,
        paid: 7.5,
        balanceDue: 5,
        methods: [
          { method: "CASH", amount: 5 },
          { method: "STORE_CREDIT", amount: 2.5 },
        ],
        returnLines: { applied: 2.5, refunded: 1, kept: 0.5, pending: true },
      }),
    ).toEqual([
      "Payment method Cash $5.00",
      "Paid $5.00",
      "Returned −$2.50",
      "Refunded $1.00 (returned items)",
      "Credit kept $0.50 (returned items)",
      "Balance due $5.00",
      "Return in progress",
    ]);
  });

  it("the invariant on the paper: Balance due = Total - Paid - Returned for every applied fixture", () => {
    const cents = (t: string) => Math.round(Number(t.replace(/[^0-9.]/g, "")) * 100);
    const rows = paper({
      ...cash5,
      paid: 7.5,
      balanceDue: 5,
      methods: [
        { method: "CASH", amount: 5 },
        { method: "STORE_CREDIT", amount: 2.5 },
      ],
      returnLines: { ...none, applied: 2.5 },
    });
    const get = (label: string) => cents(rows.find((r) => r.startsWith(label))!);
    expect(get("Balance due")).toBe(1250 - get("Paid") - get("Returned"));
  });

  it("(g) an old server prints master's wording, byte for byte (literal text taken from master's behaviour)", () => {
    expect(
      paper({
        paid: 6.25,
        balanceDue: 6.25,
        methods: [{ method: "STORE_CREDIT", amount: 6.25 }],
      }),
    ).toEqual(["Payment method Store credit", "Paid $6.25", "Balance due $6.25"]);
    document.body.innerHTML = "";
    expect(
      paper({
        paid: 12.5,
        balanceDue: 0,
        methods: [
          { method: "CASH", amount: 5 },
          { method: "CARD", amount: 7.5 },
        ],
      }),
    ).toEqual(["Payment method Cash + Card", "Paid $12.50"]);
  });
});
