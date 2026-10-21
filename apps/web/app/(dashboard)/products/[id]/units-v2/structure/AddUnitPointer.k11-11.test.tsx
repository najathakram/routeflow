import * as React from "react";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { apiClient } from "@/lib/api-client";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

// K11-11: the grid's "Add the Piece unit first" pointer opens Add a unit as a Piece, with no document-level
// capture listener, and never closes a panel that is already open.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockRole: string | null = "OPERATOR";
let mockUnitsOn = true;
let mockUnits: unknown[] = [];
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({
    mutate: jest.fn(),
    reset: jest.fn(),
    isPending: false,
    error: null,
  }),
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
  useAuth: () => ({ user: { role: mockRole } }),
  useOptionalAuth: () => (mockRole ? { user: { role: mockRole } } : null),
}));
jest.mock("@/lib/api/product-units", () => ({
  ...jest.requireActual("@/lib/api/product-units"),
  useUnitsEnabled: () => mockUnitsOn,
  useProductUnits: () => ({
    data: mockUnits,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
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

const render = () =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={product as typeof product} />
    </QueryClientProvider>,
  );

const pack = { ...grid.rows[0], ref: "pack", label: "Case", factor: 24 };
const missingPiece = {
  ref: "base",
  label: "Piece",
  factor: 1,
  kind: "base" as const,
  editable: false,
  notEditableReason: "Add the Piece unit first.",
  code: null,
  cells: cells([0, 0, 0, 0, 0]),
};
const addOpener = () => screen.getByTestId("units-v2-add-open");
const pointer = () => within(screen.getByTestId(T.row("base"))).getByTestId(T.addUnitPointer);
const count = () => screen.getByTestId("units-v2-add-n") as HTMLInputElement;
const name = () => screen.getByTestId("units-v2-add-name") as HTMLInputElement;

beforeEach(() => {
  (apiClient.post as jest.Mock).mockReset();
  mockRole = "OPERATOR";
  mockUnitsOn = true;
  mockUnits = [];
  mockGrid = {
    data: { ...grid, anchor: "pack", rows: [pack, missingPiece] },
    isLoading: false,
    isError: false,
  };
});

describe("K11-11: the Piece pointer opens Add a unit without a document capture listener", () => {
  it("mounts no capture-phase click listener on the document", () => {
    const spy = jest.spyOn(document, "addEventListener");
    render();
    const capturing = spy.mock.calls.filter(
      ([type, , opts]) =>
        type === "click" && (opts === true || (opts as { capture?: boolean })?.capture === true),
    );
    spy.mockRestore();
    expect(capturing).toHaveLength(0);
  });

  it("still opens the form as the Piece (Contains 1, name Piece)", async () => {
    const user = userEvent.setup();
    render();
    await user.click(pointer());
    expect(count()).toHaveValue(1);
    expect(name()).toHaveValue("Piece");
    expect(name()).toHaveAttribute("readonly");
  });

  it("a later plain open is blank after a pointer open", async () => {
    const user = userEvent.setup();
    render();
    await user.click(pointer());
    await user.click(screen.getByTestId("units-v2-add-cancel"));
    await user.click(addOpener());
    expect(count()).toHaveValue(null);
    expect(name()).toHaveValue("");
  });
});

describe("K11-11: the pointer opens the panel, it never closes it", () => {
  it("with Add a unit already open, the pointer leaves it open and puts focus in its first field", async () => {
    const user = userEvent.setup();
    render();
    await user.click(addOpener());
    expect(screen.getByTestId("units-v2-add-panel")).toBeInTheDocument();
    await user.click(pointer());
    expect(screen.getByTestId("units-v2-add-panel")).toBeInTheDocument();
    expect(name()).toHaveFocus();
  });

  it("an open panel that was opened plain stays blank when the pointer is used, and a later plain open is blank too", async () => {
    const user = userEvent.setup();
    render();
    await user.click(addOpener());
    await user.click(pointer());
    expect(count()).toHaveValue(null);
    await user.click(screen.getByTestId("units-v2-add-cancel"));
    await user.click(addOpener());
    expect(count()).toHaveValue(null);
    expect(name()).toHaveValue("");
  });
});
