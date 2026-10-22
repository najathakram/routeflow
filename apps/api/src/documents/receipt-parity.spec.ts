import { readFileSync } from "fs";
import { join } from "path";
import { formatReceiptMoney, roundMoney } from "@routeflow/pricing";
import type { ReceiptModel } from "@routeflow/types";
import {
  adjustmentLabel,
  buildCounterReceipt,
  receiptModelFromOrder,
} from "../../../web/lib/counter-receipt";
import { buildCounterSaleResponse } from "../orders/counter-sale/counter-sale-readback";
import {
  toTodaysSaleRow,
  type ReturnProvenance,
  type TodayOrderRecord,
} from "../orders/counter-sale/counter-sale-today";
import { type ReceiptOrderInput, type ReceiptReturnData } from "./receipt-model";
import { BRANDING, orderFixture } from "./receipt.fixtures";
import { renderOrderReceipt } from "./render-order-receipt";

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
  /** a credit-note application: the note it applied (issued against this sale's invoice) */
  creditNoteId?: string;
  /** the invoice that note was issued against; default this sale's own (`inv-1`) */
  noteInvoice?: string;
}
interface Scenario {
  total: string;
  tax: string;
  /** the stored `InvoiceItem.taxRate` of each line (a fraction); the invoice header carries the same tax */
  rates?: string[];
  /** the tenant's configured rate in percent (`settings.taxRate`); default 8, what the fixture lines carry */
  configured?: number | null;
  invoiceSubtotal?: string;
  /** the tenant's `invoice.hideOriginalPrice` */
  hide?: boolean;
  payments?: Pay[];
  /** the sale's own returns, as the Today's-sales page query reads them (SA-838a) */
  returns?: TodayOrderRecord["returns"];
  /** the batched credit-note read's answer: note id -> status and PAID amount applied on any sale */
  notes?: Record<
    string,
    {
      status: string;
      appliedAnywhere: number;
      applications?: ReadonlyArray<{ amount: unknown; invoiceId: string | null }>;
    }
  >;
  /** INLINE returns filed on OTHER orders, found by the batched read behind the payments' credit notes (SA-838 e) */
  carried?: ReturnProvenance[];
  /** false = a delivery order (default: a counter sale) */
  counterSale?: boolean;
  /** true = the reprint of an OLDER server: the row's tender split and return lines are not served (SA-838 g) */
  oldServer?: boolean;
  tendered?: string | null;
  /** the stored cashier (`Order.soldBy.username`); omitted = a sale rung before soldById was stamped */
  cashier?: string;
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
  // the cart carries its own TIER price (5, here the list); the receipt never strikes it, only the stored list
  { tempId: "li-3", name: "Loose candy", unitPrice: 4, qty: 1, tierPrice: 5, override: {} },
];

function build(s: Scenario) {
  const base = orderFixture({
    total: s.total,
    tax: s.tax,
    counterCashTendered: s.tendered ?? null,
    counterSale: s.counterSale ?? true,
  });
  const order = {
    ...(s.lines ? { ...base, lineItems: s.lines } : base),
    ...(s.cashier ? { soldBy: { username: s.cashier } } : {}),
  };
  const configured = s.configured === undefined ? 8 : s.configured;
  const rates = s.rates ?? ["0.0800", "0.0800", "0.0800"];
  const payments = (s.payments ?? DEFAULT_PAYMENTS).map((p, i) => ({
    id: `pay-${i + 1}`,
    method: p.method,
    amount: p.amount,
    status: "PAID",
    ...(p.creditNoteId
      ? { creditNoteId: p.creditNoteId, creditNote: { invoiceId: p.noteInvoice ?? "inv-1" } }
      : {}),
  }));
  const invoice = {
    id: "inv-1",
    invoiceNumber: "INV-2001",
    status: "PAID",
    total: s.total,
    // the stored invoice lines: the rate, and the price facts the sale was rung at (InvoiceItem copies the order line's)
    items: order.lineItems
      .filter((l) => l.status !== "CANCELLED")
      .map((l, i) => ({
        taxRate: rates[Math.min(i, rates.length - 1)],
        productId: `p-${l.id}`,
        unitPrice: l.unitPrice,
        originalPrice: l.originalPrice ?? null,
        priceType: l.priceType ?? "STANDARD",
      })),
    payments,
  };

  // the emailed receipt: rendered end to end (the model AND the text/html the customer reads), from the SAME stored rows and the
  // SAME batched reads the Today's-sales row gets (the receipt service reads them once)
  const creditNotes = new Map(Object.entries(s.notes ?? {}));
  const returnData: ReceiptReturnData = {
    returns: s.returns ?? [],
    carriedReturns: s.carried ?? [],
    creditNotes,
  };
  const emailArgs = {
    order,
    invoices: [invoice],
    payments: payments.map((p) => ({ ...p, invoiceId: "inv-1" })),
    branding: { ...BRANDING, configuredTaxPercent: configured, hideOriginalPrice: !!s.hide },
  };
  const rendered = renderOrderReceipt(
    emailArgs.order,
    emailArgs.invoices,
    emailArgs.payments,
    emailArgs.branding,
    ZONE,
    returnData,
  );
  const emailModel = rendered.model;

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
    ...(s.cashier ? { soldBy: { username: s.cashier } } : {}),
    invoices: [invoice],
    returns: s.returns ?? [],
  } as unknown as TodayOrderRecord;
  const row = toTodaysSaleRow(record, configured, s.carried ?? [], creditNotes);
  const reprint = receiptModelFromOrder({
    cashier: row.cashierName,
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
        originalPrice: l.originalPrice == null ? null : Number(l.originalPrice),
        priceType: l.priceType,
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
      // as CounterTodaysSales hands the row over: the server's tender split and return lines (SA-838a)
      ...(s.oldServer
        ? {}
        : {
            tenderPaid: row.tenderPaid,
            tenderMethods: row.tenderMethods,
            returnLines: row.returnLines,
          }),
      createdAt: row.createdAt,
      cashTendered: row.cashTendered,
      change: row.change,
      customerName: row.isWalkIn ? null : row.customerName,
      taxRatePercent: row.taxRatePercent,
      timezone: ZONE,
    },
    profile: { businessName: BRANDING.businessName, hideOriginalPrice: !!s.hide },
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
    configuredTaxPercent: configured,
  } as unknown as Parameters<typeof buildCounterSaleResponse>[0]);
  const live = buildCounterReceipt({
    receipt: response,
    // the cart's lines carry their product id (the receipt matches them to the stored lines the response serves)
    lines: (s.live ?? DEFAULT_LIVE).map((l) => ({ productId: `p-${l.tempId}`, ...l })),
    enteredTender: s.entered ?? null,
    profile: { businessName: BRANDING.businessName, timezone: ZONE, hideOriginalPrice: !!s.hide },
    now: order.createdAt,
  });
  return { emailModel, reprint, live, row, response, rendered, emailArgs };
}

