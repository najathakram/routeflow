// The web receipt builders import the product-name helper through the web app's `@/` alias, which this package's Jest does not
// map; it is only reached for a catalogue product, and the fixture's lines are ad-hoc, so a virtual stand-in is enough.
jest.mock(
  "@/lib/product-display",
  () => ({ displayProductName: (p: { name: string }) => p.name }),
  {
    virtual: true,
  },
);

import { roundMoney } from "@routeflow/pricing";
import type { ReceiptModel } from "@routeflow/types";
import {
  adjustmentLabel,
  buildCounterReceipt,
  receiptModelFromOrder,
} from "../../../web/lib/counter-receipt";
import { buildCounterSaleResponse } from "../orders/counter-sale/counter-sale-readback";
import { toTodaysSaleRow, type TodayOrderRecord } from "../orders/counter-sale/counter-sale-today";
import { buildReceiptModel, type ReceiptOrderInput } from "./receipt-model";
import { BRANDING, orderFixture } from "./receipt.fixtures";

/**
 * SA-762r / SA-751r (G1, G4): ONE receipt money model, ONE home for each figure. The same stored sale is read three ways, each
 * through the REAL helper that surface uses in production:
 *   - the live counter receipt: `buildCounterSaleResponse` (the POST / by-key read-back) -> `buildCounterReceipt`;
 *   - the Today's-sales reprint: `toTodaysSaleRow` (the row) -> `receiptModelFromOrder`;
 *   - the emailed receipt: `buildReceiptModel`.
 * Nothing is hard-coded between the rows and the models: the rate, the change and the tax come from the stored rows, so a
 * second computation anywhere shows up here as a row that differs. Placeholders only (acme).
 */
const ZONE = "America/New_York";

const MONEY_ROWS = [
  "subtotal",
  "discounts",
  "tax",
  "adjustments",
  "taxRatePercent",
  "total",
  "paid",
  "balanceDue",
  "tendered",
  "change",
] as const satisfies ReadonlyArray<keyof ReceiptModel>;
const moneyRows = (m: ReceiptModel) => Object.fromEntries(MONEY_ROWS.map((k) => [k, m[k]]));

interface Pay {
  method: string;
  amount: string;
}
interface Scenario {
  total: string;
  tax: string;
  /** the stored `InvoiceItem.taxRate` of each line (a fraction); the invoice header carries the same tax */
  rates?: string[];
  invoiceSubtotal?: string;
  payments?: Pay[];
  tendered?: string | null;
  /** what the clerk typed at the till (the live screen's `enteredTender`); every other surface never sees it */
  entered?: number | null;
  /** the order's lines, and the same lines as the live cart rang them (cart prices are NET; the default carries a $1.00 discount) */
  lines?: ReceiptOrderInput["lineItems"];
  live?: Parameters<typeof buildCounterReceipt>[0]["lines"];
}

const DEFAULT_PAYMENTS: Pay[] = [
  { method: "CASH", amount: "20.00" },
  { method: "CREDIT_CARD", amount: "8.62" },
];
const DEFAULT_LIVE: NonNullable<Scenario["live"]> = [
  { tempId: "li-1", name: "Cola", unitPrice: 2.5, qty: 3 },
  { tempId: "li-2", name: "Chips", unitPrice: 12, qty: 15, unitsPerBox: 12, boxes: 1, pieces: 3 },
  { tempId: "li-3", name: "Loose candy", unitPrice: 4, qty: 1, tierPrice: 5, override: {} },
];

