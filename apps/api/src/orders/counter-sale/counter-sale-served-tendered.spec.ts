import { buildReceiptModel, type ReceiptOrderInput } from "../../documents/receipt-model";
import { BRANDING, orderFixture } from "../../documents/receipt.fixtures";
import { buildCounterSaleResponse, servedChange, servedTendered } from "./counter-sale-readback";
import { toTodaysSaleRow, type TodayOrderRecord } from "./counter-sale-today";
import { legGroupId } from "./counter-tender-row";

/**
 * Row 347 item 2: a STORED `Order.counterCashTendered` is served as the cash handed over only while the sale has a
 * counter-tender CASH row to measure it against. The figure is written BEFORE any money moves (so a paid sale never lacks
 * it); an attempt that died after that write, then read by-key, or retried as ON_ACCOUNT (no tender step, no lock, so
 * nothing clears it), left a figure no money backs. Its change was already null (`servedChange` needs a cash row); the
 * figure itself was still shown on the response, the Today's row, the receipt and the e-mail. ONE helper
 * (`servedTendered`, next to `servedChange`) now gates every reader.
 *
 * Each surface is driven through the REAL function production uses, with placeholder data only (acme).
 */
const ORDER = "11111111-1111-4111-8111-111111111111";
type Pay = {
  id?: string;
  method: string;
  amount: string;
  status?: string;
  paymentGroupId?: string | null;
};
const pay = (method: string, amount: string, over: Partial<Pay> = {}): Pay => ({
  method,
  amount,
  status: "PAID",
  ...over,
});
const leg = (i: number, method: string, amount: string, status = "PAID"): Pay =>
  pay(method, amount, { status, paymentGroupId: legGroupId(ORDER, i) });

const invoiceOf = (payments: Pay[], total: string) => ({
  id: "inv-1",
  invoiceNumber: "INV-1",
  status: "SENT",
  total,
  items: [],
  payments: payments.map((p, i) => ({ id: `pay-${i + 1}`, ...p })),
});

/** The four readers of one stored sale: the POST / by-key response, Today's row, the receipt model (reprint and e-mail). */
function surfaces(opts: { tendered: string | null; payments: Pay[]; total: string }) {
  const invoice = invoiceOf(opts.payments, opts.total);
  const response = buildCounterSaleResponse({
    order: {
      id: ORDER,
      orderNumber: "ORD-1",
      counterCashTendered: opts.tendered,
      tax: "0.00",
    },
    invoices: [invoice],
    replayed: false,
  } as unknown as Parameters<typeof buildCounterSaleResponse>[0]);
  const row = toTodaysSaleRow({
    id: ORDER,
    orderNumber: "ORD-1",
    status: "DELIVERED",
    total: opts.total,
    createdAt: new Date("2026-10-07T18:14:00.000Z"),
    customerId: "c-1",
    counterCashTendered: opts.tendered,
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    invoices: [invoice],
    returns: [],
  } as unknown as TodayOrderRecord);
  const order: ReceiptOrderInput = {
    ...orderFixture({ total: opts.total, tax: "0.00" }),
    id: ORDER,
    counterCashTendered: opts.tendered,
  };
  const model = buildReceiptModel(
    order,
    [invoice],
    invoice.payments.map((p) => ({ ...p, status: p.status ?? "PAID", invoiceId: "inv-1" })),
    BRANDING,
    "America/New_York",
  );
  return { response, row, model };
}

describe("a stored tendered with NO counter-tender cash row is served on no surface (row 347 item 2)", () => {
  // the interrupted attempt: the figure was written, the crash came before any tender row
  it("no payment row at all (ON_ACCOUNT retry, or a plain by-key read after the crash): no figure, no change", () => {
    const s = surfaces({ tendered: "50.00", payments: [], total: "28.62" });
    expect(s.response.cashTendered).toBeUndefined();
    expect(s.response.change).toBeUndefined();
    expect(s.row.cashTendered).toBeNull();
    expect(s.row.change).toBeNull();
    expect(s.model.tendered).toBeNull();
    expect(s.model.change).toBeNull();
  });

  it("a card-only sale (a card retry under the same key): the stale cash figure is not served", () => {
    const s = surfaces({
      tendered: "50.00",
      payments: [leg(0, "CREDIT_CARD", "28.62")],
      total: "28.62",
    });
    expect(s.response.cashTendered).toBeUndefined();
    expect(s.row.cashTendered).toBeNull();
    expect(s.model.tendered).toBeNull();
  });

  it("a cash row that was voided, with no live one left, is no cash row", () => {
    const s = surfaces({
      tendered: "50.00",
      payments: [leg(0, "CASH", "28.62", "VOID")],
      total: "28.62",
    });
    expect(s.response.cashTendered).toBeUndefined();
    expect(s.row.cashTendered).toBeNull();
    expect(s.model.tendered).toBeNull();
  });

  it("a foreign cash row (an office payment after a grouped counter tender) does not anchor it", () => {
    const s = surfaces({
      tendered: "50.00",
      payments: [leg(0, "CREDIT_CARD", "20.00"), pay("CASH", "8.62")], // ungrouped once a grouped row exists = foreign
      total: "28.62",
    });
    expect(s.response.cashTendered).toBeUndefined();
    expect(s.row.cashTendered).toBeNull();
    expect(s.model.tendered).toBeNull();
  });
});

