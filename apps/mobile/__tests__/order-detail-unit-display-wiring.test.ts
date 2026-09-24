import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned — same approach as invoice-detail-unit-display-wiring.test.ts. Both order
// detail screens must show a units_v1 line's own unit (Case, Pallet, a factor-1 "5 Piece")
// through the ONE shared formatter, never the generic "box"/"boxes" (B757, B759).
describe.each([
  ["operator order detail (B757)", "app/(operator)/(tabs)/orders/[id].tsx", "../../../../lib"],
  ["customer order detail (B759)", "app/(customer)/orders/[id].tsx", "../../../lib"],
])("%s: shared formatter + unit-display routing", (_name, file, libPrefix) => {
  const src = readFileSync(join(__dirname, "..", file), "utf8");

  it("imports invoiceLineQtyText from @routeflow/pricing and no longer hand-formats the split", () => {
    expect(src).toMatch(/import\s*\{[^}]*invoiceLineQtyText[^}]*\}\s*from\s*"@routeflow\/pricing"/);
    expect(src).not.toMatch(/formatQtySplit/);
  });

  it("routes through usesUnitDisplay from the local invoice-line-display module", () => {
    expect(src).toContain(`from "${libPrefix}/invoice-line-display"`);
    expect(src).toMatch(/usesUnitDisplay\(/);
    expect(src).toMatch(/invoiceLineQtyText\(/);
  });
});
