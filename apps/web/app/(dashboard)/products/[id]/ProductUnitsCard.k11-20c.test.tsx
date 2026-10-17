import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductUnitsCard } from "./ProductUnitsCard";
import { PriceWindowHost } from "./PriceWindowHost";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";
import { SAVE_RESPONSE, SAVED_GRID } from "./units-v2/window/k11-20a.fixtures";

/**
 * K11-20c: on the v2 page the legacy "Units & prices" card stops editing prices. Each price is a read-only figure read from
 * the SERVED grid (never the draft, never product.pricePerUnit or the unit's own snapshot) and a button that opens the
 * floating price window on that box. Everything that is not a price stays.
 */
const PRICE_KEYS = ["price", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockUnits: unknown[] = [];
const updateMutate = jest.fn();
const updateMutateAsync = jest.fn();
const createMutate = jest.fn();
const mockSave = jest.fn();

jest.mock("@/lib/api/product-units", () => ({
  ...jest.requireActual("@/lib/api/product-units"),
  useUnitsEnabled: () => true,
  useProductUnits: () => ({
    data: mockUnits,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useCreateProductUnit: () => ({ mutate: createMutate, isPending: false }),
  useUpdateProductUnit: () => ({
    mutate: updateMutate,
    mutateAsync: updateMutateAsync,
    isPending: false,
  }),
  useDeleteProductUnit: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({
    mutate: (req: unknown, o: unknown) => mockSave(req, o),
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
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
  useOptionalAuth: () => ({ user: { role: "OPERATOR" } }),
}));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));
const GRID: ProductPriceGridDto = {
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
      cells: cells([30, 28, 26, 24, 22], ["set", "set"]),
    },
    {
      ref: "box",
      label: "Box",
      factor: 24,
      kind: "unit",
      editable: true,
      code: null,
      cells: cells([24.5, 22, 21, 20, 19], ["set"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([1, 0.9, 0.88, 0.85, 0.8], ["set"]),
    },
  ],
};

// The product row and the unit's own snapshot both disagree with the served grid on purpose.
const PRODUCT = {
  id: "p1",
  name: "Acme widgets",
  unit: "Case",
  unitsPerBox: 40,
  pricePerUnit: "99.00",
};
const boxUnit = {
  id: "box",
  label: "Box",
  factorToBase: 24,
  price: "17.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
};

function Page({
  product = PRODUCT,
  host = true,
  hideAddForm = true,
}: {
  product?: Record<string, unknown>;
  host?: boolean;
  hideAddForm?: boolean;
}) {
  const [qc] = React.useState(() => new QueryClient());
  const card = <ProductUnitsCard product={product as typeof PRODUCT} hideAddForm={hideAddForm} />;
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <PriceWindowHost product={product as typeof PRODUCT} enabled={host}>
          {card}
        </PriceWindowHost>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const priceInputs = () =>
  screen.queryAllByLabelText(/price$/i).filter((el) => el.tagName === "INPUT");
const dialog = () => screen.getByRole("dialog", { name: "Edit prices" });
const openTiers = () =>
  document.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));

beforeEach(() => {
  jest.clearAllMocks();
  mockGrid = { data: GRID, isLoading: false, isError: false };
  mockUnits = [boxUnit];
});

describe("K11-20c card: v2 on shows served figures, not price inputs", () => {
  it("renders zero price inputs", () => {
    render(<Page />);
    openTiers();
    expect(priceInputs()).toHaveLength(0);
    // Name and factor inputs stay.
    expect(screen.getByLabelText("Box name")).toBeInTheDocument();
    expect(screen.getByLabelText("Pieces per Box")).toBeInTheDocument();
  });

  it("its figures are the served grid's, with the Auto or Set word; not the unit snapshot or the product price", () => {
    render(<Page />);
    openTiers();
    const retail = screen.getByRole("button", { name: "Edit Retail Box price" });
    expect(retail).toHaveTextContent("$24.50");
    expect(retail).toHaveTextContent("Set");
    const tier2 = screen.getByRole("button", { name: "Edit Wholesale Box price" });
    expect(tier2).toHaveTextContent("$22.00");
    expect(tier2).toHaveTextContent("Auto");
    expect(screen.queryByText("$17.00")).toBeNull();
    for (const t of [3, 4, 5]) {
      expect(
        screen.getByRole("button", {
          name: `Edit ${t === 3 ? "Distributor" : `Tier ${t}`} Box price`,
        }),
      ).toBeInTheDocument();
    }
  });

  it("the pack row figure reads the grid's pack row (not product.pricePerUnit) and is a button", () => {
    render(<Page />);
    const pack = screen.getByRole("button", { name: "Edit Retail Case price" });
    expect(pack).toHaveTextContent("$30.00");
    expect(screen.queryByText("$99.00")).toBeNull();
    expect(screen.getByText(/· 40 pieces · the \w+$/)).toBeInTheDocument();
    expect(screen.queryByText(/edit its price above/i)).toBeNull();
  });

  it("a figure follows the served grid when it changes (never a draft)", () => {
    const { rerender } = render(<Page />);
    mockGrid = {
      data: {
        ...GRID,
        rows: [GRID.rows[0], { ...GRID.rows[1], cells: cells([26, 22, 21, 20, 19]) }],
      },
      isLoading: false,
      isError: false,
    };
    rerender(<Page />);
    expect(screen.getByRole("button", { name: "Edit Retail Box price" })).toHaveTextContent(
      "$26.00",
    );
  });

  it("while the grid has not loaded the figures are placeholders and still no inputs", () => {
    mockGrid = { data: undefined, isLoading: true, isError: false };
    render(<Page />);
    openTiers();
    expect(priceInputs()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Edit Retail Box price" })).toBeNull();
  });
});

describe("K11-20c card: nits", () => {
  it("figure buttons are at least 44 px tall below sm", () => {
    render(<Page />);
    expect(screen.getByRole("button", { name: "Edit Retail Box price" }).className).toMatch(
      /min-h-11/,
    );
  });

  it("when the grid query errors, the figures are the unit's own prices as read-only text, not dashes", () => {
    mockGrid = { data: undefined, isLoading: false, isError: true };
    render(<Page />);
    openTiers();
    expect(priceInputs()).toHaveLength(0);
    expect(screen.getByText("$17.00")).toBeInTheDocument();
    expect(screen.getByText("$99.00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit .* price$/ })).toBeNull();
    // Only a price the unit does not store is a dash (its Auto tiers have no stored value).
  });
});

describe("K11-20c card: it opens the window on that box", () => {
  it("clicking 'Edit Wholesale Box price' opens the window with focus in that box", async () => {
    const user = userEvent.setup();
    render(<Page />);
    openTiers();
    await user.click(screen.getByRole("button", { name: "Edit Wholesale Box price" }));
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(within(dialog()).getByTestId(T.input("box", 2))).toHaveFocus());
  });

  it("the pack figure opens the window on the pack's Retail box", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Edit Retail Case price" }));
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(within(dialog()).getByTestId(T.input("case", 1))).toHaveFocus());
  });

  it("closing the window returns focus to the figure that was clicked (opener first)", async () => {
    const user = userEvent.setup();
    render(<Page />);
    openTiers();
    const figure = screen.getByRole("button", { name: "Edit Wholesale Box price" });
    await user.click(figure);
    await screen.findByRole("dialog", { name: "Edit prices" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(figure).toHaveFocus());
  });

  it("the header 'Edit prices' opens it on the first editable box", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Edit prices" }));
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => {
      const first = dialog().querySelector<HTMLElement>('[data-testid^="units-v2-input-"]');
      expect(first).not.toBeNull();
      expect(first).toHaveFocus();
    });
  });

  it("a window save closes it, returns focus to the trigger and shows the one saved line under it", async () => {
    mockSave.mockImplementation((_req, o) => {
      mockGrid = { data: SAVED_GRID, isLoading: false, isError: false };
      o.onSuccess(SAVE_RESPONSE);
    });
    const user = userEvent.setup();
    render(<Page />);
    const trigger = screen.getByRole("button", { name: "Edit prices" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Edit prices" });
    const caseBox = within(dialog()).getByTestId(T.input("case", 2));
    await user.clear(caseBox);
    await user.type(caseBox, "29");
    await user.click(within(dialog()).getByTestId(T.ebSave));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockSave).toHaveBeenCalledTimes(1);
    const line = document.getElementById("units-msg-window") as HTMLElement;
    expect(line.textContent).toContain("Saved");
    // Directly under the trigger: the same header block holds both.
    const header = trigger.closest("[data-testid='units-card-header']") as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.contains(line)).toBe(true);
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("K11-20c card: no price is written from the card in v2", () => {
  it("a per-row Save sends no price key, and no cascade dialog ever opens", async () => {
    render(<Page />);
    fireEvent.change(screen.getByLabelText("Box name"), { target: { value: "Boxes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [body, opts] = updateMutate.mock.calls[0];
    expect(body).toMatchObject({ id: "box", label: "Boxes", factorToBase: 24 });
    for (const k of PRICE_KEYS) expect(body).not.toHaveProperty(k);
    opts.onSuccess({});
    expect(screen.queryByText("Update the other unit prices too?")).toBeNull();
  });

  it("the Add unit form (shown only until the grid has loaded) has no Price field", () => {
    mockGrid = { data: undefined, isLoading: true, isError: false };
    render(<Page />);
    expect(screen.getByLabelText("New unit")).toBeInTheDocument();
    expect(screen.getByLabelText("Pieces per new unit")).toBeInTheDocument();
    expect(screen.queryByLabelText("Price (optional)")).toBeNull();
    expect(document.getElementById("new-unit-price")).toBeNull();
  });

  it("creating a unit sends no price key", () => {
    mockGrid = { data: undefined, isLoading: true, isError: false };
    render(<Page />);
    fireEvent.change(screen.getByLabelText("New unit"), { target: { value: "Pallet" } });
    fireEvent.change(screen.getByLabelText("Pieces per new unit"), { target: { value: "960" } });
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toEqual({ label: "Pallet", factorToBase: 960 });
  });
});

describe("K11-20c card: everything that is not a price stays", () => {
  it("keeps the default order unit radios (pack row and unit row), Remove-less shell rule and the factor input", () => {
    render(<Page />);
    expect(screen.getAllByLabelText("Default order unit")).toHaveLength(2);
    expect(screen.getByLabelText("Pieces per Box")).toBeInTheDocument();
  });

  it("keeps the old Remove on a row the shell has no Remove for", () => {
    mockGrid = {
      data: { ...GRID, rows: [GRID.rows[0], { ...GRID.rows[1], kind: "base" }] },
      isLoading: false,
      isError: false,
    };
    render(<Page />);
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});

describe("K11-20c card: flag off and governed products are unchanged", () => {
  it("flag OFF (no host, no hideAddForm): the price inputs render as today (DOM check)", () => {
    render(<Page host={false} hideAddForm={false} />);
    openTiers();
    expect(priceInputs().length).toBeGreaterThanOrEqual(5);
    expect(screen.getByLabelText("Box price")).toHaveValue("17.00");
    expect(screen.getByLabelText("Price (optional)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit prices" })).toBeNull();
  });

  it("a variant keeps its price inputs and Price field even with the host (the window cannot edit it)", () => {
    render(<Page product={{ ...PRODUCT, parentProductId: "fam-1" }} />);
    openTiers();
    expect(priceInputs().length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByRole("button", { name: "Edit Retail Box price" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit prices" })).toBeNull();
  });
});
