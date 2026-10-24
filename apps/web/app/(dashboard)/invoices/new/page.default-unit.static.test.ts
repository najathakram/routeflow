import { readFileSync } from "fs";
import { join } from "path";

/**
 * VU-4a / B1218 P2: source pin for the /invoices/new wiring (the page is too heavy to mount for this).
 * The box / piece picker is the SHARED `OrderLineUnitPicker` and the default selling unit is resolved by
 * the SHARED `useDefaultUnitResolver` + `lib/default-unit-line.ts`: the page holds no second picker and no
 * default-unit logic of its own (Create Order is the reference: CreateOrderModal.default-unit.static.test.ts).
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("/invoices/new default selling unit wiring (VU-4a)", () => {
  it("reuses the one picker and the one resolver hook", () => {
    expect(src).toMatch(
      /import \{[^}]*OrderLineUnitPicker[^}]*\} from "@\/components\/OrderLineUnitPicker"/,
    );
    expect(src).toMatch(/useDefaultUnitResolver\(/);
    expect(src).toMatch(/<OrderLineUnitPicker/);
  });

  it("builds no second picker and re-derives no default-unit rule locally", () => {
    expect(src).not.toMatch(/from "@\/components\/UnitPicker"/);
    expect(src).not.toMatch(/<UnitPicker\b/);
    expect(src).not.toMatch(
      /function (defaultUnitValue|resolveDefaultUnit|applyUnitToLines|buildUnitOptions)\b/,
    );
    expect(src).not.toMatch(
      /const (defaultUnitValue|resolveDefaultUnit|applyUnitToLines|buildUnitOptions)\b/,
    );
    expect(src).toMatch(/from "@\/lib\/default-unit-line"/);
  });

  it("the unit read is staff-only (the same gate Create Order uses)", () => {
    expect(src).toMatch(/isStaffRole\(/);
  });
});
