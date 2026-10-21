import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";

/** B1227 at the row level: opening the note puts the cursor in the field, so typed text never reaches a page shortcut. */
const base: SaleLine = { tempId: "t1", productId: "p1", name: "Cola", unitPrice: 2.5, qty: 1 };

describe("CounterLineRow Add note focus (B1227)", () => {
  it("Add note moves focus into the note field (B1227)", () => {
    render(
      <ul>
        <CounterLineRow
          line={base}
          locked={false}
          onStep={() => undefined}
          onRemove={() => undefined}
          onNote={() => undefined}
          onQty={() => true}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a note to Cola" }));
    expect(screen.getByLabelText("Note for Cola")).toHaveFocus();
  });
});
