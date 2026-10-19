import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ProductPricingV2 } from "../../ProductPricingV2";

// The shell mounts the units beside the grid only where the unit ladder can be edited (the same gate as Add / Remove).
let mockStructure = true;
jest.mock("./unit-structure", () => ({
  ...jest.requireActual("./unit-structure"),
  useUnitStructureAllowed: () => mockStructure,
}));
jest.mock("../edit/EditablePricesGrid", () => ({
  EditablePricesGrid: (p: { unitControls?: React.ReactNode }) => <div>{p.unitControls}</div>,
}));
jest.mock("./UnitStructure", () => ({
  UnitStructureControls: () => <div data-testid="stub-controls" />,
  UnitRowRemove: () => null,
}));
jest.mock("./UnitsBesideGrid", () => ({
  UnitsBesideGrid: () => <div data-testid="stub-beside" />,
}));
jest.mock("../customer/CustomerPriceView", () => ({ CustomerPriceView: () => null }));
jest.mock("../change-prices/ChangePrices", () => ({
  ChangePrices: () => null,
  useChangePrices: () => ({
    enabled: false,
    open: false,
    toggle: jest.fn(),
    close: jest.fn(),
    opener: { current: null },
  }),
}));
jest.mock("../edit/PriceDraftProvider", () => ({
  PriceDraftProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePriceDraftOptional: () => ({}),
}));
jest.mock("../edit/PriceEditBar", () => ({ PriceEditBar: () => null, BTN: "" }));
jest.mock("../edit/usePriceDraft", () => ({
  usePriceDraft: () => ({ lastSave: null, dirty: false }),
}));
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => ({ data: undefined }) }));
jest.mock("@/lib/api/usePriceWrites", () => ({
  useUndoPrices: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock("../confirm/usePriceUndo", () => ({ usePriceUndo: () => null }));
jest.mock("../confirm/SaveStatusLine", () => ({ PriceSaveStatusLine: () => null }));

const product = { id: "p1", unit: "Box", unitsPerBox: 24, pricePerUnit: "1.00" };

describe("ProductPricingV2 wiring: units beside the grid", () => {
  it("mounts next to Add a unit where the ladder is editable", () => {
    mockStructure = true;
    render(<ProductPricingV2 product={product} />);
    expect(screen.getByTestId("stub-controls")).toBeInTheDocument();
    expect(screen.getByTestId("stub-beside")).toBeInTheDocument();
  });

  it("is absent where the ladder cannot be edited", () => {
    mockStructure = false;
    render(<ProductPricingV2 product={product} />);
    expect(screen.queryByTestId("stub-controls")).toBeNull();
    expect(screen.queryByTestId("stub-beside")).toBeNull();
  });
});
