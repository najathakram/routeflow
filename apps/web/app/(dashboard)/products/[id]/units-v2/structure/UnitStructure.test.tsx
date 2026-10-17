import * as React from "react";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { DIRTY_HINT } from "../units";

// K10d: K7's unit panels mounted in the v2 shell, the way the page mounts the shell.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockRole: string | null = "OPERATOR";
let mockUnitsOn = true;
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: jest.fn(), reset: jest.fn(), isPending: false, error: null }),
  useUndoPrices: () => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));
jest.mock("@/lib/auth-context", () => ({
  useOptionalAuth: () => (mockRole ? { user: { role: mockRole } } : null),
}));
jest.mock("@/lib/api/product-units", () => ({
  ...jest.requireActual("@/lib/api/product-units"),
  useUnitsEnabled: () => mockUnitsOn,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: () => new Promise(() => {}),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));
const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "piece",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 960,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([11, 13.91, 12.5, 11, 10], ["set", "set"]),
    },
    {
      ref: "u-box",
      label: "Box",
      factor: 24,
      kind: "unit",
      editable: true,
      code: null,
      cells: cells([4, 3.8, 3.6, 3.4, 3.2]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

const render = (p: Record<string, unknown> = product) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={p as typeof product} />
    </QueryClientProvider>,
  );
const addOpener = () => screen.getByTestId("units-v2-add-open");
const resetOpener = () => screen.getByTestId("units-v2-reset-open");
const removeOpener = () => screen.getAllByTestId("units-v2-rm-u-box")[0];

beforeEach(() => {
  mockRole = "OPERATOR";
  mockUnitsOn = true;
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("K10d: V15 one Add a unit", () => {
  it("renders exactly one Add a unit control", () => {
    render();
    expect(screen.getAllByTestId("units-v2-add-open")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Add a unit" })).toHaveLength(1);
  });

  it("offers the base unit and the ladder's other units as the 'of' choices", async () => {
    render();
    await userEvent.click(addOpener());
    const of = screen.getByTestId("units-v2-add-of") as HTMLSelectElement;
    expect([...of.options].map((o) => [o.text, o.value])).toEqual([
      ["Piece", "0"],
      ["Box", "1"],
      ["Case", "2"],
    ]);
  });

  it("opens the add panel above the grid, under any Change prices panel", async () => {
    render();
    await userEvent.click(screen.getByTestId(T.btnChange));
    await userEvent.click(addOpener());
    const change = screen.getByTestId("units-v2-change-panel");
    const add = screen.getByTestId("units-v2-add-panel");
    const gridEl = screen.getByTestId(T.grid);
    expect(change.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add.compareDocumentPosition(gridEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("K10d: V17 Escape closes what you opened and focus returns", () => {
  it("add panel: opens, hides the opener, focuses the name, Escape closes and refocuses", async () => {
    const user = userEvent.setup();
    render();
    await user.click(addOpener());
    expect(screen.getByTestId("units-v2-add-panel")).toBeInTheDocument();
    expect(screen.getByTestId("units-v2-add-name")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("units-v2-add-panel")).toBeNull();
    expect(addOpener()).toHaveFocus();
  });

  it("remove panel: opens under its row, Escape closes it and focuses that row's Remove button", async () => {
    const user = userEvent.setup();
    render();
    await user.click(removeOpener());
    expect(screen.getByTestId("units-v2-remove-panel")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("units-v2-remove-panel")).toBeNull();
    expect(removeOpener()).toHaveFocus();
  });

  it("reset panel: opens, Escape closes it and refocuses the opener", async () => {
    const user = userEvent.setup();
    render();
    await user.click(resetOpener());
    expect(screen.getByTestId("units-v2-reset-panel")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("units-v2-reset-panel")).toBeNull();
    expect(resetOpener()).toHaveFocus();
  });

  it("Reset to Auto applies to the shared draft (the save bar appears with the prices cleared)", async () => {
    const user = userEvent.setup();
    render();
    expect(screen.queryByTestId(T.editbar)).toBeNull();
    await user.click(resetOpener());
    expect(screen.getByTestId("units-v2-reset-panel")).toHaveTextContent("Piece Retail price");
    expect(screen.getByTestId("units-v2-reset-panel")).toHaveTextContent("2 prices will change");
    await user.click(screen.getByTestId("units-v2-reset-apply"));
    expect(screen.getByTestId(T.editbar)).toBeInTheDocument();
  });

  it("Remove has one confirm per row and none for the Case or Piece rows", () => {
    render();
    expect(screen.getAllByTestId("units-v2-rm-u-box").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("units-v2-rm-case")).toBeNull();
    expect(screen.queryByTestId("units-v2-rm-piece")).toBeNull();
    expect(screen.queryByTestId("units-v2-rm-base")).toBeNull();
  });
});

describe("K10d: V15 step 7, a dirty draft disables structure", () => {
  it("Add, Remove and Reset are disabled with the hint once a price is edited", async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByTestId(T.btnEdit));
    const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
    await user.clear(input);
    await user.type(input, "14.5");
    expect(addOpener()).toBeDisabled();
    expect(resetOpener()).toBeDisabled();
    expect(removeOpener()).toBeDisabled();
    expect(screen.getAllByText(DIRTY_HINT).length).toBeGreaterThanOrEqual(3);
  });
});

describe("K10d: V15 step 8, gated like the rest of v2", () => {
  const none = () => {
    expect(screen.queryByTestId("units-v2-add-open")).toBeNull();
    expect(screen.queryByTestId("units-v2-reset-open")).toBeNull();
    expect(screen.queryByTestId("units-v2-rm-u-box")).toBeNull();
  };

  it.each([
    ["a FAMILY product", { ...product, kind: "FAMILY" }],
    ["a RECIPE product", { ...product, kind: "RECIPE" }],
    ["a variant of a family", { ...product, parentProductId: "fam-1" }],
  ])("renders none of them for %s", (_n, p) => {
    render(p);
    none();
  });

  it("renders none of them when the tenant is not served flag.units_v1", () => {
    mockUnitsOn = false;
    render();
    none();
  });

  it("renders none of them for a role that cannot manage units", () => {
    mockRole = "DRIVER";
    render();
    none();
  });

  it("renders none of them while the grid has not loaded", () => {
    mockGrid = { isLoading: true, isError: false };
    render();
    none();
  });

  it("still renders the grid and its Edit button when the controls are off", () => {
    mockUnitsOn = false;
    render();
    expect(screen.getByTestId(T.grid)).toBeInTheDocument();
    expect(screen.getByTestId(T.btnEdit)).toBeInTheDocument();
  });
});

describe("K10d: the add-unit pointer", () => {
  it("a refused first Piece price points at the v2 Add a unit opener and opens it", async () => {
    const pack = { ...grid.rows[0], ref: "pack", label: "Case", factor: 24 };
    const base = {
      ref: "base",
      label: "Piece",
      factor: 1,
      kind: "base" as const,
      editable: false,
      notEditableReason: "Add the Piece unit first.",
      code: null,
      cells: cells([0, 0, 0, 0, 0]),
    };
    mockGrid = {
      data: { ...grid, anchor: "pack", rows: [pack, base] },
      isLoading: false,
      isError: false,
    };
    const user = userEvent.setup();
    render();
    await user.click(within(screen.getByTestId(T.row("base"))).getByTestId(T.addUnitPointer));
    expect(screen.getByTestId("units-v2-add-panel")).toBeInTheDocument();
    expect(screen.getByTestId("units-v2-add-name")).toHaveFocus();
  });
});
