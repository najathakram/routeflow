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
import { AddUnitPanel, DIRTY_HINT, ResetToAutoPanel } from "../units";

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

// K11-19: Add a unit and Reset all to Auto on one row. The real cause of P13 is vertical: the openers butted against the
// Change prices panel above them. jsdom has no layout, so this pins the classes and structure; the pixel claims
// (equal tops, 8px gap, edge alignment, 12px below the panel) are in e2e/k11-l2-opener-row.spec.ts.

beforeEach(() => {
  mockSave.mockReset();
  mockUnits = [];
  mockRole = "OPERATOR";
  mockUnitsOn = true;
  mockGrid = { data: grid, isLoading: false, isError: false };
});

const structure = () => screen.getByTestId("units-v2-structure");
const row = () => screen.getByTestId("units-v2-structure-row");
const cls = (el: Element) => el.className.split(/\s+/);

describe("K11-19: the openers share one row", () => {
  it("both openers sit in one flex row with an 8px gap, 12px above it and 12px above the grid", () => {
    render();
    const r = row();
    for (const c of ["flex", "flex-wrap", "items-start", "gap-2"]) expect(cls(r)).toContain(c);
    expect(cls(r)).toContain("mt-3");
    expect(cls(structure())).toContain("mb-3");
    expect(r).toContainElement(addOpener());
    expect(r).toContainElement(resetOpener());
    // The row holds the two controls as direct flex items and nothing else.
    expect(r.children).toHaveLength(2);
  });

  it("no stacking utility is left on the container (the old space-y-3)", () => {
    render();
    expect(structure().className).not.toMatch(/space-y/);
    expect(row().className).not.toMatch(/space-y/);
  });

  it("the live add-note stays mounted, after the row, and is not a flex item of it", () => {
    render();
    const note = screen.getByTestId("units-v2-add-note");
    expect(note).toHaveAttribute("role", "status");
    expect(row()).not.toContainElement(note);
    expect(row().compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      note.compareDocumentPosition(screen.getByTestId(T.grid)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("an opened panel takes the full row below the openers (order-last basis-full on its item)", async () => {
    render();
    await userEvent.click(addOpener());
    const item = screen
      .getByTestId("units-v2-add-panel")
      .closest("[data-testid='units-v2-structure-row'] > *")!;
    expect(item.parentElement).toBe(row());
    // The row's own variants do the work, keyed on the panel being inside the item (AddUnitPanel stays untouched).
    expect(row().className).toContain("has-[[data-testid=units-v2-add-panel]]");
    expect(row().className).toContain("has-[[data-testid=units-v2-reset-panel]]");
    expect(row().className).toMatch(/order-last/);
    expect(row().className).toMatch(/basis-full/);
  });

  it("when both are open they stack in the order they were opened", async () => {
    render();
    await userEvent.click(addOpener());
    await userEvent.click(resetOpener());
    expect(row().getAttribute("data-last-opened")).toBe("reset");
    expect(row().className).toContain(
      "[&[data-last-opened=reset]>*:has([data-testid=units-v2-reset-panel])]",
    );
    expect(row().className).toContain(
      "[&[data-last-opened=add]>*:has([data-testid=units-v2-add-panel])]",
    );
    expect(screen.getByTestId("units-v2-add-panel")).toBeInTheDocument();
    expect(screen.getByTestId("units-v2-reset-panel")).toBeInTheDocument();
  });

  it("opening Reset first then Add makes Add the later one", async () => {
    render();
    await userEvent.click(resetOpener());
    await userEvent.click(addOpener());
    expect(row().getAttribute("data-last-opened")).toBe("add");
  });
});

describe("K11-19: the row's variants compile to the selectors the layout needs", () => {
  it("an item holding an open panel goes last and takes the full row; the later-opened one goes after it", async () => {
    const postcss = require("postcss");
    const tailwind = require("tailwindcss");
    render();
    const out = await postcss([
      tailwind({
        content: [{ raw: `<div class="${row().className}">` }],
        corePlugins: { preflight: false },
      }),
    ]).process("@tailwind utilities;", { from: undefined });
    const css: string = out.css;
    expect(css).toContain(">*:has([data-testid=units-v2-add-panel])");
    expect(css).toContain(">*:has([data-testid=units-v2-reset-panel])");
    expect(css).toMatch(/order: 9999/);
    expect(css).toMatch(/flex-basis: 100%/);
    expect(css).toMatch(
      /\[data-last-opened="?add"?]>\*:has\(\[data-testid=units-v2-add-panel\]\)\s*\{\s*order: 10000/,
    );
    expect(css).toMatch(
      /\[data-last-opened="?reset"?]>\*:has\(\[data-testid=units-v2-reset-panel\]\)\s*\{\s*order: 10000/,
    );
  });
});

describe("K11-19: one unsaved hint for the opener row", () => {
  const dirtyIt = async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByTestId(T.btnEdit));
    const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
    await user.clear(input);
    await user.type(input, "14.5");
  };

  it("a dirty draft prints the hint once for the whole structure, after the row", async () => {
    await dirtyIt();
    expect(addOpener()).toBeDisabled();
    expect(resetOpener()).toBeDisabled();
    const hints = within(structure()).getAllByText(DIRTY_HINT);
    expect(hints).toHaveLength(1);
    expect(row()).not.toContainElement(hints[0]);
    expect(row().compareDocumentPosition(hints[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the add-note status region stays mounted next to the one hint", async () => {
    await dirtyIt();
    const note = screen.getByTestId("units-v2-add-note");
    expect(note).toHaveAttribute("role", "status");
    expect(structure()).toContainElement(note);
  });

  it("a clean draft prints no hint and mounts no hint element", () => {
    render();
    expect(within(structure()).queryByText(DIRTY_HINT)).toBeNull();
  });

  it("each panel on its own still prints its own hint; hideHint suppresses it", () => {
    const { rerender } = rtlRender(<AddUnitPanel productId="p1" baseLabel="Piece" dirty />);
    expect(screen.getAllByText(DIRTY_HINT)).toHaveLength(1);
    rerender(<AddUnitPanel productId="p1" baseLabel="Piece" dirty hideHint />);
    expect(screen.queryByText(DIRTY_HINT)).toBeNull();
    rerender(<ResetToAutoPanel onApply={jest.fn()} dirty />);
    expect(screen.getAllByText(DIRTY_HINT)).toHaveLength(1);
    rerender(<ResetToAutoPanel onApply={jest.fn()} dirty hideHint />);
    expect(screen.queryByText(DIRTY_HINT)).toBeNull();
  });
});
