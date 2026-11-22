import * as fs from "fs";
import * as path from "path";

/**
 * SA-1211 BF-7 sites pin: no api document renderer formats money itself. A PDF file (its path names "pdf") never builds
 * `$${...toFixed(2)}`; money text comes from fmtPdfMoney (common/pdf-money.ts), so grouping and rounding stay in one place.
 * Style: no-bare-cron.spec.ts.
 */
const SRC = path.resolve(__dirname, "..");
const HAND_ROLLED_MONEY = /\$\$\{[^`]*?\.toFixed\(\s*2\s*\)/;

function pdfFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") pdfFiles(full, out);
    } else if (
      /pdf/i.test(e.name) &&
      /\.tsx?$/.test(e.name) &&
      !/\.(spec|test)\.tsx?$/.test(e.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("api document renderers format money through fmtPdfMoney only (BF-7)", () => {
  it("self-test: the pin goes red on a planted hand-rolled site, and not on the helper's use", () => {
    expect(
      HAND_ROLLED_MONEY.test("const fmt = (n: number) => `$${roundMoney(n).toFixed(2)}`;"),
    ).toBe(true);
    expect(HAND_ROLLED_MONEY.test("n < 0 ? `−$${roundMoney(Math.abs(n)).toFixed(2)}` : x")).toBe(
      true,
    );
    expect(HAND_ROLLED_MONEY.test("const fmt = (n: number) => fmtPdfMoney(n);")).toBe(false);
  });

  it("scanned the real PDF files (guards a path typo turning the scan vacuous)", () => {
    const files = pdfFiles(SRC).map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(files).toEqual(
      expect.arrayContaining([
        "invoices/invoice-pdf-template.tsx",
        "invoices/invoice-pdf-item.ts",
        "customers/account-statement-pdf-model.ts",
        "buyer/statement-pdf-template.tsx",
      ]),
    );
  });

  it("no PDF file builds a dollar amount with toFixed(2)", () => {
    const bad = pdfFiles(SRC)
      .filter((f) => HAND_ROLLED_MONEY.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(bad).toEqual([]);
  });
});
