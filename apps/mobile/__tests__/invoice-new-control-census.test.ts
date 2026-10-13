import { readFileSync } from "fs";
import { join } from "path";

/**
 * VU-4b P1: control census. Every operator-visible string the New-invoice screen and BoxedQtyBand
 * carried at the base commit (a14627e85, extracted from `git show` of the two files: JSX text,
 * quoted and backtick literals with a letter, minus code fragments) must still be in the source:
 * the unit picker is an ADDITION, so REMOVED must be empty. Frozen as literal lists (not a live
 * `git show`) so the guard does not depend on a ref surviving in a shallow clone.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

const NEW_TSX_BASE: string[] = [
  "+ Add deposit",
  "+ units",
  "A line's discount is larger than the line itself.",
  "A one-off line that isn't in your catalog.",
  "Add an unlisted item",
  "Add at least one item",
  "Add extra loose units",
  "Add note",
  "Add to invoice",
  "Add unlisted item",
  "All",
  "Back",
  "Bad deposit due date",
  "Bad due date",
  "Bad issue date",
  "Browse catalogue",
  "Browse the full catalogue",
  "Cancel",
  "Cases",
  "Change",
  "Check line discounts",
  "Close the catalogue",
  "Couldn't create invoice",
  "Couldn't record the sale",
  "Create",
  "Create invoice",
  "Create order",
  "Creates a pending order with a draft invoice. Stock is deducted now; the invoice unlocks for sending once the order is delivered.",
  "Custom",
  "Customer",
  "Delivered today?",
  "Deposit %",
  "Deposit due date",
  "Deposit incomplete",
  "Discard",
  "Discard invoice?",
  "Discount",
  "Discount too large",
  "Due date",
  "Extra loose units",
  "INVOICE TOTAL",
  "Invoice details",
  "Issue date (backdate)",
  "Item description",
  "Keep adding",
  "Line total",
  "New invoice",
  "No customers match.",
  "No customers yet.",
  "No items.",
  "Note for this item (prints on invoice)",
  "OPERATOR",
  "PO / reference (optional)",
  "Payment terms",
  "Price",
  "Promise",
  "Qty",
  "Reason (required)",
  "Reason needed",
  "Record sale",
  "Records the sale now: the order is marked delivered, stock is deducted, and the invoice is issued and sent. Available customer credit is applied automatically.",
  "Reference number",
  "Remove deposit",
  "Remove extra units",
  "Review invoice",
  "SEPARATE_INVOICE",
  "Sale recorded \u2014 open the invoice from the Invoices tab.",
  "Saving\u2026",
  "Scan items",
  "Search customers\u2026",
  "Search items\u2026",
  "Send immediately on create",
  "Shipping",
  "Shown on the invoice header (optional)",
  "Split into invoice",
  "Strawberry",
  "Subject",
  "Subtotal",
  "TENANT_ADMIN",
  "Tap + on any product to start the invoice.",
  "Tax",
  "Taxable (8.25%)",
  "The day the invoice was actually issued. Leave blank for today.",
  "The deposit amount is this percent of the invoice total, due by its own date.",
  "The lines on this invoice will be lost.",
  "Touched",
  "Try again.",
  "UNIT",
  "Unit price",
  "Unlisted item",
  "Use the format YYYY-MM-DD, or leave it blank for today.",
  "Use the format YYYY-MM-DD.",
  "Which one?",
  "YYYY-MM-DD",
  "Yes",
  "a background refetch re-settled",
  "a regulated item bills on its own invoice",
  "active",
  "already added",
  "an unlisted item needs a name and price",
  "clearSearch",
  "discount",
  "discounted price",
  "dueDate",
  "e.g. Delivery surcharge",
  "groupOrderLinesForInvoicing",
  "handleBack",
  "hasUnlistedInvalid",
  "invoice so far",
  "invoice.defaultTerms",
  "invoiceLines",
  "isSuccess",
  "items",
  "latest deps",
  "limit: 0",
  "mergeProductIndex",
  "note",
  "productById",
  "qty",
  "regulated categories haven't loaded yet",
  "resolveProductByCode",
  "router.back()",
  "saleControlEnabled",
  "saleEligible",
  "saving",
  "search",
  "searchTerm",
  "sending now without delivery",
  "separateInvoiceCategoryIds",
  "snapshot",
  "taxable",
  "totals",
  "undefined",
  "unitPrice",
  "unlisted",
  "visibleCatalogRows",
  "{ description, qty, unitPrice }",
];

const BAND_BASE: string[] = [
  "+ units",
  "Add extra loose units",
  "Cases",
  "Edit",
  "Loose containers",
  "Remove extra units",
];

const removed = (base: string[], src: string) => base.filter((t) => !src.includes(t));

describe("VU-4b P1: no control text removed", () => {
  const screen = read("app", "(operator)", "(tabs)", "invoices", "new.tsx");
  const band = read("components", "BoxedQtyBand.tsx");

  it("the census is non-empty (a zero-candidate census is an error, not a pass)", () => {
    expect(NEW_TSX_BASE.length).toBeGreaterThan(100);
    expect(BAND_BASE.length).toBeGreaterThan(5);
  });

  it("the check can fail: a string absent from the source is reported as removed", () => {
    expect(removed(["__never_in_source__"], screen)).toEqual(["__never_in_source__"]);
  });

  it("invoices/new.tsx: REMOVED is empty", () => {
    expect(removed(NEW_TSX_BASE, screen)).toEqual([]);
  });

  it("BoxedQtyBand.tsx: REMOVED is empty", () => {
    expect(removed(BAND_BASE, band)).toEqual([]);
  });
});
