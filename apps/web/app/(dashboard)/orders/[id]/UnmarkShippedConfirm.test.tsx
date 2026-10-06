import { fireEvent, render, screen } from "@testing-library/react";
import { UnmarkShippedConfirm } from "./UnmarkShippedConfirm";

describe("UnmarkShippedConfirm (fold 4)", () => {
  it("shows the approved copy; Continue confirms, Cancel dismisses", () => {
    const onConfirm = jest.fn();
    const onClose = jest.fn();
    render(<UnmarkShippedConfirm open onClose={onClose} onConfirm={onConfirm} />);
    expect(
      screen.getByText(
        "This order's invoice was issued as final. Unmarking turns it back into a draft that can change. Continue?",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
