import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RemoveUnitConfirm, RemoveUnitControl } from "./RemoveUnitConfirm";

const mutate = jest.fn();

jest.mock("@/lib/api/product-units", () => ({
  useDeleteProductUnit: () => ({ mutate, isPending: false }),
}));

const UNIT = { id: "u1", label: "Case" };

beforeEach(() => mutate.mockReset());

describe("RemoveUnitConfirm (V17)", () => {
  it("confirms by deleting the unit through the existing endpoint hook", async () => {
    const onClose = jest.fn();
    render(<RemoveUnitConfirm productId="p1" unit={UNIT} onClose={onClose} />);
    expect(screen.getByTestId("units-v2-remove-panel")).toHaveTextContent("Remove the Case?");
    await userEvent.click(screen.getByTestId("units-v2-rm-confirm"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toBe("u1");
  });

  it("closes after a successful delete", async () => {
    mutate.mockImplementation((_id, opts) => opts.onSuccess?.());
    const onClose = jest.fn();
    render(<RemoveUnitConfirm productId="p1" unit={UNIT} onClose={onClose} />);
    await userEvent.click(screen.getByTestId("units-v2-rm-confirm"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal and stays open when the delete fails", async () => {
    mutate.mockImplementation((_id, opts) =>
      opts.onError?.({
        response: { status: 409, data: { message: "A line still uses this unit." } },
      }),
    );
    const onClose = jest.fn();
    render(<RemoveUnitConfirm productId="p1" unit={UNIT} onClose={onClose} />);
    await userEvent.click(screen.getByTestId("units-v2-rm-confirm"));
    expect(screen.getByTestId("units-v2-remove-err")).toHaveTextContent(
      "A line still uses this unit.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Keep it closes without deleting", async () => {
    const onClose = jest.fn();
    render(<RemoveUnitConfirm productId="p1" unit={UNIT} onClose={onClose} />);
    await userEvent.click(screen.getByTestId("units-v2-rm-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("Escape closes it", async () => {
    const onClose = jest.fn();
    render(<RemoveUnitConfirm productId="p1" unit={UNIT} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("starts focus on Keep it (the safe choice)", () => {
    render(<RemoveUnitConfirm productId="p1" unit={UNIT} onClose={jest.fn()} />);
    expect(screen.getByTestId("units-v2-rm-cancel")).toHaveFocus();
  });
});

describe("RemoveUnitControl (the row's Remove button + its confirm)", () => {
  const button = () => screen.getByTestId("units-v2-rm-u1");

  it("shows the confirm on click and no panel before", async () => {
    render(<RemoveUnitControl productId="p1" unit={UNIT} />);
    expect(screen.queryByTestId("units-v2-remove-panel")).toBeNull();
    await userEvent.click(button());
    expect(screen.getByTestId("units-v2-remove-panel")).toBeInTheDocument();
  });

  it("Escape closes the confirm and focuses the row's Remove button", async () => {
    render(<RemoveUnitControl productId="p1" unit={UNIT} />);
    await userEvent.click(button());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("units-v2-remove-panel")).toBeNull();
    expect(button()).toHaveFocus();
  });

  it("Keep it also returns focus to the Remove button", async () => {
    render(<RemoveUnitControl productId="p1" unit={UNIT} />);
    await userEvent.click(button());
    await userEvent.click(screen.getByTestId("units-v2-rm-cancel"));
    expect(button()).toHaveFocus();
  });

  it("is disabled with a hint while the price draft has unsaved changes", () => {
    render(<RemoveUnitControl productId="p1" unit={UNIT} dirty />);
    expect(button()).toBeDisabled();
    expect(screen.getByText("Save or discard your price changes first")).toBeInTheDocument();
  });

  it("is disabled when told so", () => {
    render(<RemoveUnitControl productId="p1" unit={UNIT} disabled />);
    expect(button()).toBeDisabled();
  });
});

describe("RemoveUnitControl a11y and focus (K10d)", () => {
  const button = () => screen.getByTestId("units-v2-rm-u1");

  it("gives each row's confirm its own id and points aria-controls at it", async () => {
    render(<RemoveUnitControl productId="p1" unit={UNIT} />);
    expect(button()).toHaveAttribute("aria-controls", "units-v2-remove-panel-u1");
    await userEvent.click(button());
    expect(document.getElementById("units-v2-remove-panel-u1")).toBe(
      screen.getByTestId("units-v2-remove-panel"),
    );
    expect(document.getElementById("units-v2-remove-panel")).toBeNull();
  });

  it("after a successful delete it hands off to onRemoved and does not refocus the row's own button", async () => {
    mutate.mockImplementation((_id, opts) => opts.onSuccess?.());
    const onRemoved = jest.fn();
    render(<RemoveUnitControl productId="p1" unit={UNIT} onRemoved={onRemoved} />);
    await userEvent.click(button());
    await userEvent.click(screen.getByTestId("units-v2-rm-confirm"));
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("units-v2-remove-panel")).toBeNull();
    expect(button()).not.toHaveFocus();
  });

  it("without onRemoved a successful delete still returns focus to the button", async () => {
    mutate.mockImplementation((_id, opts) => opts.onSuccess?.());
    render(<RemoveUnitControl productId="p1" unit={UNIT} />);
    await userEvent.click(button());
    await userEvent.click(screen.getByTestId("units-v2-rm-confirm"));
    expect(button()).toHaveFocus();
  });
});
