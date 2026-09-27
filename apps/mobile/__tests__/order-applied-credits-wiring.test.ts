import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2404 (P0, epic #2400, SA-436 PR-3), mobile mirrors web: the operator order screen lists
 * EVERY credit actually on the order's invoices (automatic and manual, each with its invoice)
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

  it("shows the invoice and Automatic / Manual for an applied credit, and pending picks", () => {
    expect(panel).toMatch(/row\.invoiceNumber/);
    expect(panel).toMatch(/"Automatic"/);
    expect(panel).toMatch(/"Manual"/);
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
});
