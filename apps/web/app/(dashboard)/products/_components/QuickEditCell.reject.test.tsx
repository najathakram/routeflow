import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickEditCell } from "./QuickEditCell";

/** Invalid Quick Edit input: onSave resolving `false` rejects the value and the cell stays open. */
describe("QuickEditCell: onSave resolving false keeps the cell in edit mode", () => {
  const open = (onSave: jest.Mock) => {
    render(
      <QuickEditCell
        productId="p-1"
        productName="Sample Cola"
        field="unitsPerBox"
        type="number"
        min={1}
        step={1}
        value="12"
        quickEditMode
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTitle("Click to edit unitsPerBox"));
    return screen.getByRole("spinbutton") as HTMLInputElement;
  };

  it("renders a number input with min 1 and step 1", () => {
    const input = open(jest.fn());
    expect(input.type).toBe("number");
    expect(input.min).toBe("1");
    expect(input.step).toBe("1");
  });

  it("false from onSave: still editing, draft kept", async () => {
    const onSave = jest.fn().mockResolvedValue(false);
    const input = open(onSave);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toBe("0");
    expect(screen.getByRole("spinbutton")).toHaveProperty("value", "0");
  });

  it("garbled number input (badInput, value '') never saves as a cleared cell; the cell stays open", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const input = open(onSave);
    // jsdom can't produce badInput; a browser reports "1e" as value "" with validity.badInput true.
    fireEvent.change(input, { target: { value: "" } });
    Object.defineProperty(input, "validity", { value: { badInput: true }, configurable: true });
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("spinbutton")).toBeTruthy();
  });

  it("void from onSave: the cell closes as before", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const input = open(onSave);
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("spinbutton")).toBeNull());
  });
});
