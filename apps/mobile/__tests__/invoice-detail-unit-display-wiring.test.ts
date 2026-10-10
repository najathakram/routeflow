import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned: the operator invoice detail screen must import invoiceLineQtyText from
// @routeflow/pricing (the one shared formatter — the local mobile copy got the factor-1
// unit case wrong, a bare "5" instead of "5 Piece") and route a line through the unit
// form via usesUnitDisplay, not a bare boxes/pieces check (#1275 review round).
describe("invoice detail screen: shared formatter + unit-display routing (#1275 review round)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/(tabs)/invoices/[id].tsx"),
    "utf8",
  );

  it("imports invoiceLineQtyText from @routeflow/pricing, not the local invoice-line-display module", () => {
    expect(src).toMatch(/import\s*\{[^}]*invoiceLineQtyText[^}]*\}\s*from\s*"@routeflow\/pricing"/);
    const localImport = src.match(
      /import\s*\{([^}]*)\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/invoice-line-display"/,
    );
    expect(localImport).not.toBeNull();
    expect(localImport![1]).not.toMatch(/invoiceLineQtyText/);
  });

  it("imports usesUnitDisplay from the local invoice-line-display module", () => {
    expect(src).toMatch(/usesUnitDisplay/);
    const localImport = src.match(
      /import\s*\{([^}]*)\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/invoice-line-display"/,
    );
    expect(localImport).not.toBeNull();
    expect(localImport![1]).toMatch(/usesUnitDisplay/);
  });

  it("routes the item row through usesUnitDisplay(it), not a bare boxes/pieces check", () => {
    const at = src.indexOf("invoiceLineQtyText(it)");
    expect(at).toBeGreaterThan(-1);
    const ternaryStart = src.lastIndexOf("?", at);
    const conditionStart = src.lastIndexOf("\n", src.lastIndexOf("\n", ternaryStart) - 1);
    const condition = src.slice(conditionStart, ternaryStart);
    expect(condition).toMatch(/usesUnitDisplay\(it\)/);
  });
});
