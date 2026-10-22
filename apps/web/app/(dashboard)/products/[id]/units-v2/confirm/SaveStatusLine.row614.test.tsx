import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PriceSaveStatusLine } from "./SaveStatusLine";

// Row 614 sibling: a second Undo click while the first is in flight must not undo twice.
it("a double click on Undo asks for one undo", () => {
  const undo = jest.fn(() => new Promise<never>(() => {}));
  render(
    <PriceSaveStatusLine
      lastSave={{ auditId: "a1", revision: 7, undo: { patches: [{}], customerMoves: [] } }}
      undo={undo}
    />,
  );
  const btn = screen.getByRole("button", { name: "Undo" });
  act(() => {
    fireEvent.click(btn);
    fireEvent.click(btn);
  });
  expect(undo).toHaveBeenCalledTimes(1);
});
