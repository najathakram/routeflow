import * as fs from "fs";
import * as path from "path";

/** SA-1256 B7: `acceptSums` stays on the order builder's main list only (PR 1). */
const WEB = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

const UNTOUCHED = [
  "app/(dashboard)/orders/_components/CounterLineRow.tsx",
  "app/(dashboard)/orders/_components/CounterSaleScreen.tsx",
  "app/(dashboard)/orders/_components/scan/ScanOrderScreen.tsx",
  "app/(dashboard)/orders/_components/scan/PriceEditor.tsx",
  "app/(dashboard)/invoices/new/page.tsx",
  "app/(dashboard)/orders/[id]/_components/order-line-edit.tsx",
];

/** A comment that names the prop (use-held-qty.ts does) is not a use of it. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "coverage") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("acceptSums scope (SA-1256 B7)", () => {
  it.each(UNTOUCHED)("%s exists and never mentions acceptSums", (rel) => {
    expect(fs.existsSync(path.join(WEB, rel))).toBe(true);
    expect(read(rel)).not.toContain("acceptSums");
  });

  it("only LineItemRow, CasesPiecesInput and CreateOrderModal name acceptSums among non-test files", () => {
    const files = walk(WEB)
      .filter((f) => !/\.(test|spec)\.tsx?$/.test(f) && !/\.pins\.test\./.test(f))
      .filter((f) => stripComments(fs.readFileSync(f, "utf8")).includes("acceptSums"))
      .map((f) => path.relative(WEB, f).split(path.sep).join("/"))
      .sort();
    expect(files).toEqual([
      "app/(dashboard)/orders/_components/CreateOrderModal.tsx",
      "components/CasesPiecesInput.tsx",
      "components/LineItemRow.tsx",
    ]);
  });
});
