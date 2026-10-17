import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PriceDraftContext, type PriceDraft } from "../edit/usePriceDraft";
import { UnitStructureControls } from "./UnitStructure";

// K10d fold: Reset to Auto's Apply is gated on the shared draft being clean, not only by the panel closing itself.
const resetProps: Array<Record<string, unknown>> = [];
jest.mock("../units", () => ({
  ...jest.requireActual("../units"),
  ResetToAutoPanel: (p: Record<string, unknown>) => {
    resetProps.push(p);
    return <button data-testid="reset-stub" onClick={() => (p.onApply as () => void)()} />;
  },
}));
jest.mock("@/lib/api/usePriceGrid", () => ({
  usePriceGrid: () => ({
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
      ],
    },
  }),
}));

const startEditing = jest.fn();
const resetAllToAuto = jest.fn();
const draftOf = (dirty: boolean) =>
  ({
    dirty,
    startEditing,
    resetAllToAuto,
    editing: false,
    api: { setText: jest.fn() },
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
