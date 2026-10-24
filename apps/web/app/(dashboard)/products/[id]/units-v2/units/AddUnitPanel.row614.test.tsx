import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddUnitPanel } from "./AddUnitPanel";

// Row 614 sibling: a second click on Add while the create is in flight must not create a second unit.
const mutate = jest.fn();
jest.mock("@/lib/api/product-units", () => ({
  useCreateProductUnit: () => ({ mutate, isPending: false }),
}));

it("a double click on Add creates one unit", async () => {
  mutate.mockReset();
  render(
    <AddUnitPanel
      productId="p1"
      baseLabel="Piece"
      ofUnits={[{ label: "Pack", factorToBase: 6 }]}
    />,
  );
  await userEvent.click(screen.getByTestId("units-v2-add-open"));
  await userEvent.type(screen.getByTestId("units-v2-add-name"), "Box");
  await userEvent.type(screen.getByTestId("units-v2-add-n"), "12");
  const submit = screen.getByTestId("units-v2-add-submit");
  act(() => {
    fireEvent.click(submit);
    fireEvent.click(submit);
  });
  expect(mutate).toHaveBeenCalledTimes(1);
});
