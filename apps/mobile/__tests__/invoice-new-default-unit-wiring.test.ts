import { readFileSync } from "fs";
import { join } from "path";

/**
 * VU-4b W1: Jest here is pure-logic only, so the New-invoice screen's wiring is source-pinned (house
 * precedent: new-order-default-unit-wiring.test.ts). The screen holds CALL SITES only; every decision
 * lives in lib/invoice-unit-pick.ts and the shared Create Order helpers, which are reused, never forked.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
const screen = read("app", "(operator)", "(tabs)", "invoices", "new.tsx");
const row = read("components", "UnitPickerRow.tsx");
const orders = read("lib", "api", "orders.ts");

const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe("VU-4b: the New-invoice screen reuses Create Order's unit machinery", () => {
  it("imports the shared pieces and the one new module (no forked copy)", () => {
    for (const name of [
      "UnitPickerRow",
      "useDefaultUnitResolver",
      "applyAddToItems",
      "reserveAdd",
      "editItemLine",
      "settleBeforeConfirm",
      "anyLineLoading",
      "UNITS_BLOCKED_MESSAGE",
      "refusedScanOutcome",
      "scanAcceptOpts",
      "needsUnitLabelConfirm",
      "stepLineQty",
      "chooseInvoiceUnit",
      "pickerLineOf",
      "invoiceTotalsLine",
      "invoiceItemDto",
      "saleItemDto",
      "dropStaleUnitLines",
      "unitNotOfferedCode",
      "UNIT_NOT_OFFERED_MESSAGE",
    ]) {
      expect(screen).toContain(name);
    }
    expect(screen).toMatch(/from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/invoice-unit-pick"/);
    expect(screen).not.toMatch(/^type LineState = \{/m); // the local, unit-less line state is gone
    expect(screen).toMatch(/InvoiceLineState/);
  });

  it("the picker is mounted exactly once, in ReviewRow, after the price block and before the qty controls", () => {
    expect(screen.match(/<UnitPickerRow/g)).toHaveLength(1);
    const reviewRow = screen.slice(screen.indexOf("function ReviewRow("));
    const at = reviewRow.indexOf("<UnitPickerRow");
    expect(at).toBeGreaterThan(reviewRow.indexOf('placeholder="Reason (required)"'));
    expect(at).toBeLessThan(reviewRow.indexOf('label="Cases"'));
    expect(at).toBeLessThan(reviewRow.indexOf("Qty ("));
    expect(reviewRow.slice(at, at + 700)).toMatch(/marginBottom: 8/);
    expect(reviewRow).toMatch(/pickerLineOf\(/);
    expect(reviewRow).toMatch(/onChange=\{onChangeUnit\}/);
  });

  it("staff only: the picker and the default-start resolver are gated on isStaffRole", () => {
    expect(screen).toMatch(/isStaffRole\(userRole\)/);
    expect(screen).toMatch(/useDefaultUnitResolver\(\s*items,[\s\S]*?\),\s*isStaff,/);
    expect(screen).toMatch(/isStaff \?|isStaff &&|\{isStaff/);
  });

  it("has no Case|Unit switch, and the qty copy for Piece and level lines is the brief's", () => {
    expect(screen).not.toMatch(/SellByToggle/);
    expect(screen).toContain("Total pieces");
    expect(screen).toMatch(/pcs per box/);
    expect(screen).toMatch(/Qty \(\$\{line\.unitLabel\}\)/);
    expect(screen).toMatch(/Price \/ \$\{line\.unitLabel\}/);
    expect(screen).toMatch(/\$\{line\.unitLabel\} of \$\{line\.unitFactor\}/);
  });

  it("removeOne steps the unit-aware way: editItemLine + stepLineQty(-1), never decrementLine", () => {
    const removeOne = between(screen, "const removeOne = ", "const setBoxes");
    expect(removeOne).toMatch(/editItemLine\(/);
    expect(removeOne).toMatch(/stepLineQty\(prev, -1,/);
    expect(removeOne).not.toMatch(/decrementLine/);
    expect(screen).not.toMatch(/\bdecrementLine\b/);
  });

  it("addOne is the Create Order shape: reserveAdd over a latest-lines ref, then applyAddToItems", () => {
    const addOne = between(screen, "const addOne = ", "const upbNum");
    expect(addOne).toMatch(/reserveAdd\(itemsRef, input\)/);
    expect(addOne).toMatch(/setItems\(\(m\) => applyAddToItems\(m, input\)\)/);
    expect(screen).toMatch(/const itemsRef = useRef\(items\)/);
    expect(screen).toMatch(/scanAcceptOpts\(code, match\)/);
    expect(screen).toMatch(/refusedScanOutcome\(scanOpen\)/);
    expect(screen).toMatch(/add: \(id: string\) => addOne\(id, undefined, "BOX", true, true\)/);
  });

  it("every qty/price writer routes through editItemLine so a pending line refuses the edit", () => {
    for (const w of ["setBoxes", "setPieces", "setUnits", "setQty", "setLinePrice"]) {
      const body = between(screen, `const ${w} = `, "\n\n");
      expect(body).toMatch(/editItemLine\(/);
    }
  });

  it("the factor-1 Piece guard runs on the resolver's updates AND on the submit-time resolve", () => {
    expect(screen).toContain("normalizeInvoiceUnitLines");
    const hook = between(screen, "useDefaultUnitResolver(", "const anyUnitLoading");
    expect(hook).toMatch(/normalizeInvoiceUnitLines\(/);
    expect(hook).toMatch(
      /setItems\(\(m\) =>\s*withUnitListPrices\(\s*normalizeInvoiceUnitLines\(fn\(m\)/,
    );
    const onSave = between(screen, "const onSave = ", "const unlistedPlacement");
    expect(onSave).toMatch(/normalizeInvoiceUnitLines\(settled\.lines/);
  });

  it("a refused unit resets only the lines whose label the refreshed ladder no longer offers", () => {
    const fn = between(screen, "const onUnitNotOffered = ", "const onSave = ");
    expect(fn).toMatch(/await Promise\.all\(/);
    expect(fn).toMatch(/dropStaleUnitLines\(\s*cur,/);
    expect(fn).toMatch(/staleTime: 0/);
  });

  it("BoxedQtyBand shows only for a pack line (a unit line has no cases/loose)", () => {
    expect(screen).toMatch(/Number\(p\.unitsPerBox \?\? 0\) > 1 && !line\.unitLabel/);
    expect(screen).toMatch(/unitLabel=\{line\?\.unitLabel\}/); // ProductRow prices a unit line per unit
  });

  it("totals, review row and tray read the unit-aware helpers, not the pack-only math", () => {
    const memo = between(screen, "const { invoiceLines, totalItems", "// Full money preview");
    expect(memo).toMatch(/invoiceTotalsLine\(/);
    expect(memo).not.toMatch(/boxes: line\.boxes \?\? null/);
    const reviewRow = screen.slice(screen.indexOf("function ReviewRow("));
    expect(reviewRow).toMatch(/invoiceTotalsLine\(/);
    const tray = between(screen, "const trayRows = useMemo", "Catalog rows and tray rows");
    expect(tray).toMatch(/unitPriceBase\(line, /);
  });

  it("save: the pending-unit gate runs BEFORE either request, blocked sends nothing, Create waits while loading", () => {
    const onSave = between(screen, "const onSave = ", "const unlistedPlacement");
    expect(onSave).toMatch(/await settleBeforeConfirm\(items, resolveDefaultUnits\)/);
    expect(onSave).toMatch(/settled\.kind === "blocked"/);
    expect(onSave).toMatch(/showToast\(UNITS_BLOCKED_MESSAGE\)/);
    const gate = onSave.indexOf('settled.kind === "blocked"');
    expect(gate).toBeLessThan(onSave.indexOf("postSale(saleDto)"));
    expect(gate).toBeLessThan(onSave.indexOf("createMut.mutate("));
    expect(gate).toBeLessThan(onSave.indexOf("Object.entries(lines)"));
    expect(onSave).not.toMatch(/Object\.entries\(items\)/); // prices from the RESOLVED lines
    expect(screen).toMatch(/!anyUnitLoading/);
    expect(screen).toMatch(/mergeResolvedDefaults\(cur, items, lines\)/);
  });

  it("save: both payload builders are the module's, and a level line never gets boxes/pieces from the screen", () => {
    const onSave = between(screen, "const onSave = ", "const unlistedPlacement");
    expect(onSave).toMatch(/saleItemDto\(/);
    expect(onSave).toMatch(/invoiceItemDto\(/);
    expect(onSave).not.toMatch(/saleLinePriceFields/);
    expect(onSave).not.toMatch(/invoiceLineDto\(\s*\{\s*description: displayName/);
  });

  it("UNIT_NOT_OFFERED is handled in BOTH onErrors: message, refetch the ladder, drop to a Box", () => {
    expect(screen.match(/unitNotOfferedCode\(err\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(screen.match(/dropStaleUnitLines\(/g)?.length).toBeGreaterThanOrEqual(1);
    expect(screen).toMatch(/productUnitsKey\(/);
    expect(screen).toMatch(/UNIT_NOT_OFFERED_MESSAGE/);
    expect(screen).toMatch(
      /err\?\.response\?\.data\?\.message \?\? err\?\.message \?\? "Try again\."/,
    );
  });

  it("Edit invoice is untouched: its unit-line refusal stays and the edit screen is not imported", () => {
    expect(screen).not.toMatch(/invoices\/\[id\]\/edit/);
  });
});

describe("VU-4b: shared components and the API type", () => {
  it("UnitPickerRow gets the one-line tap target fix on its trigger", () => {
    expect(row).toMatch(/hitSlop=\{\{ top: 4, bottom: 4 \}\}/);
    expect(row.match(/hitSlop/g)).toHaveLength(1);
  });

  it("CreateSaleItemInput's product arm carries unitLabel", () => {
    const arm = between(orders, "export type CreateSaleItemInput", "{ name: string");
    expect(arm).toMatch(/unitLabel\?: string/);
  });

  it("the module owns the new logic and never writes a unitLabel for Box or Piece", () => {
    const pick = read("lib", "invoice-unit-pick.ts");
    expect(pick).toMatch(/export function chooseInvoiceUnit/);
    expect(pick).toMatch(/applyUnitOption/);
    expect(pick).toMatch(/UNIT_NOT_OFFERED_MESSAGE/);
  });
});

describe("SA nit (b): the default-unit resolver's lines carry the unit's list price", () => {
  it("the resolver's setter stamps unitListPrice from the cached ladder after normalizing", () => {
    const resolver = between(screen, "useDefaultUnitResolver(", "anyLineLoading(");
    expect(resolver).toMatch(/withUnitListPrices\(\s*normalizeInvoiceUnitLines\(fn\(m\)/);
    expect(resolver).toMatch(/unitListPriceFor/);
    const lookup = between(screen, "const unitListPriceFor", "useDefaultUnitResolver(");
    expect(lookup).toMatch(/getQueryData<[^>]*>\(productUnitsKey\(id\)\)/);
    expect(lookup).toMatch(/buildUnitOptions\(/);
    expect(lookup).toMatch(/\.listPrice/);
  });
});

describe("SA nits @9eec5e1b4 (VU-4b PASS-WITH-NITS)", () => {
  const save = between(
    screen,
    "const onSave = async",
    "if (saleMode.eligible) {\n      const saleItems",
  );

  it("(a) the submit-time settle stamps unitListPrice too, not only the background resolver", () => {
    expect(save).toMatch(
      /withUnitListPrices\(\s*normalizeInvoiceUnitLines\(settled\.lines,[\s\S]{0,80}?\),\s*unitListPriceFor,?\s*\)/,
    );
  });

  it("(b) the row's moved-off-special decision reads the unit's own list price first", () => {
    const moved = between(screen, "const movedOffSpecial =", "const qty = effectiveQty(line");
    expect(moved).toMatch(
      /listPrice:\s*line\.unitListPrice\s*\?\?\s*toNumber\(product\.pricePerUnit\)/,
    );
  });

  it("(c) a settle that stops or blocks a save started from the review sheet reopens the sheet", () => {
    const blocked = between(save, 'settled.kind === "blocked"', "return;");
    expect(blocked).toMatch(/if \(fromReview\) setReviewOpen\(true\)/);
    const stop = save.slice(save.indexOf('settled.kind === "stop"'));
    expect(stop.slice(0, 200)).toMatch(/if \(fromReview\) setReviewOpen\(true\);\s*return;/);
  });
});
