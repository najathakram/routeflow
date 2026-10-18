import * as fs from "fs";
import * as path from "path";

/**
 * T38 (units v2, S11): a feature-parity inventory of today's product page. Every control the
 * page offers has a named home; adding the v2 grid must not take one away. Source pins, because
 * page.tsx is ~2.4k lines and not worth mounting.
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const page = read("page.tsx");

/** Cards/controls mounted by the page today, each with the file that owns its controls. */
const MOUNTED: Array<[tag: string, file: string]> = [
  ["ProductHeaderLine", "ProductHeaderLine.tsx"],
  ["ProductHeaderControls", "ProductHeaderControls.tsx"],
  ["ProductStockCostCard", "ProductStockCostCard.tsx"],
  ["ProductLabelsCard", "ProductLabelsCard.tsx"],
  ["ProductPortalVisibilityCard", "ProductPortalVisibilityCard.tsx"],
  ["ProductUnitsCard", "ProductUnitsCard.tsx"],
  ["DemandCard", "DemandCard.tsx"],
  ["SalesHistoryCard", "SalesHistoryCard.tsx"],
  ["ProductInsightsExport", "ProductInsightsExport.tsx"],
  ["LegacyVariantsActions", "LegacyVariantsActions.tsx"],
  ["PiecesPerBoxValue", "PiecesPerBoxValue.tsx"],
  ["ProductMerchandising", "ProductMerchandising.tsx"],
];