describe("print / reprint / email carry one money model (SA-762r)", () => {
  const { emailModel, reprint, live } = build({ total: "28.62", tax: "2.12" });

  it("the email's money rows are the reprint's, row for row", () => {
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
    expect(emailModel.tax).toBe(2.12);
    expect(emailModel.adjustments).toBe(0);
    expect(emailModel.taxRatePercent).toBe(8);
  });

  it("row 317: the cashier is the stored soldBy on the email and the reprint (via the Today's row); none stored = none printed", () => {
    const s = build({ total: "28.62", tax: "2.12", cashier: "jane" });
    expect(s.row.cashierName).toBe("jane");
    expect(s.emailModel.cashier).toBe("jane");
    expect(s.reprint.cashier).toBe("jane");
    expect(emailModel.cashier).toBeNull();
    expect(reprint.cashier).toBeNull();
  });

  it("the email's lines are the reprint's lines (name, detail, total)", () => {
    const pick = (m: ReceiptModel) => m.lines.map((l) => [l.name, l.detail, l.total]);
    expect(pick(emailModel)).toEqual(pick(reprint));
  });

  it("ONE presentation of a lowered price: Subtotal at list prices, a Discounts row and the struck list price, on the live receipt, the reprint and the email", () => {
    for (const m of [live, reprint, emailModel]) {
      expect(m.subtotal).toBe(27.5);
      expect(m.discounts).toBe(1);
      const candy = m.lines.find((l) => l.name === "Loose candy");
      expect(candy).toMatchObject({ total: 4, original: 5, discount: 1 });
    }
    const money = (m: ReceiptModel) => [m.subtotal, m.discounts, m.tax, m.adjustments, m.total];
    expect(money(reprint)).toEqual(money(emailModel));
    expect(money(live)).toEqual(money(emailModel));
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

describe("B1262 / SA-838: an advance application is a tender on the email as on the print", () => {
  it("an all-advance sale: email == print, Advance, Paid, no On account", () => {
    const { emailModel, reprint } = build({
      total: "12.50",
      tax: "0.00",
      payments: [{ method: "ADVANCE", amount: "12.50" }],
    });
    expect(emailModel.methodLabel).toBe("Advance $12.50");
    expect(emailModel.showPaid).toBe(true);
    expect(emailModel.onAccount).toBe(false);
    expect(emailModel.paid).toBe(12.5);
    expect(reprint.methodLabel).toBe(emailModel.methodLabel);
    expect(reprint.showPaid).toBe(emailModel.showPaid);
    expect(reprint.onAccount).toBe(emailModel.onAccount);
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
  });

  it("advance $5 + cash $7.50: email == print, Advance then Cash, Paid $12.50", () => {
    const { emailModel, reprint } = build({
      total: "12.50",
      tax: "0.00",
      payments: [
        { method: "CASH", amount: "7.50" },
        { method: "ADVANCE", amount: "5.00" },
      ],
    });
    expect(emailModel.methodLabel).toBe("Advance $5.00 + Cash $7.50");
    expect(emailModel.paid).toBe(12.5);
    expect(emailModel.onAccount).toBe(false);
    // the SAME Payment method line on both, amounts included (SA-751r: a figure is never on one receipt and not the other)
    expect(reprint.methodLabel).toBe("Advance $5.00 + Cash $7.50");
    expect(reprint.methodLabel).toBe(emailModel.methodLabel);
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
  });

  it("two tenders, a part-tender and a whole-sale tender all print amounts, on the email and the reprint alike", () => {
    const two = build({
      total: "28.62",
      tax: "2.12",
      payments: [
        { method: "CASH", amount: "20.00" },
        { method: "CREDIT_CARD", amount: "8.62" },
      ],
    });
    expect(two.emailModel.methodLabel).toBe("Cash $20.00 + Card $8.62");
    expect(two.reprint.methodLabel).toBe(two.emailModel.methodLabel);
    const part = build({
      total: "28.62",
      tax: "2.12",
      payments: [{ method: "CASH", amount: "10.00" }],
    });
    expect(part.emailModel.methodLabel).toBe("Cash $10.00");
    expect(part.reprint.methodLabel).toBe(part.emailModel.methodLabel);
    const whole = build({
      total: "28.62",
      tax: "2.12",
      payments: [{ method: "CASH", amount: "28.62" }],
    });
    // SA-838a: every method carries its amount, a tender that is the whole sale included
    expect(whole.emailModel.methodLabel).toBe("Cash $28.62");
    expect(whole.reprint.methodLabel).toBe("Cash $28.62");
  });

  it("the email lists methods in the ONE shared order and labels (no hand-typed copy)", () => {
    const src = readFileSync(join(__dirname, "receipt-model.ts"), "utf8");
    expect(src).not.toMatch(/const METHOD_ORDER\s*=/);
    expect(src).toMatch(/TODAYS_SALE_METHOD_ORDER/);
  });
});

describe("SA-838a: a sale with its own return reads the same rows on the reprint (the email's return rows land with N1)", () => {
  type Ret = TodayOrderRecord["returns"][number];
  const ret = (over: Partial<Ret> = {}): Ret => ({
    id: "r-1",
    returnNumber: "RET-1",
    status: "REFUNDED",
    refundMethod: "CREDIT_NOTE",
    refundedAt: null,
    creditNoteId: "cn-1",
    refundAmount: null,
    creditSubtotal: "2.50",
    creditTax: "0.00",
    creditCategoryTax: "0.00",
    kind: "STANDARD",
    items: [],
    ...over,
  });
  const refunded = ret({
    status: "REFUNDED",
    refundMethod: "EXTERNAL_REFUND",
    refundedAt: new Date("2026-10-22T10:00:00Z"),
    creditNoteId: null,
  });
  const pending = ret({ status: "PENDING", refundMethod: null, creditNoteId: null });
  const sale = (payments: Pay[], returns: Ret[], notes: NonNullable<Scenario["notes"]> = {}) =>
    build({ total: "12.50", tax: "0.00", payments, returns, notes });
  const issued = { "cn-1": { status: "ISSUED", appliedAnywhere: 0 } };
  const appliedTo = (amount: number) => ({
    "cn-1": { status: "APPLIED", appliedAnywhere: amount },
  });
  /** the rows below Total that the return changes, from the shared model */
  const rows = (m: ReturnType<typeof build>["reprint"]) => ({
    method: m.methodLabel,
    paid: m.paid,
    returned: m.returned ?? null,
    refunded: m.refunded ?? null,
    creditKept: m.creditKept ?? null,
    creditUsed: m.creditUsed ?? null,
    balanceDue: m.balanceDue,
    pending: m.returnPending ?? false,
  });

  it("(1a) refund done: Cash $5.00, Paid 5.00, Refunded 2.50, Balance due 7.50; the email's money rows agree", () => {
    const { reprint, emailModel } = sale([{ method: "CASH", amount: "5.00" }], [refunded]);
    expect(rows(reprint)).toEqual({
      method: "Cash $5.00",
      paid: 5,
      returned: null,
      refunded: 2.5,
      creditKept: null,
      creditUsed: null,
      balanceDue: 7.5,
      pending: false,
    });
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
    expect(emailModel.methodLabel).toBe(reprint.methodLabel);
  });

  it("(1b) credit kept: Cash $5.00, Paid 5.00, Credit kept 2.50, Balance due 7.50; the email's money rows agree", () => {
    const { reprint, emailModel } = sale([{ method: "CASH", amount: "5.00" }], [ret()], issued);
    expect(rows(reprint)).toMatchObject({ paid: 5, creditKept: 2.5, balanceDue: 7.5 });
    expect(rows(reprint).returned).toBeNull();
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
  });

  it("(1c) credit applied: Cash $5.00, Paid 5.00, Returned 2.50, Balance due 5.00", () => {
    const { reprint } = sale(
      [
        { method: "CASH", amount: "5.00" },
        { method: "CREDIT_NOTE", amount: "2.50", creditNoteId: "cn-1" },
      ],
      [ret()],
      appliedTo(2.5),
    );
    expect(rows(reprint)).toEqual({
      method: "Cash $5.00",
      paid: 5,
      returned: 2.5,
      refunded: null,
      creditKept: null,
      creditUsed: null,
      balanceDue: 5,
      pending: false,
    });
  });

  it("(2) pending: Cash $5.00, Paid 5.00, Balance due 7.50, Return in progress; the email's money rows agree", () => {
    const { reprint, emailModel } = sale([{ method: "CASH", amount: "5.00" }], [pending]);
    expect(rows(reprint)).toEqual({
      method: "Cash $5.00",
      paid: 5,
      returned: null,
      refunded: null,
      creditKept: null,
      creditUsed: null,
      balanceDue: 7.5,
      pending: true,
    });
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
  });

  it("(a) Cash $6.25, Paid 6.25, Returned 6.25 (credit applied, balance 0)", () => {
    const { reprint } = sale(
      [
        { method: "CASH", amount: "6.25" },
        { method: "CREDIT_NOTE", amount: "6.25", creditNoteId: "cn-1" },
      ],
      [ret({ creditSubtotal: "6.25" })],
      appliedTo(6.25),
    );
    expect(rows(reprint)).toMatchObject({ method: "Cash $6.25", paid: 6.25, returned: 6.25 });
    expect(reprint.balanceDue).toBe(0);
  });

  it("(b) Advance $5.00 + Cash $7.50, Paid 12.50, Refunded 2.50; the email agrees on every money row", () => {
    const { reprint, emailModel } = sale(
      [
        { method: "ADVANCE", amount: "5.00" },
        { method: "CASH", amount: "7.50" },
      ],
      [refunded],
    );
    expect(rows(reprint)).toMatchObject({
      method: "Advance $5.00 + Cash $7.50",
      paid: 12.5,
      refunded: 2.5,
    });
    expect(emailModel.methodLabel).toBe(reprint.methodLabel);
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
  });

  it("(c) Advance $12.50, Paid 12.50, Credit kept 3.00; the email agrees on every money row", () => {
    const { reprint, emailModel } = sale(
      [{ method: "ADVANCE", amount: "12.50" }],
      [ret({ creditSubtotal: "3.00" })],
      issued,
    );
    expect(rows(reprint)).toMatchObject({
      method: "Advance $12.50",
      paid: 12.5,
      creditKept: 3,
      returned: null,
    });
    expect(emailModel.methodLabel).toBe(reprint.methodLabel);
    expect(moneyRows(emailModel)).toEqual(moneyRows(reprint));
  });

  it("(3) Cash $12.50, Paid 12.50, own credit 5.50 spent on order B: Credit used 5.50, no Balance due, no Returned", () => {
    const { reprint } = sale(
      [{ method: "CASH", amount: "12.50" }],
      [ret({ creditSubtotal: "5.50" })],
      appliedTo(5.5),
    );
    expect(rows(reprint)).toEqual({
      method: "Cash $12.50",
      paid: 12.5,
      returned: null,
      refunded: null,
      creditKept: null,
      creditUsed: 5.5,
      balanceDue: 0,
      pending: false,
    });
    expect(reprint.showBalance).toBe(false);
  });

  it("I2: a note the read did not return is not settled, a VOID note prints nothing", () => {
    const unseen = sale([{ method: "CASH", amount: "5.00" }], [ret()], {});
    expect(rows(unseen.reprint)).toMatchObject({ creditKept: null, pending: true });
    const voided = sale([{ method: "CASH", amount: "5.00" }], [ret()], {
      "cn-1": { status: "VOID", appliedAnywhere: 0 },
    });
    expect(rows(voided.reprint)).toMatchObject({
      returned: null,
      refunded: null,
      creditKept: null,
      creditUsed: null,
      pending: false,
    });
  });

  it("the invariant on every pinned sale: Balance due = Total - Paid - Returned, in cents", () => {
    const cents = (n: number) => Math.round(n * 100);
    const cases = [
      sale([{ method: "CASH", amount: "5.00" }], [refunded]),
      sale([{ method: "CASH", amount: "5.00" }], [ret()], issued),
      sale(
        [
          { method: "CASH", amount: "5.00" },
          { method: "CREDIT_NOTE", amount: "2.50", creditNoteId: "cn-1" },
        ],
        [ret()],
        appliedTo(2.5),
      ),
      sale(
        [{ method: "CASH", amount: "12.50" }],
        [ret({ creditSubtotal: "5.50" })],
        appliedTo(5.5),
      ),
      sale([{ method: "CASH", amount: "5.00" }], [pending]),
    ];
    for (const { reprint } of cases) {
      expect(cents(reprint.balanceDue)).toBe(
        cents(reprint.total) - cents(reprint.paid) - cents(reprint.returned ?? 0),
      );
    }
  });

  describe("N1 (SA-838 + SA-838a): the emailed receipt prints exactly the reprint's lines", () => {
    const money = formatReceiptMoney;
    /** the rows below Total of the REPRINT, top to bottom, as CounterReceiptView prints them ("Label value"; info lines are label only) */
    const reprintLines = (m: ReceiptModel): string[] => [
      ...(m.methodLabel ? [`Payment method ${m.methodLabel}`] : []),
      ...(m.showPaid ? [`Paid ${money(m.paid)}`] : []),
      ...(m.returned ? [`Returned −${money(m.returned)}`] : []),
      ...(m.refunded ? [`Refunded ${money(m.refunded)} (returned items)`] : []),
      ...(m.creditKept ? [`Credit kept ${money(m.creditKept)} (returned items)`] : []),
      ...(m.creditUsed ? [`Credit used ${money(m.creditUsed)} (returned items)`] : []),
      ...(m.showBalance ? [`Balance due ${money(m.balanceDue)}`] : []),
      ...(m.returnPending ? ["Return in progress"] : []),
      ...(m.tendered != null ? [`Tendered ${money(m.tendered)}`] : []),
      ...(m.change != null ? [`Change ${money(m.change)}`] : []),
    ];
    /** the rows below Total of the EMAIL's plain text ("Label: value" read as "Label value"; an info line has no value) */
    const textLines = (r: { text: string }): string[] => {
      const part = r.text
        .split("\n\n")
        .find((p) => p.split("\n").some((l) => l.startsWith("Total: ")));
      const rows = (part ?? "").split("\n");
      return rows
        .slice(rows.findIndex((l) => l.startsWith("Total: ")) + 1)
        .map((l) => l.replace(": ", " "));
    };
    /** the same rows read out of the email's HTML table (a label cell, then an optional value cell) */
    const htmlLines = (r: { html: string }): string[] => {
      const rows = [
        ...r.html.matchAll(/<tr>\s*<td[^>]*>([^<]*)<\/td>\s*(?:<td[^>]*>([^<]*)<\/td>)?\s*<\/tr>/g),
      ].map((m) => (m[2] === undefined ? m[1]! : `${m[1]} ${m[2]}`));
      return rows.slice(rows.findIndex((l) => l.startsWith("Total ")) + 1);
    };
    /** the case: both surfaces print the pinned strings, and the email's html and text agree with its model */
    const same = (b: ReturnType<typeof build>, pinned: string[]) => {
      expect(reprintLines(b.reprint)).toEqual(pinned);
      expect(textLines(b.rendered)).toEqual(pinned);
      expect(htmlLines(b.rendered)).toEqual(pinned);
      expect(reprintLines(b.emailModel)).toEqual(pinned);
      expect(b.emailModel.onAccount).toBe(b.reprint.onAccount);
    };
    const refunded2 = ret({
      status: "REFUNDED",
      refundMethod: "EXTERNAL_REFUND",
      refundedAt: new Date("2026-10-22T10:00:00Z"),
      creditNoteId: null,
    });
    const cash = (amount: string): Pay => ({ method: "CASH", amount });
    const note = (amount: string, over: Partial<Pay> = {}): Pay => ({
      method: "CREDIT_NOTE",
      amount,
      creditNoteId: "cn-1",
      ...over,
    });
    const inline = (over: Partial<ReturnProvenance> = {}): ReturnProvenance => ({
      id: "r-inline",
      creditNoteId: "cn-1",
      orderId: "ord-b",
      kind: "INLINE",
      status: "REFUNDED",
      refundMethod: "CREDIT_NOTE",
      refundedAt: null,
      items: [{ sourceOrderId: "ord-1", subtotal: "5.00", taxAmount: "0.50", categoryTax: null }],
      ...over,
    });

    it("(1a) refunded: Cash $5.00 / Paid $5.00 / Refunded $2.50 (returned items) / Balance due $7.50", () => {
      same(sale([cash("5.00")], [refunded2]), [
        "Payment method Cash $5.00",
        "Paid $5.00",
        "Refunded $2.50 (returned items)",
        "Balance due $7.50",
      ]);
    });

    it("(1b) kept: Cash $5.00 / Paid $5.00 / Credit kept $2.50 (returned items) / Balance due $7.50", () => {
      same(sale([cash("5.00")], [ret()], issued), [
        "Payment method Cash $5.00",
        "Paid $5.00",
        "Credit kept $2.50 (returned items)",
        "Balance due $7.50",
      ]);
    });

    it("(1c) applied: Cash $5.00 / Paid $5.00 / Returned −$2.50 / Balance due $5.00 (the credit is no tender)", () => {
      same(sale([cash("5.00"), note("2.50")], [ret()], appliedTo(2.5)), [
        "Payment method Cash $5.00",
        "Paid $5.00",
        "Returned −$2.50",
        "Balance due $5.00",
      ]);
    });

    it("(2) pending: Cash $5.00 / Paid $5.00 / Balance due $7.50 / Return in progress (no Returned amount)", () => {
      same(sale([cash("5.00")], [pending]), [
        "Payment method Cash $5.00",
        "Paid $5.00",
        "Balance due $7.50",
        "Return in progress",
      ]);
    });

    it("SA-838 (a) on-account $12.50, $6.25 returned, $6.25 cash: Cash $6.25 / Paid $6.25 / Returned −$6.25", () => {
      same(sale([cash("6.25"), note("6.25")], [ret({ creditSubtotal: "6.25" })], appliedTo(6.25)), [
        "Payment method Cash $6.25",
        "Paid $6.25",
        "Returned −$6.25",
      ]);
    });

    it("SA-838 (b) $5 advance + $7.50 cash, $2.50 refunded: Advance $5.00 + Cash $7.50 / Paid $12.50 / Refunded", () => {
      same(
        sale(
          [
            { method: "ADVANCE", amount: "5.00" },
            { method: "CASH", amount: "7.50" },
          ],
          [refunded2],
        ),
        [
          "Payment method Advance $5.00 + Cash $7.50",
          "Paid $12.50",
          "Refunded $2.50 (returned items)",
        ],
      );
    });

    it("SA-838 (c) paid fully from an advance, $3 kept: Advance $12.50 / Paid $12.50 / Credit kept $3.00", () => {
      same(
        sale([{ method: "ADVANCE", amount: "12.50" }], [ret({ creditSubtotal: "3.00" })], issued),
        ["Payment method Advance $12.50", "Paid $12.50", "Credit kept $3.00 (returned items)"],
      );
    });

    it("(3) the own credit ($5.50) was spent on another order: Cash $12.50 / Paid $12.50 / Credit used $5.50, no Balance due", () => {
      same(sale([cash("12.50")], [ret({ creditSubtotal: "5.50" })], appliedTo(5.5)), [
        "Payment method Cash $12.50",
        "Paid $12.50",
        "Credit used $5.50 (returned items)",
      ]);
    });

    it("(d) store credit from ANOTHER order's return stays the tender Store credit", () => {
      same(sale([note("12.50", { creditNoteId: "cn-9" })], []), [
        "Payment method Store credit $12.50",
        "Paid $12.50",
      ]);
    });

    it("(e) sale A, whose own INLINE return was carried on order B and applied: Returned −$5.50", () => {
      const b = build({
        total: "12.50",
        tax: "0.00",
        payments: [cash("7.00"), note("5.50")],
        carried: [inline()],
        notes: appliedTo(5.5),
      });
      same(b, ["Payment method Cash $7.00", "Paid $7.00", "Returned −$5.50"]);
    });

    it("(f) the payment's credit note was issued against ANOTHER invoice: it stays a tender, nothing is hidden", () => {
      const b = build({
        total: "12.50",
        tax: "0.00",
        payments: [cash("7.50"), note("5.00", { noteInvoice: "inv-other" })],
        returns: [ret({ creditSubtotal: "5.00" })],
        notes: {
          "cn-1": {
            status: "APPLIED",
            appliedAnywhere: 5,
            applications: [{ amount: "5.00", invoiceId: "inv-1" }],
          },
        },
      });
      same(b, ["Payment method Cash $7.50 + Store credit $5.00", "Paid $12.50"]);
    });

    it("the double-claim fixture: a store-credit tender whose note another order's return made prints once, no Credit used", () => {
      const b = build({
        total: "12.50",
        tax: "0.00",
        payments: [cash("7.50"), note("5.00")],
        carried: [
          {
            id: "r-other",
            creditNoteId: "cn-1",
            orderId: "ord-9",
            kind: "STANDARD",
            status: "REFUNDED",
            refundMethod: "CREDIT_NOTE",
            refundedAt: null,
            amount: "5.00",
            items: [],
          },
        ],
        notes: {
          "cn-1": {
            status: "APPLIED",
            appliedAnywhere: 5,
            applications: [{ amount: "5.00", invoiceId: "inv-1" }],
          },
        },
      });
      same(b, ["Payment method Cash $7.50 + Store credit $5.00", "Paid $12.50"]);
    });

    it("the carrier order B of A's INLINE return prints NO return line, and its store credit is a tender", () => {
      const b = build({
        total: "12.50",
        tax: "0.00",
        payments: [cash("7.00"), note("5.50")],
        returns: [
          ret({
            kind: "INLINE",
            items: [
              { sourceOrderId: "ord-a", subtotal: "5.00", taxAmount: "0.50", categoryTax: null },
            ],
          }),
        ],
        notes: {
          "cn-1": {
            status: "APPLIED",
            appliedAnywhere: 5.5,
            applications: [{ amount: "5.50", invoiceId: "inv-1" }],
          },
        },
      });
      same(b, ["Payment method Cash $7.00 + Store credit $5.50", "Paid $12.50"]);
    });

    it("an on-account sale with only its own return credit: Returned −$6.25 / Balance due $6.25, and the On account block", () => {
      const b = build({
        total: "12.50",
        tax: "0.00",
        payments: [note("6.25")],
        returns: [ret({ creditSubtotal: "6.25" })],
        notes: appliedTo(6.25),
      });
      same(b, ["Returned −$6.25", "Balance due $6.25"]);
      expect(b.emailModel.onAccount).toBe(true);
      expect(b.rendered.text).toContain("On account: $6.25 balance due on account");
    });

    it("I2: a note the read did not return prints Return in progress; a VOID note prints no return line", () => {
      same(sale([cash("5.00")], [ret()], {}), [
        "Payment method Cash $5.00",
        "Paid $5.00",
        "Balance due $7.50",
        "Return in progress",
      ]);
      same(sale([cash("5.00")], [ret()], { "cn-1": { status: "VOID", appliedAnywhere: 0 } }), [
        "Payment method Cash $5.00",
        "Paid $5.00",
        "Balance due $7.50",
      ]);
    });

    it("a sale with no return at all prints the same rows on both, including Tendered and Change", () => {
      same(build({ total: "28.62", tax: "2.12", tendered: "30.00", payments: [cash("28.62")] }), [
        "Payment method Cash $28.62",
        "Paid $28.62",
        "Tendered $30.00",
        "Change $1.38",
      ]);
    });

    it("old-server (g): the reprint of an older server keeps master's wording; the email still prints the figures it prints", () => {
      const b = build({ total: "12.50", tax: "0.00", payments: [cash("5.00")], oldServer: true });
      expect(reprintLines(b.reprint)).toEqual([
        "Payment method Cash",
        "Paid $5.00",
        "Balance due $7.50",
      ]);
      // the email is rendered by THIS server from the row it just read: it has no old-wording mode, it prints amounts
      expect(textLines(b.rendered)).toEqual([
        "Payment method Cash $5.00",
        "Paid $5.00",
        "Balance due $7.50",
      ]);
      expect(b.emailModel.paid).toBe(b.reprint.paid);
      expect(b.emailModel.balanceDue).toBe(b.reprint.balanceDue);
    });

    it("the rendered email text: (a) prints Returned −$6.25 and no Store credit tender; (3) prints Credit used and no Balance due", () => {
      const a = sale(
        [cash("6.25"), note("6.25")],
        [ret({ creditSubtotal: "6.25" })],
        appliedTo(6.25),
      );
      expect(a.rendered.text).toContain(
        "Payment method: Cash $6.25\nPaid: $6.25\nReturned: −$6.25",
      );
      expect(a.rendered.text).not.toContain("Store credit");
      expect(a.rendered.html).not.toContain("Store credit");
      expect(a.rendered.html).toContain("Returned");
      const c = sale([cash("12.50")], [ret({ creditSubtotal: "5.50" })], appliedTo(5.5));
      expect(c.rendered.text).toContain("Credit used $5.50 (returned items)");
      expect(c.rendered.html).toContain("Credit used $5.50 (returned items)");
      expect(c.rendered.text).not.toContain("Balance due");
    });

    it("the invariant on the email, in cents: Balance due = Total - Paid - Returned for every pinned case", () => {
      const cents = (n: number) => Math.round(n * 100);
      const cases = [
        sale([cash("5.00")], [refunded2]),
        sale([cash("5.00")], [ret()], issued),
        sale([cash("5.00"), note("2.50")], [ret()], appliedTo(2.5)),
        sale([cash("12.50")], [ret({ creditSubtotal: "5.50" })], appliedTo(5.5)),
        sale([cash("5.00")], [pending]),
      ];
      for (const { emailModel: m } of cases) {
        expect(cents(m.balanceDue)).toBe(cents(m.total) - cents(m.paid) - cents(m.returned ?? 0));
      }
    });

    it("a DELIVERY order with its own return and an applied note prints exactly master's receipt: no split, no return lines", () => {
      const withReads = build({
        total: "12.50",
        tax: "0.00",
        counterSale: false,
        payments: [cash("5.00"), note("2.50")],
        returns: [ret()],
        notes: appliedTo(2.5),
      });
      const { order, invoices, payments, branding } = withReads.emailArgs;
      // master: the same stored rows and NO return reads at all
      const master = renderOrderReceipt(order, invoices, payments, branding, ZONE);
      expect(withReads.rendered.model).toEqual(master.model);
      expect(withReads.rendered.text).toBe(master.text);
      expect(withReads.rendered.html).toBe(master.html);
      for (const key of ["returned", "refunded", "creditKept", "creditUsed", "returnPending"]) {
        expect(withReads.rendered.model).not.toHaveProperty(key);
      }
      // the store-credit application stays a tender and part of Paid on a non-counter order. #3576 Opus MUST: master's
      // LITERAL line (labels only, no amounts), not this renderer compared against itself.
      expect(textLines(withReads.rendered)).toEqual([
        "Payment method Cash + Store credit",
        "Paid $7.50",
        "Balance due $5.00",
      ]);
    });

    it.each([
      // master folded an advance application into Store credit and printed labels only
      [[{ method: "ADVANCE", amount: "12.50" }], "Store credit"],
      [
        [
          { method: "CASH", amount: "7.50" },
          { method: "ADVANCE", amount: "5.00" },
        ],
        "Cash + Store credit",
      ],
      [
        [
          { method: "ADVANCE", amount: "5.00" },
          { method: "CREDIT_NOTE", amount: "2.50" },
        ],
        "Store credit",
      ],
    ])("a DELIVERY order paid %j reads master's %s", (payments, label) => {
      const { emailModel } = build({ total: "12.50", tax: "0.00", counterSale: false, payments });
      expect(emailModel.methodLabel).toBe(label);
    });
  });
});

describe("the proof sale: a $14.99 Pc line rung at $10.00 x 2 reads the same on every surface", () => {
  const line = (
    id: string,
    name: string,
    unitPrice: string,
    qty: string,
    originalPrice?: string,
    priceType?: string,
  ) => ({
    id,
    name,
    status: "DELIVERED",
    qty,
    unitPrice,
    ...(originalPrice ? { originalPrice, priceType: priceType ?? "DISCOUNTED" } : {}),
    unitsPerBox: null,
    boxes: null,
    pieces: null,
    product: null,
  });
  const s = build({
    total: "24.36",
    tax: "1.86",
    configured: 8.25,
    rates: ["0.0825", "0.0825"],
    payments: [{ method: "CASH", amount: "24.36" }],
    lines: [line("a", "Each", "2.50", "1"), line("b", "Pc", "10.00", "2", "14.99")],
    live: [
      { tempId: "a", name: "Each", unitPrice: 2.5, qty: 1 },
      // the cart's tier price is 12 (a tier customer), the stored LIST is 14.99: the receipt strikes the list
      { tempId: "b", name: "Pc", unitPrice: 10, qty: 2, tierPrice: 12, override: {} },
    ],
  });

  it("Subtotal $32.48, Discounts $9.98, the struck $29.98 on the line, Tax $1.86, Total $24.36", () => {
    for (const m of [s.live, s.reprint, s.emailModel]) {
      expect(m).toMatchObject({
        subtotal: 32.48,
        discounts: 9.98,
        tax: 1.86,
        adjustments: 0,
        total: 24.36,
      });
      expect(m.lines.find((l) => l.name === "Pc")).toMatchObject({
        total: 20,
        original: 29.98,
        discount: 9.98,
      });
      expect(m.lines.find((l) => l.name === "Each")).toMatchObject({ original: null, discount: 0 });
    }
  });

  it("the tenant's invoice.hideOriginalPrice (the invoices' own setting): net lines only, no struck price and no Discounts row, on all three", () => {
    const hidden = build({
      total: "24.36",
      tax: "1.86",
      configured: 8.25,
      rates: ["0.0825", "0.0825"],
      hide: true,
      payments: [{ method: "CASH", amount: "24.36" }],
      lines: [line("a", "Each", "2.50", "1"), line("b", "Pc", "10.00", "2", "14.99")],
      live: [
        { tempId: "a", name: "Each", unitPrice: 2.5, qty: 1 },
        { tempId: "b", name: "Pc", unitPrice: 10, qty: 2, tierPrice: 12, override: {} },
      ],
    });
    for (const m of [hidden.live, hidden.reprint, hidden.emailModel]) {
      expect(m).toMatchObject({
        subtotal: 22.5,
        discounts: 0,
        tax: 1.86,
        adjustments: 0,
        total: 24.36,
      });
      expect(m.lines.map((l) => [l.total, l.original, l.discount])).toEqual([
        [2.5, null, 0],
        [20, null, 0],
      ]);
    }
  });

  it("an unedited line stored with no list price, or a list price at or below the charge, shows nothing struck", () => {
    const plain = build({
      total: "24.36",
      tax: "1.86",
      configured: 8.25,
      rates: ["0.0825"],
      payments: [{ method: "CASH", amount: "24.36" }],
      lines: [line("a", "Each", "2.50", "1", "2.50"), line("b", "Pc", "10.00", "2", "9.00")],
      live: [
        { tempId: "a", name: "Each", unitPrice: 2.5, qty: 1 },
        { tempId: "b", name: "Pc", unitPrice: 10, qty: 2 },
      ],
    });
    for (const m of [plain.live, plain.reprint, plain.emailModel]) {
      expect(m.discounts).toBe(0);
      expect(m.subtotal).toBe(22.5);
      expect(m.lines.every((l) => l.original === null)).toBe(true);
    }
  });
});

describe("ONE original-price rule (the invoices'): the struck base is the stored LIST price, on every surface", () => {
  // Chips-like single line, qty 2. Stored facts differ by case; the cart's own tier price never decides what is struck.
  const one = (
    unitPrice: string,
    originalPrice: string | undefined,
    priceType: string,
    cartTier: number,
    over: Partial<Scenario> = {},
    qty = "2",
  ) => {
    const net = Number(unitPrice) * Number(qty);
    const total = (net * 1.08).toFixed(2);
    return build({
      total,
      tax: (Number(total) - net).toFixed(2),
      configured: 8,
      rates: ["0.0800"],
      payments: [{ method: "CASH", amount: total }],
      lines: [
        {
          id: "x",
          name: "Item",
          status: "DELIVERED",
          qty,
          unitPrice,
          ...(originalPrice ? { originalPrice } : {}),
          priceType,
          unitsPerBox: null,
          boxes: null,
          pieces: null,
          product: null,
        },
      ],
      live: [
        {
          tempId: "x",
          name: "Item",
          unitPrice: Number(unitPrice),
          qty: Number(qty),
          tierPrice: cartTier,
          override: priceType === "DISCOUNTED" || priceType === "MANUAL" ? {} : null,
        },
      ],
      ...over,
    });
  };
  const all = (s: ReturnType<typeof one>) => [s.live, s.reprint, s.emailModel];
  const struck = (m: ReceiptModel) => m.lines[0];

  it("(a) an UNEDITED special-tier line (stored SPECIAL, charged 10, list 12): the list is struck, 4.00 off, like an invoice", () => {
    const s = one("10.00", "12.00", "SPECIAL", 10);
    for (const m of all(s)) {
      expect(struck(m)).toMatchObject({ total: 20, original: 24, discount: 4 });
      expect(m).toMatchObject({ subtotal: 24, discounts: 4 });
    }
  });

  it("(b) a tier customer with a cashier override where tier (10) differs from list (12): the LIST 12 is struck, never the tier 10", () => {
    const s = one("8.00", "12.00", "DISCOUNTED", 10);
    for (const m of all(s)) {
      expect(struck(m)).toMatchObject({ total: 16, original: 24, discount: 8 });
      expect(m).toMatchObject({ subtotal: 24, discounts: 8 });
    }
  });

  it("(c) a plain list customer with an override (list 12, charged 8): the list is struck", () => {
    const s = one("8.00", "12.00", "DISCOUNTED", 12);
    for (const m of all(s))
      expect(struck(m)).toMatchObject({ total: 16, original: 24, discount: 8 });
  });

  it("every case agrees row by row across the three surfaces", () => {
    for (const s of [
      one("10.00", "12.00", "SPECIAL", 10),
      one("8.00", "12.00", "DISCOUNTED", 10),
      one("8.00", "12.00", "DISCOUNTED", 12),
    ]) {
      const money = (m: ReceiptModel) => [m.subtotal, m.discounts, m.tax, m.adjustments, m.total];
      expect(money(s.live)).toEqual(money(s.emailModel));
      expect(money(s.reprint)).toEqual(money(s.emailModel));
      const lineRow = (m: ReceiptModel) => [
        struck(m).total,
        struck(m).original,
        struck(m).discount,
      ];
      expect(lineRow(s.live)).toEqual(lineRow(s.emailModel));
      expect(lineRow(s.reprint)).toEqual(lineRow(s.emailModel));
    }
  });

  it("a MANUAL upsell (charged 14 over a stored base of 12) never exposes the lower base: nothing struck anywhere", () => {
    const s = one("14.00", "12.00", "MANUAL", 12);
    for (const m of all(s)) {
      expect(struck(m)).toMatchObject({ original: null, discount: 0 });
      expect(m.discounts).toBe(0);
    }
  });

  it("a plain standard line (no stored list) and a list at or below the charge show nothing struck", () => {
    for (const s of [
      one("12.00", undefined, "STANDARD", 12),
      one("12.00", "12.00", "STANDARD", 12),
    ])
      for (const m of all(s)) expect(struck(m)).toMatchObject({ original: null, discount: 0 });
  });

  it("an older server that serves no stored lines strikes nothing on the live receipt (it never invents a base from the cart's tier price)", () => {
    const s = one("8.00", "12.00", "DISCOUNTED", 10);
    const bare = buildCounterReceipt({
      receipt: { ...s.response, lines: undefined },
      lines: [
        {
          tempId: "x",
          productId: "p-x",
          name: "Item",
          unitPrice: 8,
          qty: 2,
          tierPrice: 10,
          override: {},
        },
      ],
      enteredTender: null,
      profile: { businessName: BRANDING.businessName, timezone: ZONE },
      now: new Date(),
    });
    expect(struck(bare)).toMatchObject({ original: null, discount: 0 });
  });
});

describe("a receipt never prints a back-calculated rate (RULING): the same label on every surface", () => {
  // the proof sale: Each 1 x 2.50 + a Pc product 2 x 10.00 = 22.50 net, 8.25% tax = 1.86, total 24.36
  const line = (id: string, name: string, unitPrice: string, qty: string) => ({
    id,
    name,
    status: "DELIVERED",
    qty,
    unitPrice,
    unitsPerBox: null,
    boxes: null,
    pieces: null,
    product: null,
  });
  const proof = (rates: string[], extra: Partial<Scenario> = {}) =>
    build({
      total: "24.36",
      tax: "1.86",
      configured: 8.25,
      rates,
      payments: [{ method: "CASH", amount: "24.36" }],
      lines: [line("a", "Each", "2.50", "1"), line("b", "Pc", "10.00", "2")],
      live: [
        { tempId: "a", name: "Each", unitPrice: 2.5, qty: 1 },
        { tempId: "b", name: "Pc", unitPrice: 10, qty: 2 },
      ],
      ...extra,
    });
  const surfaces = (s: ReturnType<typeof proof>) => [
    s.row.taxRatePercent,
    s.response.taxRatePercent,
    s.emailModel.taxRatePercent,
    s.reprint.taxRatePercent,
    s.live.taxRatePercent,
  ];

  it("lines stamped with the DERIVED rate (1.86 / 22.50 = 0.0827) against a configured 8.25%: plain Tax on every surface, never Tax (8.27%)", () => {
    const s = proof(["0.0827", "0.0827"]);
    expect(surfaces(s)).toEqual([null, null, null, null, null]);
    for (const m of [s.reprint, s.emailModel, s.live]) {
      expect(m.tax).toBe(1.86);
      expect(adjustmentLabel(m.taxRatePercent)).toBe("Tax");
    }
  });

  it("lines that store the configured 0.0825: Tax (8.25%) on every surface", () => {
    const s = proof(["0.0825", "0.0825"]);
    expect(surfaces(s)).toEqual([8.25, 8.25, 8.25, 8.25, 8.25]);
    for (const m of [s.reprint, s.emailModel, s.live])
      expect(adjustmentLabel(m.taxRatePercent)).toBe("Tax (8.25%)");
    expect(moneyRows(s.emailModel)).toEqual(moneyRows(s.reprint));
  });

  it("a legacy invoice whose lines all store 0 is plain Tax on every surface: its rate is never inferred from the header tax", () => {
    const s = proof(["0", "0"]);
    expect(surfaces(s)).toEqual([null, null, null, null, null]);
    expect(moneyRows(s.emailModel)).toEqual(moneyRows(s.reprint));
  });

  it("with no configured rate on file nothing is named", () => {
    const s = proof(["0.0825", "0.0825"], { configured: null });
    expect(surfaces(s)).toEqual([null, null, null, null, null]);
  });

  it("a configured 8.875% (stored rounded to 0.0888) prints Tax (8.875%) on every surface, never 8.88%", () => {
    // 22.50 x 8.875% = 1.997 -> 2.00; the Decimal(5,4) column holds 0.0888
    const s = proof(["0.0888", "0.0888"], { configured: 8.875, total: "24.50", tax: "2.00" });
    expect(surfaces(s)).toEqual([8.875, 8.875, 8.875, 8.875, 8.875]);
    for (const m of [s.reprint, s.emailModel, s.live])
      expect(adjustmentLabel(m.taxRatePercent)).toBe("Tax (8.875%)");
  });

  it("a configured rate that changed since the sale is not applied to it", () => {
    const s = proof(["0.0825", "0.0825"], { configured: 9 });
    expect(surfaces(s)).toEqual([null, null, null, null, null]);
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

  it("EXACT cash (tendered 37.25 on 37.25): the server serves change 0 and EVERY surface shows Change $0.00, never a hidden row", () => {
    const s = cash({ tendered: "37.25" });
    expect(s.row.change).toBe(0);
    expect(s.response.change).toBe(0);
    for (const m of [s.reprint, s.emailModel, s.live]) {
      expect(m.tendered).toBe(37.25);
      expect(m.change).toBe(0);
    }
    expect(moneyRows(s.emailModel)).toEqual(moneyRows(s.reprint));
  });

  it("exact cash the clerk typed on a sale the server stored no tender for keeps its as-entered Change $0.00", () => {
    const s = cash({ tendered: null, entered: 37.25 });
    expect(s.live.tendered).toBe(37.25);
    expect(s.live.change).toBe(0);
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

  it("a legacy all-zero-lines sale: the live receipt names no rate, like every other surface", () => {
    const s = build({ total: "28.62", tax: "2.12", rates: ["0", "0", "0"] });
    expect(s.live.taxRatePercent).toBeNull();
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

describe("row 317b: the unit word ('each') is ONE text on the live receipt, the reprint and the email", () => {
  const line = (
    id: string,
    name: string,
    unit: string | null,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    name: null,
    status: "DELIVERED",
    qty: "3",
    unitPrice: "2.50",
    unitsPerBox: null,
    boxes: null,
    pieces: null,
    product: {
      name,
      unit,
      variantName: null,
      parentProductId: null,
      parent: null,
    },
    ...over,
  });
  const s = build({
    total: "30.78",
    tax: "2.28",
    payments: [{ method: "CASH", amount: "30.78" }],
    lines: [
      line("a", "Cola", "Each"),
      line("b", "Deli ham", "lb", { qty: "2", unitPrice: "6.00" }),
      line("c", "Mints", null, { qty: "1", unitPrice: "1.00" }),
      // a boxed line carries the BOX price and "per box", never the unit word
      line("d", "Chips", "Each", {
        qty: "15",
        unitPrice: "12.00",
        unitsPerBox: 12,
        boxes: 1,
        pieces: 3,
      }),
    ] as never,
    live: [
      { tempId: "a", name: "Cola", unitPrice: 2.5, qty: 3, unit: "Each" },
      { tempId: "b", name: "Deli ham", unitPrice: 6, qty: 2, unit: "lb" },
      { tempId: "c", name: "Mints", unitPrice: 1, qty: 1, unit: null },
      {
        tempId: "d",
        name: "Chips",
        unitPrice: 12,
        qty: 15,
        unitsPerBox: 12,
        boxes: 1,
        pieces: 3,
        unit: "Each",
      },
    ],
  });
  const details = (m: ReceiptModel) => m.lines.map((l) => l.detail);

  it("the email prints the same detail text as the reprint, line for line", () => {
    expect(details(s.emailModel)).toEqual(details(s.reprint));
  });

  it("every surface prints the product's own unit word after a plain line's price, and none on a boxed line", () => {
    for (const m of [s.live, s.reprint, s.emailModel]) {
      expect(details(m)).toEqual([
        "3 × $2.50 each",
        "2 × $6.00 per lb",
        "1 × $1.00",
        "1 box + 3 pcs × $12.00 per box",
      ]);
    }
  });
});
