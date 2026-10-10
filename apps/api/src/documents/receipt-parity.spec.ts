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
  /** the order's lines, and the same lines as the live cart rang them (cart prices are NET; the default carries a $1.00 discount) */
  lines?: ReceiptOrderInput["lineItems"];
  live?: Parameters<typeof buildCounterReceipt>[0]["lines"];
}

const DEFAULT_PAYMENTS: Pay[] = [
  { method: "CASH", amount: "20.00" },
  { method: "CREDIT_CARD", amount: "8.62" },
];
const DEFAULT_LIVE: Scenario["live"] = [
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
    enteredTender: null,
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