describe("product page parity inventory (T38)", () => {
  it.each(MOUNTED)("%s is still mounted by the page and its file exists", (tag, file) => {
    expect(page).toMatch(new RegExp(`<${tag}[\\s>]`));
    expect(fs.existsSync(path.join(__dirname, file))).toBe(true);
  });

  it("the old Units card stays mounted whenever the page is not a v2 family", () => {
    expect(page).toMatch(/const v2Family = v2 && product\.kind === "FAMILY";/);
    // K10d: the v2 flag also drops the old always-open Add form (the shell's Add a unit replaces it)
    expect(page).toMatch(
      /\{!v2Family && <ProductUnitsCard product=\{product\} hideAddForm=\{v2\} \/>\}/,
    );
  });

  it("with the flag on and a non-FAMILY product, the v2 grid AND the old units card both render", () => {
    // K11-20c: the section sits in ProductPricingRegion (the inline edit mode's full-width wrapper)
    expect(page).toMatch(
      /\{v2 && product\.kind !== "FAMILY" \? \(\s*<ProductPricingRegion>\s*<ProductPricingV2 product=\{product\} \/>\s*<\/ProductPricingRegion>\s*\) : null\}/,
    );
    // the old card's gate never mentions v2 except to hide it for a v2 FAMILY
    const oldGate = page.match(/\{([^{}]*)<ProductUnitsCard/);
    expect(oldGate?.[1]).toBe("!v2Family && ");
  });

  it("the v2 shell is mounted exactly once, only behind the flag", () => {
    expect(page.match(/<ProductPricingV2/g)?.length).toBe(1);
    const upTo = page.slice(0, page.indexOf("<ProductPricingV2"));
    expect(upTo.split("\n").slice(-3, -2)[0]).toMatch(/\{v2 && /);
  });

  it("the old Units card keeps its edit controls (name, price, tiers, default, save, remove)", () => {
    const card = read("ProductUnitsCard.tsx");
    for (const needle of ["} name`", "} price`", "onMakeDefault", "Save", "Remove", "Cancel"]) {
      expect(card).toContain(needle);
    }
  });

  it("K11-22: every header action is in the sm+ button set AND in the phone More menu", () => {
    const src = read("ProductHeaderControls.tsx");
    // one descriptor list feeds both renders, so an action cannot reach one and miss the other
    expect(src).toMatch(/actions\.map\(\(a\) => \(\s*<Button/);
    expect(src).toMatch(/actions\.map\(\(a\) => \(\s*<DropdownMenu\.Item/);
    for (const label of [
      "Make variant of…",
      "Deactivate",
      "Reactivate",
      "Mark as tobacco",
      "Unmark tobacco",
    ]) {
      expect(src).toContain(label);
    }
    // Delete exists twice: the danger-outline button and the red menu item, both calling onRequestDelete
    expect(src.match(/onRequestDelete/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain('aria-label="More actions"');
  });

  it("K11-22: the Details header is one row on a phone (Edit and the menu share it)", () => {
    // the two classes that forced Edit and the actions onto their own rows below sm are gone
    expect(page).not.toMatch(/max-sm:w-full max-sm:justify-start/);
    expect(page).not.toMatch(/<div className="max-sm:basis-full">\s*<EditButton/);
    expect(page).toMatch(/<EditButton onClick=\{startEdit\} \/>/);
  });

  it("K11-22: the Details header is at most 64 px tall on a phone (44 px controls + max-sm:py-2), and the page tells the controls when the delete confirm is open", () => {
    expect(page).toMatch(/border-b border-surface-border px-5 py-3\.5 max-sm:py-2/);
    expect(page).toMatch(/deleteOpen=\{showDeleteConfirm\}/);
  });
});

/**
 * K11-20c: with the flag on and a product the price window can edit, the legacy card and Details stop editing prices.
 * Each row of K11-20 section 4 is pinned at the place it lives after the change (source pins; the behaviour is in
 * ProductUnitsCard.k11-20c.test.tsx, PriceWindowHost.test.tsx and page.k11-20c.test.tsx).
 */
describe("K11-20c: where every legacy-card control lives after the change (section 4)", () => {
  const card = read("ProductUnitsCard.tsx");
  const figs = read("PriceFigures.tsx");

  it.each([
    ["1 Unit Name input", card, "aria-label={`${unit.label} name`}"],
    ["2 factor input", card, 'aria-label={isPiece ? "Smallest unit size"'],
    ["3 per-row Save and Cancel", card, "onClick={() => onSave(unit, draft)}"],
    ["3 a v2 row never sends a price key", card, "const dirtyPrice = (i: number) => !figures &&"],
    ["4 retail figure opens the window", card, "{figure(1)}"],
    [
      "4 the figure is a button named Edit {tier} {unit} price",
      figs,
      "aria-label={`Edit ${productTierLabel(names, tier)} ${row.label} price`}",
    ],
    ["5 Tier prices disclosure stays", card, "Tier prices</summary>"],
    ["5 four tier figures", card, "{figure(t as (typeof TIERS)[number])}"],
    [
      "6 helper sentence replaced by the Auto or Set word",
      figs,
      '{cell.source === "set" ? "Set" : "Auto"}',
    ],
    ["7 default order unit radio per row", card, "Default order unit\n        </label>"],
    ["8 Remove per row", card, "hideRemove"],
    ["9 pack figure reads the grid's pack row", card, "row={packRowOf(grid)}"],
    ["10 pack Default order unit radio", card, "checked={noneDefault}"],
    ["11 Couldn't load units, Try again", card, "Try again"],
    [
      "12 Add unit: Name and factor stay, Price hidden in v2",
      card,
      '{!figures && (\n              <div>\n                <label className={LABEL} htmlFor="new-unit-price">',
    ],
    [
      "13 cascade never offered when no price moved",
      card,
      "if (!figures) setProposals(proposeCascade(",
    ],
    ["14 Remove confirm dialog", card, "Its prices are deleted."],
    ["15 header Edit prices button", card, "Edit prices\n            </button>"],
    ["15 saved line under it", card, 'surface="window"'],
  ])("%s", (_row, src, needle) => {
    expect(src).toContain(needle as string);
  });

  it.each([
    [
      "Details Set all to Retail: MOVED to the window's Change prices (Raise/Lower, Also update)",
      "Change prices",
    ],
    [
      "Details case-price field: MOVED to the Retail box of the Case row in the window and the grid",
      "Edit prices",
    ],
    [
      "Details ≈ $x / piece hint: MOVED to the grid's per-unit rows (the Piece row shows it)",
      "Piece",
    ],
  ])("%s", (_row, needle) => {
    // In v2 these Details controls are gone (see the next test); each has a named home that still renders.
    const win = read("units-v2/window/PriceEditWindow.tsx");
    const grid = read("ProductPricesGrid.tsx");
    expect(win + grid + figs + read("units-v2/edit/EditablePricesGrid.tsx")).toContain(needle);
    // and in v2 Details, the legacy controls are not rendered
    expect(page).toContain("{!isFamily && !pricesInWindow && priceEachRow}");
    expect(page).toMatch(/pricesInWindow \? \(\s*<DetailsPriceLine/);
  });

  it("the flag-off card and Details keep every price input path", () => {
    expect(card).toContain("aria-label={`${unit.label} price`}");
    expect(card).toContain('id="new-unit-price"');
    expect(page).toContain("{!isFamily && !pricesInWindow && priceEachRow}");
    expect(page).toContain("Set all to {tierOneLabel(tierLabels)}");
    expect(page).toMatch(
      /pricesInWindow\s*\? \{\}\s*: \{ \.\.\.detailsPricePatch\(product, draft, pricesWhenEditStartedRef\.current\) \}/,
    );
  });

  it("Details in v2 shows the one price line, and a governed product never gets it", () => {
    expect(page).toContain("const pricesInWindow = v2 && !unitStructureGoverned(product);");
    expect(page).toMatch(/pricesInWindow \? \(\s*<DetailsPriceLine/);
    expect(read("PriceFigures.tsx")).toContain("Save or cancel Details first");
  });

  it("the covered image column is marked for the inline full-width region, dims while inert, and the Details heading is the figures' fallback", () => {
    expect(page).toContain("data-region-covers");
    // dimmed only while inert (the region is wide at lg+), faded in 200 ms, and not at all under reduced motion
    expect(page).toContain("lg:[&[inert]]:opacity-40");
    expect(page).toContain("motion-safe:lg:transition-opacity");
    expect(page).toContain("motion-safe:lg:duration-200");
    expect(page).toContain('data-testid="product-details-heading"');
    expect(page).toMatch(/<DetailsPriceLine[\s\S]*?fallback=\{/);
  });

  it("the page mounts the price host once, around the whole page", () => {
    expect(page.match(/<PriceWindowHost /g)?.length).toBe(1);
    expect(page).toContain("<PriceWindowHost product={product} enabled={pricesInWindow}>");
  });
});
