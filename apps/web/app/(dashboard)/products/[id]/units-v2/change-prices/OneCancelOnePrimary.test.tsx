import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { EditablePricesGrid } from "../edit/EditablePricesGrid";
import { PriceDraftProvider } from "../edit/PriceDraftProvider";
import { PriceEditBar } from "../edit/PriceEditBar";
import { ChangePrices, useChangePrices } from "./ChangePrices";

// K11-18: while Change prices is open the bar drops its Cancel and Save (the panel has its own Cancel and Apply) and says
// "Finish Change prices first." in their place; closing the panel brings them back. Ctrl/Cmd+S does not save while the
// panel is open. The real draft, grid, bar and panel; only the data hooks are mocked.

const mockSave = jest.fn();
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => ({ data: mockGrid, isLoading: false, isError: false }),
  fetchPriceGrid: () => Promise.resolve(mockGrid),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({
    mutate: (...a: unknown[]) => mockSave(...a),
    reset: jest.fn(),
    isPending: false,
    error: null,
  }),
  useUndoPrices: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));
const mockGrid: ProductPriceGridDto = {
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
      factor: 24,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([30, 28, 26, 24, 22], ["set", "set", "set"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([1.25, 1.17, 1.08, 1, 0.92], ["set"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "1.25" };

function Harness() {
  const cp = useChangePrices();
  return (
    <PriceDraftProvider productId="p1">
      <EditablePricesGrid
        product={product}
        onOpenChangePrices={cp.toggle}
        changePricesOpen={cp.open}
        changePricesRef={cp.opener}
        panel={<ChangePrices open={cp.open} onClose={cp.close} openerRef={cp.opener} />}
      />
      <PriceEditBar changePricesOpen={cp.open} />
    </PriceDraftProvider>
  );
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );

const FINISH = "Finish Change prices first.";
const barText = () => screen.getByTestId(T.ebText).textContent ?? "";
const pieceBox = () =>
  within(screen.getByTestId(T.row("piece"))).getByTestId(T.input("piece", 2)) as HTMLInputElement;
const dirty = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId(T.btnEdit));
  await user.type(pieceBox(), "1.1");
};
const dirtyThenOpen = async (user: ReturnType<typeof userEvent.setup>) => {
  await dirty(user);
  await user.click(screen.getByTestId(T.btnChange));
};

beforeEach(() => mockSave.mockReset());

describe("K11-18: one Cancel and one primary while Change prices is open", () => {
  it("with the panel open and a dirty draft there is exactly one Cancel, and Apply is the only primary", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyThenOpen(user);
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Cancel" }).id).toBe("ch-cancel");
    expect(screen.queryByTestId(T.ebSave)).toBeNull();
    expect(screen.queryByTestId(T.ebCancel)).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: FINISH })).toBeTruthy();
  });

  it("the bar keeps its message, and the sentence sits outside its live region", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyThenOpen(user);
    expect(barText()).toMatch(/1 unsaved/);
    expect(barText()).not.toContain(FINISH);
    expect(
      screen.getByTestId(T.ebText).contains(screen.getByRole("button", { name: FINISH })),
    ).toBe(false);
    expect(
      screen.getByTestId(T.editbar).contains(screen.getByRole("button", { name: FINISH })),
    ).toBe(true);
  });

  it("the sentence is a button that takes focus to the panel", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyThenOpen(user);
    await user.click(screen.getByRole("button", { name: FINISH }));
    expect(document.activeElement).toBe(document.getElementById("change-panel"));
  });

  it("closing the panel (Cancel) brings Save and Cancel back", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyThenOpen(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId(T.ebSave)).toBeTruthy();
    expect(screen.getByTestId(T.ebCancel)).toBeTruthy();
    expect(screen.queryByRole("button", { name: FINISH })).toBeNull();
  });

  it("an open Discard question leaves no second primary behind the panel", async () => {
    const user = userEvent.setup();
    mount();
    await dirty(user);
    await user.click(screen.getByTestId(T.ebCancel));
    expect(screen.getByTestId(T.ebKeep)).toBeTruthy();
    await user.click(screen.getByTestId(T.btnChange));
    expect(screen.queryByTestId(T.ebKeep)).toBeNull();
    expect(screen.queryByTestId(T.ebDiscard)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  });

  it("Ctrl+S does not save while the panel is open, and says why once in the polite region", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyThenOpen(user);
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(mockSave).not.toHaveBeenCalled();
    expect(barText().split(FINISH)).toHaveLength(2);
    expect(screen.getByTestId(T.ebText)).toHaveAttribute("aria-live", "polite");
  });

  it("Ctrl+S saves again once the panel is closed", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyThenOpen(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("Skip to Save lands on Apply when there is one to press, else on the panel", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyThenOpen(user);
    fireEvent.click(screen.getByTestId(T.skipSave));
    expect(document.activeElement).toBe(document.getElementById("change-panel"));
    await user.type(screen.getByLabelText("Amount"), "5");
    fireEvent.click(screen.getByTestId(T.skipSave));
    expect(document.activeElement).toBe(document.getElementById("ch-apply"));
  });

  it("the Apply focus still lands on Save once the bar's buttons are back", async () => {
    const user = userEvent.setup();
    mount();
    await dirtyThenOpen(user);
    await user.type(screen.getByLabelText("Amount"), "5");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(document.activeElement).toBe(document.getElementById(T.ebSave));
  });
});

describe("K11-18: tighter Change prices copy", () => {
  const open = async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnChange));
    return user;
  };

  it("the helper sentence and the percent hint", async () => {
    await open();
    expect(screen.getByText("Pick a unit and how much to move it.")).toBeTruthy();
    expect(screen.getByText("Other units move by the same percent.")).toBeTruthy();
  });

  it("the unticked Also box names what stays put and how to move it", async () => {
    await open();
    const box = screen.getByRole("checkbox", { name: /Also raise the prices you set/ });
    expect(box).not.toBeChecked();
    const name = box.closest("label")!.textContent!;
    expect(name).toContain("stay as they are");
    expect(name).toMatch(/Prices you set stay as they are: .+\. Tick to raise them too\./);
  });

  it("ticked, the box lists the prices it moves instead", async () => {
    const user = await open();
    await user.type(screen.getByLabelText("Amount"), "5");
    await user.click(screen.getByRole("checkbox", { name: /Also raise the prices you set/ }));
    const name = screen
      .getByRole("checkbox", { name: /Also raise/ })
      .closest("label")!.textContent!;
    expect(name).not.toContain("stay as they are");
    expect(name).toContain("by 5%");
  });
});
