import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2404 (P0, epic #2400, SA-436 PR-3), mobile mirrors web: the operator order screen lists
 * EVERY credit actually on the order's invoices (Automatic or Applied, each with its invoice)
 * plus the picked credits not yet applied, from the SAME shared rule as web
 * (`orderAppliedCredits`, @routeflow/types; its logic is pinned in
 * apps/api/src/common/order-applied-credits.spec.ts), with Remove on an applied credit.
 * Source-pinned: RN screens are not renderable in this jest lane.
 */
const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");

describe("mobile order Applied credits (#2404)", () => {
  const panel = read("components/OrderAppliedCredits.tsx");
  const screen = read("app/(operator)/(tabs)/orders/[id].tsx");

  it("derives its rows from the shared rule, not from the intents alone", () => {
    expect(panel).toMatch(/import \{[^}]*orderAppliedCredits[^}]*\} from "@routeflow\/types"/);
    expect(panel).toMatch(/orderAppliedCredits\(order\)/);
  });

  it("shows the invoice and Automatic / Applied for an applied credit, and pending picks", () => {
    expect(panel).toMatch(/row\.invoiceNumber/);
    expect(panel).toMatch(/"Automatic"/);
    expect(panel).toMatch(/"Applied"/);
    expect(panel).not.toMatch(/"Manual"/); // SA-436 review: no "manual" label
    expect(panel).toMatch(/>Not yet applied</);
  });

  it("Remove confirms, then un-applies that credit from that invoice", () => {
    expect(panel).toMatch(/useUnapplyCreditNote\(\)/);
    const at = panel.indexOf("confirm(");
    expect(at).toBeGreaterThan(-1);
    expect(panel.slice(at)).toMatch(
      /unapply\.mutate\(\s*\{\s*id:\s*row\.creditNoteId,\s*invoiceId:\s*row\.invoiceId\s*\}/,
    );
  });

  it("the order screen renders the panel instead of the intents-only list", () => {
    expect(screen).toMatch(/<OrderAppliedCredits order=\{order\} \/>/);
    expect(screen).not.toMatch(/order\.orderCreditNotes!\.map/);
  });

  it("the order edit screen (credit picker) shows the order's applied credits too, staff only", () => {
    const edit = read("app/(operator)/(tabs)/orders/[id]/edit-items.tsx");
    expect(edit).toMatch(/!isDriver && order \? <OrderAppliedCredits order=\{order as any\} \/>/);
  });

  // SA-436d LOW: after Remove, the order's Applied credits must refresh on mobile too.
  it("the unapply hook invalidates the operator order query the panel reads", () => {
    const api = read("lib/api/credit-notes.ts");
    const at = api.indexOf("export function useUnapplyCreditNote");
    expect(at).toBeGreaterThan(-1);
    const body = api.slice(at, api.indexOf("\n}\n", at));
    expect(body).toMatch(/invalidateQueries\(\{ queryKey: \["admin", "orders"\] \}\)/);
    // …and that is the query useAdminOrder (the order screen) reads.
    expect(read("lib/api/admin.ts")).toMatch(/queryKey: \["admin", "orders", id\]/);
  });

  it("the Remove confirm quotes the (note, invoice) pair total (SA-436 review)", () => {
    expect(panel).toMatch(/un-applies \$\{money\(row\.pairTotal\)\}/);
  });

  it("Remove is disabled while an unapply is pending (SA-436 review)", () => {
    expect(panel).toMatch(/disabled=\{unapply\.isPending\}/);
  });
});
