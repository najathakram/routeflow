import * as React from "react";
import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ToastProvider } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { ProductUnitsCard } from "../../ProductUnitsCard";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { DIRTY_HINT } from "../units";

// K10d: K7's unit panels mounted in the v2 shell, the way the page mounts the shell.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockRole: string | null = "OPERATOR";
let mockUnitsOn = true;
let mockUnits: unknown[] = [];
const mockSave = jest.fn();
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
  mockSave.mockReset();
  mockUnits = [];
  (apiClient.post as jest.Mock).mockReset();
  (apiClient.delete as jest.Mock).mockReset();
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

describe("K10d fold: the row header stays clean", () => {
  it("each unit's row-header name is just the unit label, and Remove sits in its own cell", () => {
    render();
    expect(screen.getAllByRole("rowheader").map((h) => h.textContent)).toEqual([
      "Case",
      "Box",
      "Piece",
    ]);
    expect(screen.getByRole("rowheader", { name: "Box" })).toBeInTheDocument();
    const rm = removeOpener();
    expect(rm.closest("th")).toBeNull();
    expect(rm.closest("td")).not.toBeNull();
    expect(rm.closest("tr")).toBe(screen.getByTestId(T.row("u-box")));
  });

  it("the table row's and the phone card's confirm panels get different ids", () => {
    render();
    const controls = screen
      .getAllByTestId("units-v2-rm-u-box")
      .map((b) => b.getAttribute("aria-controls"));
    expect(controls).toHaveLength(2);
    expect(new Set(controls).size).toBe(2);
    expect(controls.sort()).toEqual([
      "units-v2-remove-panel-u-box-card",
      "units-v2-remove-panel-u-box-table",
    ]);
  });

  it("without the controls the table has no extra column", () => {
    mockUnitsOn = false;
    render();
    expect(screen.getAllByRole("columnheader")).toHaveLength(8);
  });
});

describe("K10d fold: one Remove per unit row", () => {
  it("in v2 the unit row has K7's Remove and the old Units card has none for it", () => {
    mockUnits = [
      {
        id: "u-box",
        label: "Box",
        factorToBase: 24,
        price: "4.00",
        priceTier2: null,
        priceTier3: null,
        priceTier4: null,
        priceTier5: null,
        isDefaultSelling: false,
        sortOrder: 0,
      },
    ];
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <ProductPricingV2 product={product} />
          <ProductUnitsCard product={product} hideAddForm />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const gridRow = within(screen.getByTestId(T.row("u-box")));
    expect(gridRow.getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    expect(screen.getByTestId("unit-row")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("unit-row")).queryByRole("button", { name: /^Remove/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Add (a )?unit$/i })).toHaveLength(1);
  });
});

describe("K10d fold: Reset to Auto focus", () => {
  it("after Apply, focus lands inside the save bar, not on the page", async () => {
    const user = userEvent.setup();
    render();
    await user.click(resetOpener());
    await user.click(screen.getByTestId("units-v2-reset-apply"));
    await waitFor(() =>
      expect(screen.getByTestId(T.editbar).contains(document.activeElement)).toBe(true),
    );
    // the Save button itself (it is aria-disabled until saveable, so a "first enabled button" would pick Cancel)
    expect(document.activeElement).toBe(screen.getByTestId(T.ebSave));
  });
});

describe("K10d fold: after a Remove, focus stays on the page", () => {
  it("a finished delete moves focus to the units heading", async () => {
    (apiClient.delete as jest.Mock).mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render();
    await user.click(removeOpener());
    await user.click(screen.getByTestId("units-v2-rm-confirm"));
    await waitFor(() => expect(screen.queryByTestId("units-v2-remove-panel")).toBeNull());
    expect(document.activeElement).toBe(document.getElementById("units-v2-grid-title"));
  });
});

