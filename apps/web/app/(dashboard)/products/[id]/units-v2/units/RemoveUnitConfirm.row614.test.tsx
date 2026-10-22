import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { RemoveUnitConfirm } from "./RemoveUnitConfirm";

// Row 614 sibling: a second click on Remove while the delete is in flight must not send a second DELETE.
const mutate = jest.fn();
jest.mock("@/lib/api/product-units", () => ({
  useDeleteProductUnit: () => ({ mutate, isPending: false }),
}));

it("a double click on Remove deletes the unit once", () => {
  mutate.mockReset();
  render(
    <RemoveUnitConfirm productId="p1" unit={{ id: "u1", label: "Case" }} onClose={jest.fn()} />,
  );
  const confirm = screen.getByTestId("units-v2-rm-confirm");
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  expect(mutate).toHaveBeenCalledTimes(1);
});