function build(s: Scenario) {
  const base = orderFixture({
    total: s.total,
    tax: s.tax,
    counterCashTendered: s.tendered ?? null,
  });
  const order = s.lines ? { ...base, lineItems: s.lines } : base;
  const rates = s.rates ?? ["0.0800", "0.0800", "0.0800"];
  const payments = (s.payments ?? DEFAULT_PAYMENTS).map((p, i) => ({
    id: `pay-${i + 1}`,
    method: p.method,
    amount: p.amount,
    status: "PAID",
  }));
  const invoice = {
    id: "inv-1",
    invoiceNumber: "INV-2001",
    status: "PAID",
    total: s.total,
    subtotal: s.invoiceSubtotal ?? "26.50",
    taxAmount: s.tax,
    items: rates.map((taxRate) => ({ taxRate, categoryTaxAmount: "0.00" })),
    payments,
  };

  // the emailed receipt
  const emailModel = buildReceiptModel(
    order,
    [invoice],
    payments.map((p) => ({ ...p, invoiceId: "inv-1" })),
    BRANDING,
    ZONE,
  );

  // the Today's-sales row, then the reprint built from the row exactly as CounterTodaysSales hands it over
  const record = {
    id: "ord-1",
    orderNumber: "ORD-1001",
    status: "DELIVERED",
    total: s.total,
    createdAt: order.createdAt,
    customerId: "c1",
    counterCashTendered: s.tendered ?? null,
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    invoices: [invoice],
    returns: [],
  } as unknown as TodayOrderRecord;
  const row = toTodaysSaleRow(record);
  const reprint = receiptModelFromOrder({
    order: {
      orderNumber: "ORD-1001",
      total: Number(s.total),
      tax: Number(s.tax),
      lineItems: order.lineItems.map((l) => ({
        id: l.id,
        name: l.name,
        product: l.product,
        qty: Number(l.qty),
        unitPrice: Number(l.unitPrice),
        unitsPerBox: l.unitsPerBox,
        boxes: l.boxes,
        pieces: l.pieces,
        status: l.status,
      })),
    },
    sale: {
      invoiceId: row.invoiceId as string,
      invoiceNumber: row.invoiceNumber as string,
      paid: row.paid,
      balanceDue: row.balanceDue,
      methods: row.methods,
      createdAt: row.createdAt,
      cashTendered: row.cashTendered,
      change: row.change,
      customerName: row.isWalkIn ? null : row.customerName,
      taxRatePercent: row.taxRatePercent,
      timezone: ZONE,
    },
    profile: { businessName: BRANDING.businessName },
  });

  // the live receipt, from the POST / by-key response
  const response = buildCounterSaleResponse({
    order: {
      id: "ord-1",
      orderNumber: "ORD-1001",
      counterCashTendered: s.tendered ?? null,
      tax: s.tax,
    },
    invoices: [invoice],
    replayed: false,
  } as unknown as Parameters<typeof buildCounterSaleResponse>[0]);
  const live = buildCounterReceipt({
    receipt: response,
    lines: s.live ?? DEFAULT_LIVE,
    enteredTender: s.entered ?? null,
    profile: { businessName: BRANDING.businessName, timezone: ZONE },
    now: order.createdAt,
  });
  return { emailModel, reprint, live, row, response };
}

describe("print / reprint / email carry one money model (SA-762r)", () => {
  const { emailModel, reprint, live } = build({ total: "28.62", tax: "2.12" });

  it("the email's money rows are the reprint's, row for row", () => {
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
    expect(emailModel.tax).toBe(2.12);
    expect(emailModel.adjustments).toBe(0);
    expect(emailModel.taxRatePercent).toBe(8);
  });

  it("the email's lines are the reprint's lines (name, detail, total)", () => {
    const pick = (m: ReceiptModel) => m.lines.map((l) => [l.name, l.detail, l.total]);
    expect(pick(emailModel)).toEqual(pick(reprint));
  });

  it("the live receipt's Subtotal is at system prices: net lines + the $1.00 discount (Subtotal - Discounts = the email's Subtotal)", () => {
    expect(live.discounts).toBe(1);
    expect(roundMoney(live.subtotal - live.discounts)).toBe(emailModel.subtotal);
  });

  it("every model adds up: Subtotal - Discounts + Tax + Adjustments = Total", () => {
    for (const m of [emailModel, reprint, live])
      expect(roundMoney(m.subtotal - m.discounts + m.tax + m.adjustments)).toBe(m.total);
  });

  it("a stored tax that no single rate reproduces: the email and the reprint name no rate and print plain Tax", () => {
    const odd = build({ total: "29.00", tax: "2.50" });
    expect(moneyRows(odd.emailModel)).toEqual(moneyRows(odd.reprint));
    expect(odd.emailModel.taxRatePercent).toBeNull();
    expect(odd.emailModel.tax).toBe(2.5);
    expect(adjustmentLabel(odd.emailModel.taxRatePercent)).toBe("Tax");
  });
});