describe("K10d fold: a price typed in Add a unit lands as a draft", () => {
  const added = {
    ref: "u-pack",
    label: "Pack",
    factor: 6,
    kind: "unit" as const,
    editable: true,
    code: null,
    cells: cells([2, 1.9, 1.8, 1.7, 1.6]),
  };
  const createUnit = () =>
    (apiClient.post as jest.Mock).mockImplementation(async () => {
      // the server made the unit; the grid refetch (B1245) now serves its row
      mockGrid = {
        data: { ...grid, rows: [...grid.rows, added] },
        isLoading: false,
        isError: false,
      };
      return { data: { id: "u-pack", label: "Pack" } };
    });
  const addPack = async (user: ReturnType<typeof userEvent.setup>, price: string) => {
    await user.click(addOpener());
    await user.type(screen.getByTestId("units-v2-add-name"), "Pack");
    await user.type(screen.getByTestId("units-v2-add-n"), "6");
    if (price) await user.type(screen.getByTestId("units-v2-add-price"), price);
    await user.click(screen.getByTestId("units-v2-add-submit"));
  };
  const box = () =>
    within(screen.getByTestId(T.row("u-pack"))).getByTestId(
      T.input("u-pack", 1),
    ) as HTMLInputElement;
  const priceWrites = () =>
    (apiClient.post as jest.Mock).mock.calls.filter(([url]) => /price/.test(String(url)));

  it("(a) shows the price in the new unit's Retail box as an unsaved change, and saves nothing", async () => {
    createUnit();
    const user = userEvent.setup();
    render();
    await addPack(user, "7.50");
    await waitFor(() => expect(box().value).toBe("7.50"));
    expect(screen.getByTestId(T.ebText)).toHaveTextContent("1 unsaved");
    expect(mockSave).not.toHaveBeenCalled();
    expect(priceWrites()).toEqual([]);
    expect((apiClient.post as jest.Mock).mock.calls).toHaveLength(1);
    expect((apiClient.post as jest.Mock).mock.calls[0][1]).toEqual({
      label: "Pack",
      factorToBase: 6,
    });
  });

  it("(b) Save sends the normal price write holding that cell", async () => {
    createUnit();
    const user = userEvent.setup();
    render();
    await addPack(user, "7.50");
    await waitFor(() => expect(box().value).toBe("7.50"));
    await user.click(screen.getByTestId(T.ebSave));
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0].patches).toEqual([{ ref: "u-pack", tier: 1, to: 7.5 }]);
  });

  it("(c) Discard leaves the unit on Auto: no price write", async () => {
    createUnit();
    const user = userEvent.setup();
    render();
    await addPack(user, "7.50");
    await waitFor(() => expect(box().value).toBe("7.50"));
    await user.click(screen.getByTestId(T.ebCancel));
    await user.click(screen.getByTestId(T.ebDiscard));
    expect(screen.queryByTestId(T.editbar)).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
    expect(priceWrites()).toEqual([]);
  });

  it("(d) an invalid price is refused in the panel with the grid cell's message; no unit is created", async () => {
    createUnit();
    const user = userEvent.setup();
    render();
    await addPack(user, "abc");
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("units-v2-add-err")).toHaveTextContent(
      "Enter a price like 12.50, or clear the box to use the automatic price.",
    );
    expect(screen.getByTestId("units-v2-add-panel")).toBeInTheDocument();
    await user.clear(screen.getByTestId("units-v2-add-price"));
    await user.type(screen.getByTestId("units-v2-add-price"), "0");
    await user.click(screen.getByTestId("units-v2-add-submit"));
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("units-v2-add-err")).toHaveTextContent(
      "A price must be above $0.00. Clear the box to use the automatic price.",
    );
  });

  const note = () => screen.getByTestId("units-v2-add-note");
  const NOTE = "Unit added. Type its price in the grid.";
  const created = (grids: () => typeof mockGrid) =>
    (apiClient.post as jest.Mock).mockImplementation(async () => {
      mockGrid = grids();
      return { data: { id: "u-pack", label: "Pack" } };
    });
  const withRow = (isError = false) => ({
    data: { ...grid, rows: [...grid.rows, added] },
    isLoading: false,
    isError,
  });
  const noRow = (isError = false) => ({ data: grid, isLoading: false, isError });
  const noDraft = () => {
    expect(screen.queryByTestId(T.editbar)).toBeNull();
    expect(screen.queryByTestId(T.editingPill)).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  };

  it("the first grid after the add omits the row: the price is dropped, the user is told, no draft", async () => {
    created(() => noRow());
    const user = userEvent.setup();
    render();
    await addPack(user, "7.50");
    await waitFor(() => expect(note()).toHaveTextContent(NOTE));
    noDraft();
  });

  it("the grid errors after the add and recovers later: nothing is injected late", async () => {
    created(() => withRow(true));
    const user = userEvent.setup();
    render();
    await addPack(user, "7.50");
    await waitFor(() => expect(note()).toHaveTextContent(NOTE));
    noDraft();
    mockGrid = withRow(false); // the refetch recovers; any re-render now reads the good grid
    await user.click(screen.getByTestId(T.btnChange));
    await user.click(screen.getByTestId(T.btnChange));
    noDraft();
    expect(screen.queryByTestId(T.input("u-pack", 1))).toBeNull();
  });

  it("re-adding the same name with a blank price after a lost refetch does not reuse the old price", async () => {
    created(() => noRow());
    const user = userEvent.setup();
    render();
    await addPack(user, "7.50");
    await waitFor(() => expect(note()).toHaveTextContent(NOTE));
    (apiClient.post as jest.Mock).mockImplementation(async () => {
      mockGrid = {
        data: { ...grid, rows: [...grid.rows, { ...added, ref: "u-pack-2" }] },
        isLoading: false,
        isError: false,
      };
      return { data: { id: "u-pack-2", label: "Pack" } };
    });
    await addPack(user, "");
    await waitFor(() => expect(screen.queryByTestId("units-v2-add-panel")).toBeNull());
    expect(screen.getByTestId("units-v2-add-note")).toHaveTextContent("");
    noDraft();
  });

  it("a price whose unit id is not the one served is never matched by its name", async () => {
    (apiClient.post as jest.Mock).mockImplementation(async () => {
      mockGrid = withRow();
      return { data: { id: "some-other-id", label: "Pack" } };
    });
    const user = userEvent.setup();
    render();
    await addPack(user, "7.50");
    await waitFor(() => expect(note()).toHaveTextContent(NOTE));
    noDraft();
  });

  it("a blank price adds the unit on Auto and starts no draft", async () => {
    createUnit();
    const user = userEvent.setup();
    render();
    await addPack(user, "");
    await waitFor(() => expect(screen.queryByTestId("units-v2-add-panel")).toBeNull());
    expect(screen.queryByTestId(T.editbar)).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe("K10d: a panel opened under the Edit save bar is scrolled clear of it", () => {
  const seen: Element[] = [];
  beforeEach(() => {
    seen.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this);
    };
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("Add, Remove (table and card) open with the bar mounted and each scrolls its panel into view", async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByTestId(T.btnEdit));
    expect(screen.getByTestId(T.editbar)).toBeInTheDocument();
    await user.click(addOpener());
    expect(seen).toContain(screen.getByTestId("units-v2-add-panel"));
    await user.keyboard("{Escape}");
    await user.click(removeOpener());
    expect(seen).toContain(screen.getByTestId("units-v2-remove-panel"));
    await user.keyboard("{Escape}");
    await user.click(resetOpener());
    expect(seen).toContain(screen.getByTestId("units-v2-reset-panel"));
  });
});
