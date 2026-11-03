import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";
import type { LineStockView } from "@/lib/line-stock";

/** SA-1086 PR-2 (CQ-13): the stock note on a counter row is a quiet line that never takes a control away. */

const noop = () => undefined;
const sale: SaleLine = { tempId: "t1", productId: "p1", name: "Cola", unitPrice: 2.5, qty: 2 };

const ready = (level: "ok" | "low" | "out", message: string | null): LineStockView => ({
  state: "ready",
  level,
  label: level === "out" ? "0 pieces left" : "1 box and 8 pieces left",
  message,
  requestedPieces: 24,
});

function renderRow(stock?: LineStockView) {
  return render(
    <ul>
      <CounterLineRow
        line={sale}
        stock={stock}
        locked={false}
        onStep={noop}
        onRemove={noop}
        onNote={noop}
        onQty={() => true}
      />
    </ul>,
  );
}

describe("CounterLineRow stock note", () => {
  it("R1: no stock view, no note", () => {
    renderRow(undefined);
    expect(screen.queryByTestId("line-stock")).toBeNull();
  });

  it("R2: a ready view prints the count under the item; over stock adds the message", () => {
    renderRow(
      ready(
        "low",
        "Only 1 box and 8 pieces left. You can still sell it. Stock will go below zero.",
      ),
    );
    const note = screen.getByTestId("line-stock");
    expect(note).toHaveAttribute("data-level", "low");
    expect(note).toHaveTextContent("1 box and 8 pieces left");
    expect(screen.getByTestId("line-stock-message")).toHaveTextContent(
      "You can still sell it. Stock will go below zero.",
    );
  });

  it("R3: a loading view shows the quiet word", () => {
    renderRow({ state: "loading" });
    expect(screen.getByTestId("line-stock")).toHaveAttribute("data-state", "loading");
  });

  it("R4: even at 'out' the row's own controls stay live (a note, never a gate)", () => {
    renderRow(ready("out", "None left. You can still sell it. Stock will go below zero."));
    expect(screen.getByTestId("line-stock")).toHaveAttribute("data-level", "out");
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add a note to Cola" })).toBeEnabled();
    expect(screen.getByLabelText("Quantity of Cola")).toBeEnabled();
  });
});
