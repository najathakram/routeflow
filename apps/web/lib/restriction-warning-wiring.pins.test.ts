import * as fs from "fs";
import * as path from "path";

/**
 * Row 510, L-305: the staff write flows are ENUMERATED BY SEARCH, never from memory. Every non-test source that
 * calls a staff write hook of the plan's path inventory must be wired to the warning dialog (it uses
 * `useRestrictionWarningRetry`, or one of the two wrapper hooks that do), or be on the EXEMPT list with a reason.
 * A new flow that calls one of these hooks and forgets the dialog turns this red: its 409 RESTRICTION_WARNING
 * would otherwise be swallowed silently (the code is in HANDLED_CODES), leaving a save that does nothing.
 */
const WEB = path.resolve(__dirname, "..");
const STAFF_WRITE_HOOKS = [
  "useCreateOrder",
  "useUpdateOrderItems",
  "useUpdateOrderStatus",
  "useReopenOrder",
  "usePatchOrderFulfillPath",
  "useCreateSale",
  "usePosFinish",
  "useCreateCounterSale",
  "useCreateInvoice",
  "useUpdateInvoice",
  "useDuplicateInvoice",
  "useConvertEstimateToInvoice",
  "useRunRecurringInvoice",
  "useGenerateTemplateOrder",
];
const CALL = new RegExp(`\\b(${STAFF_WRITE_HOOKS.join("|")})\\b`);
const WIRED =
  /\b(useRestrictionWarningRetry|useDuplicateInvoiceAction|useGenerateTemplateOrderAction)\b/;

/** file (relative to apps/web) -> why it needs no dialog. */
const EXEMPT: Record<string, string> = {
  "app/(dashboard)/orders/page.tsx":
    "bulk CANCEL only (useUpdateOrderStatus with status CANCELLED): a cancel is never judged",
  // the two wrapper hooks themselves call the api hook; the wrapper is what the flows use
  "lib/use-duplicate-invoice-action.ts":
    "the wrapper: it uses useRestrictionWarningRetry (checked below)",
  "lib/use-generate-template-order-action.tsx":
    "the wrapper: it uses useRestrictionWarningRetry (checked below)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "e2e") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(WEB, p).split(path.sep).join("/");
const sources = ["app", "components", "lib", "hooks"]
  .flatMap((d) => walk(path.join(WEB, d)))
  .filter((p) => !rel(p).startsWith("lib/api/"));
const callers = sources.filter((p) => CALL.test(fs.readFileSync(p, "utf8")));

describe("row 510: every staff write flow is wired to the warning dialog (search-derived)", () => {
  it("finds the flows (a vacuous list would prove nothing)", () => {
    expect(callers.map(rel)).toEqual(
      expect.arrayContaining([
        "app/(dashboard)/orders/_components/CreateOrderModal.tsx",
        "app/(dashboard)/orders/[id]/page.tsx",
        "app/(dashboard)/invoices/new/page.tsx",
        "app/(dashboard)/orders/_components/CounterSaleScreen.tsx",
      ]),
    );
  });

  it.each(callers.map(rel))("%s", (file) => {
    const src = fs.readFileSync(path.join(WEB, file), "utf8");
    if (EXEMPT[file]) {
      expect(EXEMPT[file].length).toBeGreaterThan(10); // a reason, not a bare allow
      return;
    }
    expect(src).toMatch(WIRED);
    // the dialog must also be RENDERED, or the hook would open nothing
    expect(src).toMatch(/\b(rw\.dialog|dialog)\b/);
  });

  it("the two wrapper hooks use the shared hook and return its dialog", () => {
    for (const f of [
      "lib/use-duplicate-invoice-action.ts",
      "lib/use-generate-template-order-action.tsx",
    ]) {
      const src = fs.readFileSync(path.join(WEB, f), "utf8");
      expect(src).toContain("useRestrictionWarningRetry");
      expect(src).toMatch(/dialog: rw\.dialog/);
    }
  });

  it("the wrapper hooks' consumers render the dialog they return", () => {
    const inv = fs.readFileSync(path.join(WEB, "app/(dashboard)/invoices/[id]/page.tsx"), "utf8");
    expect(inv).toMatch(/useDuplicateInvoiceAction\(\)/);
    expect(inv).toContain("{duplicateDialog}");
    const cust = fs.readFileSync(path.join(WEB, "app/(dashboard)/customers/[id]/page.tsx"), "utf8");
    expect(cust).toContain("useGenerateTemplateOrderAction");
    expect(cust).toContain("{generateOrder.dialog}");
  });

  it("the buyer portal never builds the staff dialog or note", () => {
    const buyer = walk(path.join(WEB, "app/buyer"));
    for (const p of buyer) {
      const src = fs.readFileSync(p, "utf8");
      expect(src).not.toMatch(
        /RestrictionWarningDialog|useRestrictionWarningRetry|RestrictionOverrideNote/,
      );
    }
  });
});
