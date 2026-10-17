import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PriceDraftContext, type PriceDraft } from "../edit/usePriceDraft";
import { UnitStructureControls } from "./UnitStructure";

// K10d fold: Reset to Auto's Apply is gated on the shared draft being clean, not only by the panel closing itself.
const resetProps: Array<Record<string, unknown>> = [];
let addProps: Record<string, unknown> = {};
jest.mock("../units", () => ({
  ...jest.requireActual("../units"),
  AddUnitPanel: (p: Record<string, unknown>) => {
    addProps = p;
    return null;
  },
  ResetToAutoPanel: (p: Record<string, unknown>) => {
    resetProps.push(p);
    return <button data-testid="reset-stub" onClick={() => (p.onApply as () => void)()} />;
  },
}));
jest.mock("@/lib/api/usePriceGrid", () => ({
  usePriceGrid: () => ({
    isError: false,
    isFetching: false,
    data: {
      productId: "p1",
      anchor: "pack",
      revision: 1,
      priceState: "x",
      tierAnchors: {},
      tierRules: {},
      rows: [
        {
          ref: "pack",
          label: "Case",
          factor: 24,
          kind: "pack",
          editable: true,
          code: null,
          cells: [1, 2, 3, 4, 5].map((tier) => ({
            tier,
            value: tier * 24,
            source: tier === 1 ? "set" : "auto",
          })),
        },
        {
          ref: "base",
          label: "Piece",
          factor: 1,
          kind: "base",
          editable: true,
          code: null,
          cells: [1, 2, 3, 4, 5].map((tier) => ({
            tier,
            value: tier,
            source: tier === 2 ? "set" : "auto",
          })),
        },
        {
          ref: "u-new",
          label: "Pack",
          factor: 6,
          kind: "unit",
          editable: true,
          code: null,
          cells: [1, 2, 3, 4, 5].map((tier) => ({ tier, value: tier, source: "auto" })),
        },
      ],
    },
  }),
}));

const setText = jest.fn();
const startEditing = jest.fn();
const resetAllToAuto = jest.fn();
const draftOf = (dirty: boolean) =>
  ({
    dirty,
    startEditing,
    resetAllToAuto,
    editing: false,
    api: { setText },
  }) as unknown as PriceDraft;
const mount = (dirty: boolean) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PriceDraftContext.Provider value={draftOf(dirty)}>
        <UnitStructureControls productId="p1" />
      </PriceDraftContext.Provider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  resetProps.length = 0;
  startEditing.mockReset();
  setText.mockReset();
  resetAllToAuto.mockReset();
});

describe("Reset to Auto Apply gate", () => {
  it("is disabled while the draft is dirty, and Apply does nothing then", () => {
    mount(true);
    const p = resetProps[resetProps.length - 1];
    expect(p.disabled).toBe(true);
    (p.onApply as () => void)();
    expect(resetAllToAuto).not.toHaveBeenCalled();
    expect(startEditing).not.toHaveBeenCalled();
  });

  it("is enabled on a clean draft and Apply starts editing, then resets", () => {
    mount(false);
    const p = resetProps[resetProps.length - 1];
    expect(p.disabled).toBe(false);
    screen.getByTestId("reset-stub").click();
    expect(startEditing).toHaveBeenCalledTimes(1);
    expect(resetAllToAuto).toHaveBeenCalledTimes(1);
  });
});

describe("a typed price meets a draft that is no longer clean", () => {
  it("is not injected when the draft is dirty as the new row arrives, and the user is told", () => {
    mount(true);
    act(() =>
      (addProps.onAdded as (a: unknown) => void)({ id: "u-new", label: "Pack", price: "7.50" }),
    );
    expect(startEditing).not.toHaveBeenCalled();
    expect(setText).not.toHaveBeenCalled();
    expect(screen.getByTestId("units-v2-add-note")).toHaveTextContent(
      "Unit added. Type its price in the grid.",
    );
  });

  it("is injected on a clean draft when the row is served (the control case)", () => {
    mount(false);
    act(() =>
      (addProps.onAdded as (a: unknown) => void)({ id: "u-new", label: "Pack", price: "7.50" }),
    );
    expect(startEditing).toHaveBeenCalledTimes(1);
    expect(setText).toHaveBeenCalledWith("u-new", 1, "7.50", "");
    expect(screen.queryByTestId("units-v2-add-note")).toBeNull();
  });
});
