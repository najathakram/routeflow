import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PriceSaveStatusLine, usePriceSaveStatus } from "./SaveStatusLine";
import { useUndoPriceSave } from "./useUndoPriceSave";

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("./useUndoPriceSave");

const undo = jest.fn();
(useUndoPriceSave as jest.Mock).mockReturnValue({ undo });

const CHANGE = { saveId: "save-1", summary: "3 prices changed." };

/** A pricing section with a stand-in save bar (K3) that reports a save and a draft edit. */
function Section() {
  const status = usePriceSaveStatus();
  return (
    <section aria-label="Prices">
      <button onClick={() => status.onSaved(CHANGE)}>do save</button>
      <button onClick={() => status.onEdit()}>do edit</button>
      <PriceSaveStatusLine productId="p1" status={status} />
    </section>
  );
}

beforeEach(() => {
  toast.mockReset();
  undo.mockReset();
});

describe("PriceSaveStatusLine (V07)", () => {
  it("shows Saved + Undo in the pricing section after a save, and fires no toast", () => {
    render(<Section />);
    fireEvent.click(screen.getByText("do save"));
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Saved.");
    expect(line).toHaveTextContent("3 prices changed.");
    expect(screen.getByRole("region", { name: "Prices" })).toContainElement(line);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not steal focus when the save lands", () => {
    render(<Section />);
    const trigger = screen.getByText("do save");
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it("Undo runs the inverse write exactly once", async () => {
    undo.mockResolvedValue({ status: "undone" });
    render(<Section />);
    fireEvent.click(screen.getByText("do save"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save undone"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith(CHANGE, undefined);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a second edit clears the Undo", () => {
    render(<Section />);
    fireEvent.click(screen.getByText("do save"));
    fireEvent.click(screen.getByText("do edit"));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("shows the preview first when the server says prices changed, and writes nothing", async () => {
    undo.mockResolvedValueOnce({
      status: "changed",
      rows: [{ ref: "case", label: "Wholesale Case", current: "$14.50", restoreTo: "$13.91" }],
    });
    render(<Section />);
    fireEvent.click(screen.getByText("do save"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Wholesale Case")).toBeInTheDocument();
    expect(screen.getByText("$13.91")).toBeInTheDocument();
    expect(undo).toHaveBeenCalledTimes(1);

    undo.mockResolvedValueOnce({ status: "undone" });
    fireEvent.click(screen.getByRole("button", { name: "Undo these prices" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save undone"));
    expect(undo).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenLastCalledWith(CHANGE, { confirmed: true });
  });

  it("Escape closes the preview and returns focus to Undo", async () => {
    undo.mockResolvedValueOnce({
      status: "changed",
      rows: [{ ref: "case", label: "Wholesale Case", current: "$14.50", restoreTo: "$13.91" }],
    });
    render(<Section />);
    fireEvent.click(screen.getByText("do save"));
    const undoBtn = screen.getByRole("button", { name: "Undo" });
    fireEvent.click(undoBtn);
    await screen.findByText("Wholesale Case");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Wholesale Case")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo" }));
  });
});
