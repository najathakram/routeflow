import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1026 B-G1: printing an invoice has ONE implementation, `usePrintInvoice` (lib/use-print-invoice.ts). The invoice page,
 * the invoices list row and the send-invoice modal call it instead of keeping a private fetch-and-print copy, so the count of
 * `printPdfBlob(` calls outside the hook and the packing-slip batch is zero. Shrink-only.
 */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("usePrintInvoice is the one invoice-printing path (B-G1)", () => {
  it("the hook is the one place that prints an invoice PDF", () => {
    expect(count(read("lib/use-print-invoice.ts"), "printPdfBlob(")).toBe(1);
  });

  it.each([
    "app/(dashboard)/invoices/[id]/page.tsx",
    "app/(dashboard)/invoices/page.tsx",
    "app/(dashboard)/orders/[id]/_components/SendInvoiceModal.tsx",
  ])("%s calls the hook, not printPdfBlob directly", (rel) => {
    const src = read(rel);
    expect(src).toContain("usePrintInvoice");
    expect(count(src, "printPdfBlob(")).toBe(0);
  });
});
