import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * W-1185: the invoice PDF's totals box opens with an "Items" row (lines, boxes, named units, pieces: never
 * added together). W-1044: the totals box never splits across two pages.
 *
 * Same harness as invoice-pdf-rows.spec.ts: compile the real template and walk the element tree it returns.
 */
function loadTemplate() {
  const file = path.join(__dirname, "invoice-pdf-template.tsx");
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2021,
    },
  });
  const load = (id: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(id.startsWith(".") ? path.resolve(__dirname, id) : id);
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", outputText)(load, mod, mod.exports);
  return mod.exports;
}

const { InvoicePdfTemplate } = loadTemplate();

type El = { type?: unknown; key?: string | null; props?: Record<string, any> };

function walk(node: unknown, seen: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, seen);
    return seen;
  }
  if (node && typeof node === "object" && "props" in node) {
    seen.push(node as El);
    walk((node as El).props?.children, seen);
  }
  return seen;
}

function textsOf(node: unknown): string[] {
  return walk(node)
    .flatMap((el) => [el.props?.children].flat())
    .filter((c): c is string | number => typeof c === "string" || typeof c === "number")
    .map(String);
}

const line = (id: string, over: Record<string, unknown>) => ({
  id,
  description: `Item ${id}`,
  qty: 1,
  unitPrice: 1,
  subtotal: 1,
  discount: 0,
  taxRate: 0,
  ...over,
});

const MIXED = [
  line("a", { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 }),
  line("b", { qty: 16, boxes: 1, pieces: 4, unitsPerBox: 12 }),
  line("c", { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitLabel: "Case" }),
  line("d", { qty: 2, product: { unit: "bag" } }), // a plain line counts in its selling unit
];

const render = (items: any[]) =>
  walk(
    InvoicePdfTemplate({
      invoice: {
        id: "inv-1",
        invoiceNumber: "INV-1",
        status: "SENT",
        subtotal: 19,
        taxAmount: 0,
        discount: 0,
        shippingFee: 0,
        total: 19,
        issueDate: new Date("2026-10-30T12:00:00Z"),
        dueDate: new Date("2026-11-30T12:00:00Z"),
        customer: { businessName: "Acme Foods", contactName: "Pat" },
        items,
        payments: [],
      },
    }),
  );

/** The totals box's first row: label "Items", then its value text. */
function itemsRow(tree: El[]): string[] | undefined {
  const rows = tree.filter(
    (el) =>
      Array.isArray(el.props?.children) && el.props?.style?.justifyContent === "space-between",
  );
  return rows.map((r) => textsOf(r)).find((t) => t[0] === "Items");
}

describe("the invoice PDF's item count (W-1185)", () => {
  it("prints lines, boxes, named units and pieces in the Items row, never added together", () => {
    expect(itemsRow(render(MIXED))).toEqual([
      "Items",
      "4 lines · 4 boxes · 2 cases · 2 bags · 4 pcs",
    ]);
  });

  it("reads singular words for a one-line invoice", () => {
    const one = [line("a", { qty: 13, boxes: 1, pieces: 0, unitsPerBox: 13 })];
    expect(itemsRow(render(one))).toEqual(["Items", "1 line · 1 box"]);
  });

  it("counts the sale-time words and skips the NSF fee line", () => {
    const items = [
      line("a", { qty: 13, boxes: 1, pieces: 1, packLabel: "Case", baseLabel: "Can" }),
      line("b", { qty: 1.5, baseLabel: "bar", product: { unit: "kg" } }),
      line("n", { qty: 1, systemKind: "NSF_FEE" }),
    ];
    expect(itemsRow(render(items))).toEqual(["Items", "2 lines · 1 case · 1 can · 1.5 kg"]);
  });

  it("reads a case of cans as 1 case · 1 can, as the builder does", () => {
    const items = [
      line("a", { qty: 13, boxes: 1, pieces: 1, packLabel: "Case", baseLabel: "Can" }),
    ];
    expect(itemsRow(render(items))).toEqual(["Items", "1 line · 1 case · 1 can"]);
  });

  it("a plain line counts in its selling unit, like the builder: 1 box, 1 case, 1 bag", () => {
    const items = [
      line("a", { qty: 1, product: { unit: "box" } }),
      line("b", { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Case" }),
      line("c", { qty: 1, product: { unit: "bag" } }),
    ];
    expect(itemsRow(render(items))).toEqual(["Items", "3 lines · 1 box · 1 case · 1 bag"]);
  });

  // W-1185 fix 1 (F5): a long count wraps inside the 220 pt box, right-aligned, off the label.
  it("the Items value shrinks and wraps beside its label instead of overflowing the box", () => {
    const tree = render(MIXED);
    const row = tree.find(
      (el) => el.props?.style?.justifyContent === "space-between" && textsOf(el)[0] === "Items",
    ) as El;
    const [label, value] = walk(row.props?.children).filter((el) => el.props?.style);
    const flat = (el: El) => Object.assign({}, ...[el.props?.style].flat());
    expect(flat(label).flexShrink).toBe(0);
    expect(flat(value)).toMatchObject({
      flex: 1,
      flexShrink: 1,
      textAlign: "right",
      marginLeft: 8,
    });
  });

  it("is the first row of the totals box, above Subtotal", () => {
    const tree = render(MIXED);
    const box = tree.find((el) => textsOf(el).includes("Subtotal") && el.props?.style?.width);
    const first = walk((box as El).props?.children).find(
      (el) => el.props?.style?.justifyContent === "space-between",
    ) as El;
    expect(textsOf(first)[0]).toBe("Items");
  });

  it("W-1044: the totals box never splits across pages", () => {
    const tree = render(MIXED);
    const wrapper = tree.find(
      (el) => el.props?.style?.justifyContent === "flex-end" && el.props?.style?.marginTop === 12,
    ) as El;
    expect(wrapper).toBeDefined();
    expect(wrapper.props?.wrap).toBe(false);
  });
});