describe("a stored tendered backed by a counter-tender cash row is served exactly as before (S1/S2 stay)", () => {
  it("a single cash leg: tendered 50 on 28.62, change 21.38, on all four readers", () => {
    const s = surfaces({
      tendered: "50.00",
      payments: [leg(0, "CASH", "28.62")],
      total: "28.62",
    });
    expect(s.response.cashTendered).toBe(50);
    expect(s.response.change).toBe(21.38);
    expect(s.row.cashTendered).toBe(50);
    expect(s.row.change).toBe(21.38);
    expect(s.model.tendered).toBe(50);
    expect(s.model.change).toBe(21.38);
  });

  it("S1: card 30 + cash handed 40 on 50: tendered 40, change 20, even after the card row is voided", () => {
    for (const card of ["PAID", "VOID"]) {
      const s = surfaces({
        tendered: "40.00",
        payments: [leg(0, "CREDIT_CARD", "30.00", card), leg(1, "CASH", "20.00")],
        total: "50.00",
      });
      expect(s.response.cashTendered).toBe(40);
      // a voided card row leaves the sale owing, so the live response reads "not recorded" and serves no change; the row and
      // the receipt measure the change from the stored cash row, as servedChange pins
      if (card === "PAID") expect(s.response.change).toBe(20);
      expect(s.row.cashTendered).toBe(40);
      expect(s.row.change).toBe(20);
      expect(s.model.tendered).toBe(40);
      expect(s.model.change).toBe(20);
    }
  });

  it("an interrupted cash tender (20 of 50 recorded, 50 handed over): the figure shows (a cash row exists), the change is null", () => {
    const s = surfaces({ tendered: "50.00", payments: [leg(0, "CASH", "20.00")], total: "50.00" });
    expect(s.response.cashTendered).toBe(50);
    expect(s.response.change).toBeUndefined();
    expect(s.row.cashTendered).toBe(50);
    expect(s.row.change).toBeNull();
    expect(s.model.tendered).toBe(50);
    expect(s.model.change).toBeNull();
  });

  it("nothing stored: nothing served, with or without a cash row", () => {
    const s = surfaces({ tendered: null, payments: [leg(0, "CASH", "28.62")], total: "28.62" });
    expect(s.response.cashTendered).toBeUndefined();
    expect(s.row.cashTendered).toBeNull();
    expect(s.model.tendered).toBeNull();
  });
});

describe("servedTendered: the ONE gate, next to servedChange", () => {
  const cash = [pay("CASH", "10.00")];

  it("null without a stored figure or without a counter-tender cash row; the rounded figure otherwise", () => {
    expect(servedTendered(ORDER, null, cash)).toBeNull();
    expect(servedTendered(ORDER, undefined, cash)).toBeNull();
    expect(servedTendered(ORDER, "50.00", [])).toBeNull();
    expect(servedTendered(ORDER, "50.00", [pay("CREDIT_CARD", "10.00")])).toBeNull();
    expect(servedTendered(ORDER, "50.00", [pay("CASH", "10.00", { status: "VOID" })])).toBeNull();
    expect(servedTendered(ORDER, "50.005", cash)).toBe(50.01);
    expect(servedTendered(ORDER, 41.27, cash)).toBe(41.27);
  });

  it("agrees with servedChange: whenever a change is served, the figure it was measured from is served too", () => {
    const rows = [leg(0, "CREDIT_CARD", "30.00"), leg(1, "CASH", "20.00")];
    expect(servedChange(ORDER, 40, rows, 50)).toBe(20);
    expect(servedTendered(ORDER, 40, rows)).toBe(40);
    expect(servedChange(ORDER, 40, [], 50)).toBeNull();
    expect(servedTendered(ORDER, 40, [])).toBeNull();
  });
});
