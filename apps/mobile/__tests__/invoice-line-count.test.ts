import { readFileSync } from "fs";
import { join } from "path";
import { invoiceLineCount, lineCountLabel } from "../lib/invoice-line-count";

/**
 * Row 440: the New-invoice review header read "24 items" for ONE boxed line (it summed pieces). The
 * header and the footer count LINES; the piece total still gates Create.
 */
describe("invoiceLineCount (row 440)", () => {
  it("one boxed line of 24 pieces is one line", () => {
    expect(invoiceLineCount([24], [])).toBe(1);
  });

  it("counts every line with a quantity, catalog and unlisted, and skips empty ones", () => {
    expect(invoiceLineCount([24, 0, 3], [{ qty: 2 }, { qty: 0 }])).toBe(3);
  });

  it("labels singular and plural", () => {
    expect(lineCountLabel(1)).toBe("1 item");
    expect(lineCountLabel(3)).toBe("3 items");
    expect(lineCountLabel(0)).toBe("0 items");
  });
});

describe("the New-invoice screen reads the line count (source-pinned; Jest here is pure-logic only)", () => {
  const screen = readFileSync(
    join(__dirname, "..", "app", "(operator)", "(tabs)", "invoices", "new.tsx"),
    "utf8",
  );

  it("the review header and the footer show lineCount, never the piece total", () => {
    expect(screen).toMatch(/lineCountLabel\(lineCount\)/);
    expect(screen).not.toMatch(/\{totalItems\} item\{totalItems === 1/);
    expect(screen).not.toMatch(/\{totalItems\} ITEM\{totalItems === 1/);
  });
});
