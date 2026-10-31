import { NSF_FEE_DESCRIPTION_PREFIX, invoiceTaxSplit } from "@routeflow/pricing";
import { sortInvoiceLines, type InvoiceLineOrderFacts } from "./invoice-line-order";

/** SA-1058 R1-R4, R6, R10, R11: the order, its stability, and that it never moves a figure. */

type Line = InvoiceLineOrderFacts & { subtotal?: number; categoryTaxAmount?: number };

const line = (id: string, description: string, extra: Partial<Line> = {}): Line => ({
  id,
  description,
  productId: `p-${id}`,
  ...extra,
});
const manual = (id: string, description: string): Line => ({ id, description, productId: null });

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

/** Fixed permutations, so a test never depends on Math.random. */
const shuffles = <T>(rows: T[]): T[][] => {
  const r = [...rows].reverse();
  return [r, [...r.slice(2), ...r.slice(0, 2)], [...rows.slice(1), rows[0]]];
};

describe("sortInvoiceLines (SA-1058)", () => {
  const nsf: Line = { id: "a-nsf", description: "NSF fee", systemKind: "NSF_FEE", productId: null };
  const r1 = [
    line("b", "Brand B Item"),
    line("a12", "brand a item 12oz"),
    manual("m", "Delivery charge"),
    nsf,
    line("a8", "BRAND A ITEM 8OZ"),
  ];

  it("R1: printed name ignoring case with numbers by value, then manual, then system lines", () => {
    for (const input of [r1, ...shuffles(r1)]) {
      expect(ids(sortInvoiceLines(input))).toEqual(["a8", "a12", "b", "m", "a-nsf"]);
    }
  });

  it("R1: an NSF line known only by its old description is a system line too", () => {
    const legacy = manual("old", `${NSF_FEE_DESCRIPTION_PREFIX} 12`);
    const rows = [legacy, manual("m", "Zebra charge"), line("p", "Zebra Gum")];
    expect(ids(sortInvoiceLines(rows))).toEqual(["p", "m", "old"]);
  });

  it("R2: one name's case line and loose line sit together, case first", () => {
    const rows = [
      line("loose", "Cola 12oz", { boxes: 0, unitsPerBox: 24 }),
      line("other", "Cola 12oz Diet"),
      line("case", "Cola 12oz", { boxes: 3, unitsPerBox: 24 }),
    ];
    expect(ids(sortInvoiceLines(rows))).toEqual(["case", "loose", "other"]);
  });

  it("R2: a units line takes its pack from the stored factor, a factor-1 unit is loose", () => {
    const rows = [
      line("piece", "Soap", { boxes: 7, unitsPerBox: 1 }),
      line("jug", "Soap", { boxes: 2, unitsPerBox: 12 }),
      line("case", "Soap", { boxes: 1, unitsPerBox: 48 }),
    ];
    expect(ids(sortInvoiceLines(rows))).toEqual(["case", "jug", "piece"]);
  });

  it("R3: 8oz sorts before 12oz whatever the case", () => {
    const rows = [line("big", "Water 12oz"), line("small", "water 8oz")];
    expect(ids(sortInvoiceLines(rows))).toEqual(["small", "big"]);
  });

  it("R4: every shuffle gives one output and the input array is untouched", () => {
    const before = [...r1];
    const once = ids(sortInvoiceLines(r1));
    for (const input of shuffles(r1)) expect(ids(sortInvoiceLines(input))).toEqual(once);
    expect(r1).toEqual(before);
    expect(sortInvoiceLines(r1)).not.toBe(r1);
  });

  it("R4: a frozen array can be sorted, so nothing writes to its input", () => {
    expect(ids(sortInvoiceLines(Object.freeze([...r1])))).toHaveLength(r1.length);
  });

  it("R10: a product's current name is not a key: the line sorts by its printed text", () => {
    const renamed = { ...line("r", "Alpha Soap"), product: { name: "Zulu Soap" } };
    expect(ids(sortInvoiceLines([line("m", "Mid Soap"), renamed]))).toEqual(["r", "m"]);
  });

  it("R11: two names differing only by a double space stay adjacent", () => {
    const rows = [line("two", "Cola  12oz"), line("mid", "Cola 12oz x"), line("one", "Cola 12oz")];
    const out = ids(sortInvoiceLines(rows));
    expect(Math.abs(out.indexOf("one") - out.indexOf("two"))).toBe(1);
  });

  it("the id settles two lines with the same name and pack", () => {
    expect(ids(sortInvoiceLines([line("b", "Soap"), line("a", "Soap")]))).toEqual(["a", "b"]);
  });

  it("R6: the levy and tax split do not read line position", () => {
    const rows: Line[] = [
      line("1", "Cola 12oz", { subtotal: 10.01, categoryTaxAmount: 0.33 }),
      line("2", "Chips BBQ", { subtotal: 10.02, categoryTaxAmount: 0.34 }),
      manual("3", "Delivery charge"),
    ];
    const asCharge = (r: Line) => ({ ...r, trackedCategory: { name: "Levy" } }) as any;
    const base = invoiceTaxSplit(5, rows.map(asCharge));
    for (const input of shuffles(rows)) {
      expect(invoiceTaxSplit(5, sortInvoiceLines(input).map(asCharge))).toEqual(base);
    }
  });
});