describe("a legacy invoice whose lines all store a 0 rate: one rate on every surface (one home: pricing)", () => {
  // an order-derived invoice stored before #725: every line rate 0, the header carries the real tax
  const legacy = build({ total: "28.62", tax: "2.12", rates: ["0", "0", "0"] });

  it("the Today's row names the flat rate its header tax implies, like the email", () => {
    expect(legacy.row.taxRatePercent).toBe(8);
    expect(legacy.emailModel.taxRatePercent).toBe(8);
  });

  it("email and reprint agree on the money rows and the Tax label", () => {
    expect(moneyRows(legacy.emailModel)).toEqual(moneyRows(legacy.reprint));
    expect(adjustmentLabel(legacy.reprint.taxRatePercent)).toBe("Tax (8%)");
    expect(adjustmentLabel(legacy.emailModel.taxRatePercent)).toBe("Tax (8%)");
  });
});

describe("cash handed over: ONE change figure (the server's servedChange) on every surface", () => {
  const net = [
    {
      id: "li-1",
      name: "Water case",
      status: "DELIVERED",
      qty: "1",
      unitPrice: "34.49",
      unitsPerBox: null,
      boxes: null,
      pieces: null,
      product: null,
    },
  ];
  const liveNet = [{ tempId: "li-1", name: "Water case", unitPrice: 34.49, qty: 1 }];
  const cash = (extra: Partial<Scenario> = {}) =>
    build({
      total: "37.25",
      tax: "2.76",
      invoiceSubtotal: "34.49",
      rates: ["0.0800"],
      lines: net,
      live: liveNet,
      payments: [{ method: "CASH", amount: "37.25" }],
      tendered: "50.00",
      ...extra,
    });

  it("CASH 50 on 37.25: change 12.75 on the row, the response, the reprint, the email and the live receipt", () => {
    const s = cash();
    expect(s.row.change).toBe(12.75);
    expect(s.response.change).toBe(12.75);
    for (const m of [s.reprint, s.emailModel, s.live]) {
      expect(m.tendered).toBe(50);
      expect(m.change).toBe(12.75);
    }
    expect(moneyRows(s.emailModel)).toEqual(moneyRows(s.reprint));
  });

  it("a card-first sale (cash only for part of it, tendered stored): no change on any surface", () => {
    const s = cash({
      payments: [
        { method: "CREDIT_CARD", amount: "20.00" },
        { method: "CASH", amount: "17.25" },
      ],
    });
    expect(s.row.change).toBeNull();
    expect(s.response.change).toBeUndefined();
    for (const m of [s.reprint, s.emailModel, s.live]) expect(m.change).toBeNull();
    expect(moneyRows(s.emailModel)).toEqual(moneyRows(s.reprint));
  });

  it("an ENTERED tender never invents a Change the server did not serve: a card-first sale the clerk typed 50 on has no Change row", () => {
    const s = cash({
      entered: 50,
      payments: [
        { method: "CREDIT_CARD", amount: "20.00" },
        { method: "CASH", amount: "17.25" },
      ],
    });
    expect(s.response.cashTendered).toBe(50); // stored, and the server serves no change for it
    expect(s.response.change).toBeUndefined();
    expect(s.live.change).toBeNull();
    expect(s.live.changeAsEntered).toBe(false);
    expect(s.reprint.change).toBeNull();
    expect(s.emailModel.change).toBeNull();
  });

  it("an entered tender on a partly paid sale shows no Change row either", () => {
    const s = cash({ entered: 50, payments: [{ method: "CASH", amount: "20.00" }] });
    expect(s.response.balanceDue).toBeGreaterThan(0);
    expect(s.live.change).toBeNull();
  });

  it("the as-entered fallback survives only for a paid sale the server stored no tender for (a legacy or recovered cash sale)", () => {
    const s = cash({ entered: 50, tendered: null });
    expect(s.response.cashTendered).toBeUndefined();
    expect(s.response.change).toBeUndefined();
    expect(s.live.tendered).toBe(50);
    expect(s.live.change).toBe(12.75);
    expect(s.live.changeAsEntered).toBe(true);
  });

  it("a partly paid cash sale serves no change anywhere", () => {
    const s = cash({ payments: [{ method: "CASH", amount: "20.00" }] });
    expect(s.row.change).toBeNull();
    for (const m of [s.reprint, s.emailModel]) expect(m.change).toBeNull();
  });

  it("payments are read in the order they were taken: the first stored tender decides (cash first, card second)", () => {
    const s = cash({
      payments: [
        { method: "CASH", amount: "17.25" },
        { method: "CREDIT_CARD", amount: "20.00" },
      ],
    });
    expect(s.row.change).toBe(32.75);
    expect(s.emailModel.change).toBe(32.75);
    expect(s.reprint.change).toBe(32.75);
  });
});

