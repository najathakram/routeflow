/**
 * S19b integration review MUST-1: the order-edit page's unit picker is fed the customer's price layer, so a unit pick takes
 * the layer's price (not the ladder's) and the line's SPECIAL judgement is per line. Flag off (no `layerOf`) is master's pick.
 * Harness: unit-picker-mount.test.tsx.
 */
import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { EditableLineItems, buildItemUpdates, type EditItemState } from "./page";

let mockDefaultSelling = false;
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({
    data: [
      {
        id: "u1",
        label: "Case",
        factorToBase: 192,
        price: "7680.00",
        priceTier2: "7200.00",
        priceTier3: null,
        priceTier4: null,
        priceTier5: null,
        isDefaultSelling: mockDefaultSelling,
        sortOrder: 0,
      },
    ],
  }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));

const PACK_ROW = {
  ref: "pack",
  label: null,
  price: 36,
  listPrice: 40,
  source: "customer",
  aboveList: false,
};
// ladder tier 2 Case $7200; the customer's typed Case price $6800 (list $7680)
const CASE_ROW = {
  ref: "u1",
  label: "Case",
  price: 6800,
  listPrice: 7680,
  source: "customer",
  aboveList: false,
};
const LAYER = [PACK_ROW, CASE_ROW] as never;

const packLine = (): EditItemState => ({
  id: "li-pack",
  originalProductId: "p-case",
  originalProductName: "Widget",
  originalQty: 24,
  productId: "p-case",
  productName: "Widget",
  qty: 24,
  unitPrice: 36,
  basePrice: 40,
  originalUnitPrice: 36,
  cancelled: false,
  unit: "Box",
  unitsPerBox: 24,
  boxSplit: false,
  priceType: "SPECIAL",
});

function renderRow(
  items: EditItemState[],
  extra: Partial<React.ComponentProps<typeof EditableLineItems>> = {},
  onChange: (items: EditItemState[]) => void = () => {},
) {
  return renderWithProviders(
    <EditableLineItems
      items={items}
      onChange={onChange}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice={false}
      tierPriceFor={() => 36}
      isSpecialTierFor={() => true}
      tierForProductId={() => 2}
      pricingReady
      {...extra}
    />,
  );
}

describe("order edit: a unit pick takes the customer's layer price", () => {
  it("with a layer the Case pick sends the layer's $6800 (baseline $6800, list $7680), not the ladder's $7200", () => {
    let captured: EditItemState[] = [];
    renderRow([packLine()], { layerOf: () => LAYER }, (i) => (captured = i));
    fireEvent.change(screen.getByRole("combobox", { name: /Sell Widget by/i }), {
      target: { value: "Case" },
    });
    const u = captured[0]!;
    expect(u.unitLabel).toBe("Case");
    expect(u.unitPrice).toBe(6800);
    expect(u.reasonBaselinePrice).toBe(6800);
    expect(u.basePrice).toBe(7680);
  });

  it("the dropdown itself lists the Case at the layer's price", () => {
    renderRow([packLine()], { layerOf: () => LAYER });
    const picker = screen.getByRole("combobox", { name: /Sell Widget by/i }) as HTMLSelectElement;
    const text = Array.from(picker.options).map((o) => o.textContent ?? "");
    expect(text.some((t) => t.includes("Case") && t.includes("6,800.00"))).toBe(true);
  });

  it("flag off (no layerOf): master's ladder price $7200, byte for byte", () => {
    let captured: EditItemState[] = [];
    renderRow([packLine()], {}, (i) => (captured = i));
    fireEvent.change(screen.getByRole("combobox", { name: /Sell Widget by/i }), {
      target: { value: "Case" },
    });
    expect(captured[0]!.unitPrice).toBe(7200);
  });

  it("a layer with no row for the unit falls back to the ladder", () => {
    let captured: EditItemState[] = [];
    renderRow([packLine()], { layerOf: () => [PACK_ROW] as never }, (i) => (captured = i));
    fireEvent.change(screen.getByRole("combobox", { name: /Sell Widget by/i }), {
      target: { value: "Case" },
    });
    expect(captured[0]!.unitPrice).toBe(7200);
  });
});

describe("order edit: a NEW line that starts on the default unit takes the same path", () => {
  it("startOnDefaultUnit applies the Case at the layer's $6800, not the ladder's $7200", () => {
    mockDefaultSelling = true;
    try {
      let captured: EditItemState[] = [];
      const fresh: EditItemState = {
        ...packLine(),
        id: "new-1",
        isNew: true,
        startOnDefaultUnit: true,
      };
      renderRow([fresh], { layerOf: () => LAYER }, (i) => (captured = i));
      expect(captured[0]?.unitLabel).toBe("Case");
      expect(captured[0]?.unitPrice).toBe(6800);
    } finally {
      mockDefaultSelling = false;
    }
  });
});

describe("order edit, flag off: a stored MANUAL unit line keeps its price (master)", () => {
  it("a loaded MANUAL Case line at $410 is not re-priced to the ladder's $7200-class price and Save sends nothing", () => {
    const stored: EditItemState = {
      ...packLine(),
      id: "li-case",
      unitLabel: "Case",
      unitsPerBox: 192,
      qty: 2,
      originalQty: 2,
      unitPrice: 410,
      basePrice: 410,
      originalUnitPrice: 410,
      priceType: "MANUAL",
    };
    const onChange = jest.fn();
    renderRow([stored], {}, onChange);
    expect(onChange).not.toHaveBeenCalled();
    const original = [
      {
        id: "li-case",
        qty: 2,
        unitPrice: "410",
        unitLabel: "Case",
        unitsPerBox: 192,
        productId: "p-case",
      },
    ] as never;
    expect(buildItemUpdates([stored], original)).toEqual([]);
  });
});

describe("order edit: the SPECIAL judgement is per line", () => {
  it("isSpecialTierFor is asked WITH the line, so a Case line can answer with the Case row", () => {
    const isSpecialTierFor = jest.fn(() => true);
    const caseLine: EditItemState = {
      ...packLine(),
      id: "li-case",
      unitLabel: "Case",
      unitsPerBox: undefined,
    };
    renderRow([caseLine], { isSpecialTierFor, canEditPrice: true, layerOf: () => LAYER });
    const withLine = isSpecialTierFor.mock.calls.filter(
      (c) =>
        (c as unknown[])[1] &&
        (c as unknown as [unknown, { unitLabel?: string }])[1].unitLabel === "Case",
    );
    expect(withLine.length).toBeGreaterThan(0);
  });
});

describe("order edit page wiring (static)", () => {
  const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  it("the page hands the layer to the editable lines and the picker", () => {
    expect(src).toMatch(/layerOf=\{priceLayer\.layerOf\}/);
    expect(src).toMatch(
      /<OrderLineUnitPicker[\s\S]{0,2500}layer=\{layerOf\?\.\(item\.productId\)\}/,
    );
  });
  it("the save-time reason check judges each line through its own unit row", () => {
    expect(src).toMatch(/isSpecialTierForProductId\(it\.productId, it\)/);
  });
  it("Save Draft, Publish Order and Save Changes are held while the layer is unconfirmed (M3)", () => {
    expect(src).toMatch(/const layerBlocked = /);
    const held = src.match(/disabled=\{layerBlocked/g) ?? [];
    expect(held.length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/<PriceLayerNotice/);
  });
});
