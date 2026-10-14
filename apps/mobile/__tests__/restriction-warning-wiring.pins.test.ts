import * as fs from "fs";
import * as path from "path";

/**
 * Row 510, L-305: the mobile staff write flows are ENUMERATED BY SEARCH. Every non-test source that calls a staff write
 * hook of the plan's path inventory must be wired to the warning modal (`useRestrictionWarningRetry`: it sends
 * `rw.attach(...)`, routes its error through `rw.handle(...)` and renders `rw.modal`), or be on the EXEMPT list with a
 * reason. A flow that forgets the modal would swallow the 409 RESTRICTION_WARNING behind its generic "Couldn't save".
 */
const MOBILE = path.resolve(__dirname, "..");
const STAFF_WRITE_HOOKS = [
  "useCreateOrderAsDriver",
  "useCreateAdminOrder",
  "useCreateSale",
  "useUpdateOrderItems",
  "useChangeOrderStatus",
  "useReopenOrder",
  "useSwitchOrderToDelivery",
  "useCreateInvoice",
  "useUpdateInvoice",
  "useDuplicateInvoice",
  "useConvertEstimateToInvoice",
  "useRunRecurringInvoice",
  "useGenerateTemplateOrder",
];
const CALL = new RegExp(`\\b(${STAFF_WRITE_HOOKS.join("|")})\\b`);

/** file (relative to apps/mobile) -> why it needs no modal. */
const EXEMPT: Record<string, string> = {
  "lib/sale-mode.ts": "a comment names useCreateSale; the file calls no hook",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__" || e.name === ".expo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(MOBILE, p).split(path.sep).join("/");
const read = (f: string) => fs.readFileSync(path.join(MOBILE, f), "utf8");
const callers = ["app", "components", "lib"]
  .flatMap((d) => walk(path.join(MOBILE, d)))
  .filter((p) => !rel(p).startsWith("lib/api/"))
  .filter((p) => CALL.test(fs.readFileSync(p, "utf8")))
  .map(rel);

/** The plan's mobile flow list (section F), by file. */
const PLAN_FLOWS = [
  "components/NewOrderScreen.tsx",
  "app/(operator)/(tabs)/orders/[id]/edit-items.tsx",
  "app/(operator)/(tabs)/orders/[id].tsx",
  "app/(operator)/(tabs)/invoices/new.tsx",
  "app/(operator)/(tabs)/invoices/[id]/edit.tsx",
  "app/(operator)/(tabs)/invoices/[id].tsx",
  "app/(operator)/estimates/[id].tsx",
  "app/(operator)/recurring-invoices/[id].tsx",
  "app/(operator)/order-templates/[id].tsx",
];

describe("row 510: every mobile staff write flow uses the warning hook (search-derived)", () => {
  it("finds every flow the plan lists (a vacuous list would prove nothing)", () => {
    expect(callers).toEqual(expect.arrayContaining(PLAN_FLOWS));
  });

  it.each(callers)("%s", (file) => {
    if (EXEMPT[file]) {
      expect(EXEMPT[file].length).toBeGreaterThan(10);
      return;
    }
    const src = read(file);
    expect(src).toContain("useRestrictionWarningRetry()");
    expect(src).toMatch(/rw\.attach\(/);
    expect(src).toMatch(/rw\.handle\(/);
    expect(src).toContain("{rw.modal}");
  });

  it("the invoice detail's Duplicate and inline edit, and the order detail's reopen, status and path switch, are wrapped", () => {
    const inv = read("app/(operator)/(tabs)/invoices/[id].tsx");
    expect(inv).toMatch(/duplicateMut\.mutate\(rw\.attach\(id\)/);
    expect(inv).toMatch(/updateMut\.mutate\(\s*rw\.attach\(/);
    const ord = read("app/(operator)/(tabs)/orders/[id].tsx");
    expect(ord).toMatch(/reopenMut\.mutate\(rw\.attach\(order\.id\)/);
    expect(ord).toMatch(/changeMut\.mutate\(\s*rw\.attach\(/);
    expect(ord).toMatch(/switchToDeliveryMut\.mutate\(rw\.attach\(order\.id\)/);
  });

  it("the driver path of New order still reaches the 'Ask the office' block through the same hook", () => {
    const src = read("components/NewOrderScreen.tsx");
    expect(src).toMatch(/useCreateOrderAsDriver\(\)/);
    expect(src).toMatch(/rw\.handle\(err, \(\) => submitOrder\(mergeChoice, asDraft\)\)/);
  });
});

describe("row 510: staff-only display", () => {
  it("the note is rendered on the staff order and invoice detail rows", () => {
    expect(read("app/(operator)/(tabs)/orders/[id].tsx")).toContain("<RestrictionOverrideNote");
    expect(read("app/(operator)/(tabs)/invoices/[id].tsx")).toContain("<RestrictionOverrideNote");
  });
  it("no customer (buyer) screen or component mentions the note, the modal or an override column", () => {
    const customerFiles = [
      ...walk(path.join(MOBILE, "app/(customer)")),
      ...walk(path.join(MOBILE, "app/(auth)")),
    ];
    expect(customerFiles.length).toBeGreaterThan(0);
    for (const p of customerFiles) {
      expect(fs.readFileSync(p, "utf8")).not.toMatch(
        /RestrictionOverrideNote|RestrictionWarningModal|useRestrictionWarningRetry|restrictionOverride/,
      );
    }
  });
});
