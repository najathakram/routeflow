import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * SA-1058 A-1: the line table's layout. A row stays whole across a page break, except a mixed pack too
 * tall to fit, and the charged price sits on the row's top line with Qty and Subtotal.
 *
 * Jest maps `./invoice-pdf-template` to a stub and has no .tsx transform, so this compiles the real file
 * here and walks the element tree it returns. Pagination itself needs the real renderer, which is ESM
 * and can't run under Jest: the PR body's proof renders R12 and R13.
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

/** A row's text, in reading order. */
function textsOf(node: unknown): string[] {
  return walk(node)
    .flatMap((el) => [el.props?.children].flat())
    .filter((c): c is string | number => typeof c === "string" || typeof c === "number")
    .map(String);
}

const baseItem = {
  id: "line-1",
  description: "Soap 12oz",
  qty: 2,
  unitPrice: 9.5,
  subtotal: 19,
  discount: 0,
  taxRate: 0,
  barcodeDataUri: "data:image/png;base64,AA==",
  barcodeText: "012345678905",
};

const render = (items: any[], over: Record<string, unknown> = {}) =>
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
        ...over,
      },
    }),
  );

const row = (tree: El[], key: string) => tree.find((el) => el.key === key) as El;

const subLines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `Piece ${i}`, qtyText: "1" }));

describe("the invoice PDF's line rows (SA-1058 A-1)", () => {
  it("R12: a plain line's row stays whole, so a name can't leave its barcode behind", () => {
    expect(row(render([baseItem]), "line-1").props?.wrap).toBe(false);
  });

  it("R12: a mixed pack of 12 sub-lines still stays whole", () => {
    const tree = render([{ ...baseItem, subLines: subLines(12) }]);
    expect(row(tree, "line-1").props?.wrap).toBe(false);
  });

  it("R13: past 12 sub-lines the row keeps today's wrap: an unbreakable row taller than a page loses content", () => {
    for (const n of [13, 30]) {
      const tree = render([{ ...baseItem, subLines: subLines(n) }]);
      expect(row(tree, "line-1").props?.wrap).not.toBe(false);
    }
  });

  describe("a mixed pack shown in pieces", () => {
    const display = {
      layout: "components",
      rows: [
        { name: "Piece A", qtyText: "1", priceText: "$1.00", amountText: "$1.00" },
        { name: "Piece B", qtyText: "1", priceText: "$2.00", amountText: "$2.00" },
      ],
      categoryTax: { label: "Levy", amountText: "$0.10" },
    };
    const tree = render([{ ...baseItem, display }]);

    it("each component row stays whole", () => {
      expect(row(tree, "line-1-row-0").props?.wrap).toBe(false);
      expect(row(tree, "line-1-row-1").props?.wrap).toBe(false);
    });

    it("the box row and the category-tax row stay whole", () => {
      const boxes = tree.filter((el) => el.key === "line-1" && el.props?.wrap === false);
      expect(boxes).toHaveLength(1);
      const tax = tree.filter(
        (el) => el.props?.wrap === false && textsOf(el.props?.children).includes("Levy"),
      );
      expect(tax).toHaveLength(1);
    });
  });

  describe("R14: a line with a list price above the charged price", () => {
    const override = { ...baseItem, unitPrice: 9.5, originalPrice: 12, priceType: "CUSTOM" };

    it("the charged price comes first, the struck list price under it", () => {
      const cells = textsOf(row(render([override]), "line-1").props?.children);
      expect(cells).toEqual(expect.arrayContaining(["$9.50", "$12.00"]));
      expect(cells.indexOf("$9.50")).toBeLessThan(cells.indexOf("$12.00"));
    });

    it("with the per-piece column on, the order holds", () => {
      const perBaseUnit = { price: 0.79, unit: "pc" };
      const cells = textsOf(row(render([{ ...override, perBaseUnit }]), "line-1").props?.children);
      expect(cells.indexOf("$9.50")).toBeLessThan(cells.indexOf("$12.00"));
    });

    it("hideOriginalPrice still hides the struck price", () => {
      const tree = render([override], { hideOriginalPrice: true });
      expect(textsOf(row(tree, "line-1").props?.children)).not.toContain("$12.00");
    });
  });
});