describe("the live counter receipt splits Tax and Adjustments like the reprint and the email (row by row)", () => {
  it("a clean taxed sale: every Tax / Adjustments / rate / total row equals the email's", () => {
    const s = build({ total: "28.62", tax: "2.12" });
    expect(s.response.tax).toBe(2.12);
    expect(s.response.taxRatePercent).toBe(8);
    for (const k of [
      "tax",
      "adjustments",
      "taxRatePercent",
      "total",
      "paid",
      "balanceDue",
    ] as const)
      expect(s.live[k]).toBe(s.emailModel[k]);
  });

  it("a sale with something left after tax: the live receipt prints Tax AND Adjustments, not the whole remainder as Adjustments", () => {
    const s = build({ total: "29.62", tax: "2.12" });
    expect(moneyRows(s.emailModel)).toEqual(moneyRows(s.reprint));
    expect(s.emailModel).toMatchObject({ tax: 2.12, adjustments: 1, taxRatePercent: 8 });
    expect(s.live).toMatchObject({ tax: 2.12, adjustments: 1, taxRatePercent: 8 });
    for (const k of ["tax", "adjustments", "taxRatePercent", "total"] as const)
      expect(s.live[k]).toBe(s.emailModel[k]);
  });

  it("a stored tax that no single rate reproduces: the live receipt prints plain Tax too", () => {
    const s = build({ total: "29.00", tax: "2.50" });
    expect(s.live).toMatchObject({ tax: 2.5, adjustments: 0, taxRatePercent: null });
    expect(adjustmentLabel(s.live.taxRatePercent)).toBe("Tax");
  });

  it("a legacy all-zero-lines sale: the live receipt names the same rate", () => {
    const s = build({ total: "28.62", tax: "2.12", rates: ["0", "0", "0"] });
    expect(s.live.taxRatePercent).toBe(8);
    expect(s.live.tax).toBe(2.12);
  });

  it("the settings tax rate is not a money source: a response with no tax figure prints no Tax row", () => {
    const s = build({ total: "28.62", tax: "2.12" });
    const bare = buildCounterReceipt({
      receipt: { ...s.response, tax: undefined, taxRatePercent: undefined },
      lines: DEFAULT_LIVE,
      enteredTender: null,
      profile: { businessName: BRANDING.businessName, taxRate: 8, timezone: ZONE },
      now: new Date(),
    });
    expect(bare.tax).toBe(0);
    expect(bare.taxRatePercent).toBeNull();
    expect(bare.adjustments).toBe(2.12);
  });
});
