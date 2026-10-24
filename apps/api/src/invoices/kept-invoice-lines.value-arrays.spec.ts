import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { isNestedWrite, splitKeptItems } from "./kept-invoice-lines";
import { carryOverrideStamp, OVERRIDE_STAMP_COLUMNS } from "../common/restriction-override-columns";

/**
 * SA-938 (#3726, row 632): a top-level array of primitives (a scalar list column such as
 * `restrictionOverrideRuleIds`) is a VALUE, not a nested write, so a rebuilt line carrying one can still be kept.
 * An override-id change alone keeps the line and writes the whole stamp in place; it never re-books the ledger.
 */
const invoiceItem = Prisma.dmmf.datamodel.models.find((m) => m.name === "InvoiceItem")!;
/**
 * Prisma 7's runtime DMMF drops `isList`, so list-ness is read from the schema folder's `InvoiceItem` block
 * (`name Type[]`) and kept only where the generated client classes the field as a scalar.
 */
const listFieldNames = (() => {
  const dir = path.resolve(__dirname, "../../prisma/schema");
  const src = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".prisma"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
  const block = /^model InvoiceItem \{([\s\S]*?)^\}/m.exec(src)![1];
  return new Set([...block.matchAll(/^\s*(\w+)\s+\w+\[\]/gm)].map((m) => m[1]));
})();
const scalarLists = invoiceItem.fields.filter(
  (f) => f.kind === "scalar" && listFieldNames.has(f.name),
);
const relations = invoiceItem.fields.filter((f) => f.kind === "object");

/** One primitive per scalar type: a list column's rebuilt value is an array of these. */
const sample = (type: string): unknown =>
  ({ String: "x", Int: 1, BigInt: 1, Float: 1.5, Boolean: true })[type] ?? "x";

const AT = new Date("2026-10-01T12:00:00Z");
const stamp = (ruleIds: string[]) =>
  carryOverrideStamp({
    restrictionOverrideReason: "manager ok",
    restrictionOverrideBy: "u-staff",
    restrictionOverrideAt: AT,
    restrictionOverrideRuleIds: ruleIds,
  });

/** A stored row as `findMany` (no select) returns it: Decimals, Dates, and every scalar list column. */
const row = (over: Record<string, unknown> = {}) => ({
  id: "ii-1",
  orderItemId: "oi-1",
  productId: "p1",
  description: "Widget",
  qty: { toNumber: () => 12 },
  unitPrice: { toNumber: () => 10 },
  subtotal: { toNumber: () => 120 },
  categoryTaxAmount: { toNumber: () => 0.6 },
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  notes: null,
  ...Object.fromEntries(scalarLists.map((f) => [f.name, [sample(f.type)]])),
  ...stamp(["r1"]),
  ...over,
});
/** The rebuilt `data` the rebuild writes: plain numbers, and the whole stamp via `carryOverrideStamp`. */
const data = (over: Record<string, unknown> = {}) => ({
  orderItemId: "oi-1",
  productId: "p1",
  description: "Widget",
  qty: 12,
  unitPrice: 10,
  subtotal: 120,
  categoryTaxAmount: 0.6,
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  notes: null,
  ...Object.fromEntries(scalarLists.map((f) => [f.name, [sample(f.type)]])),
  ...stamp(["r1"]),
  ...over,
});

describe("SA-938 MUST 4: InvoiceItem's DMMF fields are classed by shape", () => {
  it("the generated client has InvoiceItem's override rule-id list and its components relation", () => {
    expect(scalarLists.map((f) => f.name)).toContain("restrictionOverrideRuleIds");
    expect(relations.map((f) => f.name)).toContain("components");
  });

  it.each(scalarLists.map((f) => [f.name, f.type] as const))(
    "scalar list %s (%s[]) is a value, not a nested write",
    (_name, type) => {
      expect(isNestedWrite([sample(type), sample(type)])).toBe(false);
      expect(isNestedWrite([])).toBe(false);
    },
  );

  it.each(relations.map((f) => [f.name] as const))("relation %s is a nested write", () => {
    expect(isNestedWrite({ create: [{ productId: "p" }] })).toBe(true);
    expect(isNestedWrite({ connect: { id: "x" } })).toBe(true);
    expect(isNestedWrite([{ productId: "p" }])).toBe(true);
  });

  it("an array holding any object is nested; null elements and Dates/Decimals stay values", () => {
    expect(isNestedWrite(["a", { id: "b" }])).toBe(true);
    expect(isNestedWrite(["a", null])).toBe(false);
    expect(isNestedWrite(AT)).toBe(false);
    expect(isNestedWrite({ toNumber: () => 1 })).toBe(false);
  });
});

describe("SA-938 MUST 5: splitKeptItems with a scalar list column", () => {
  it("(i) override ids unchanged, nothing else changed: KEPT with no update", () => {
    const r = splitKeptItems([row()], [data()]);
    expect(r).toEqual({ keepIds: ["ii-1"], updates: [], create: [] });
  });

  it("(ii) only the override ids changed: KEPT, one in-place update carrying all four stamp columns", () => {
    const d = data(stamp(["r1", "r2"]));
    const r = splitKeptItems([row()], [d]);
    expect(r.keepIds).toEqual(["ii-1"]);
    expect(r.create).toEqual([]);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].id).toBe("ii-1");
    for (const c of OVERRIDE_STAMP_COLUMNS) expect(r.updates[0].data).toHaveProperty(c, d[c]);
  });

  it("(iii) only the note changed: KEPT, one update", () => {
    const r = splitKeptItems([row()], [data({ notes: "leave at back door" })]);
    expect(r.keepIds).toEqual(["ii-1"]);
    expect(r.updates).toHaveLength(1);
    expect(r.create).toEqual([]);
  });

  it("(iv) qty changed: re-created", () => {
    const r = splitKeptItems([row()], [data({ qty: 13, subtotal: 130 })]);
    expect(r.keepIds).toEqual([]);
    expect(r.create).toHaveLength(1);
  });

  it("(v) a components line: re-created", () => {
    const r = splitKeptItems(
      [row()],
      [data({ components: { create: [{ productId: "p2", qty: 1 }] } })],
    );
    expect(r.keepIds).toEqual([]);
    expect(r.create).toHaveLength(1);
  });

  it("a reordered list, or a stored NULL against a rebuilt [], is one in-place write, never a rebuild", () => {
    const reordered = splitKeptItems([row(stamp(["r1", "r2"]))], [data(stamp(["r2", "r1"]))]);
    expect(reordered.keepIds).toEqual(["ii-1"]);
    expect(reordered.updates).toHaveLength(1);
    const nullVsEmpty = splitKeptItems(
      [row({ restrictionOverrideRuleIds: null })],
      [data({ restrictionOverrideRuleIds: [] })],
    );
    expect(nullVsEmpty.keepIds).toEqual(["ii-1"]);
    expect(nullVsEmpty.updates).toHaveLength(1);
  });
});
