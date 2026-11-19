import { readFileSync } from "fs";
import { join } from "path";

// Static guard (PR-1 T8): the Settings > Invoicing preview prints these totals labels in this order.
// If the PDF template renames one, update InvoiceLayoutPreview.tsx with it.
describe("invoice-pdf-template totals labels", () => {
  const src = readFileSync(join(__dirname, "invoice-pdf-template.tsx"), "utf8");

  it("keeps the Total, Amount Paid and Balance Due literals the layout preview mirrors", () => {
    expect(src).toContain(">Total<");
    expect(src).toContain("Amount Paid");
    expect(src).toContain("Balance Due");
    const total = src.indexOf(">Total<");
    const paid = src.indexOf("Amount Paid</Text>");
    const due = src.search(/Balance Due\s*<\/Text>/);
    expect(total).toBeGreaterThan(-1);
    expect(total).toBeLessThan(paid);
    expect(paid).toBeLessThan(due);
  });
});
