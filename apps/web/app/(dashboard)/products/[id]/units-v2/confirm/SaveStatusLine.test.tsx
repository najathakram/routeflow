import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PriceSaveStatusLine } from "./SaveStatusLine";
import type { LastSave, UndoOutcome } from "./types";

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const SAVE: LastSave = {
  auditId: "audit-1",
  revision: 7,
  undo: { patches: [{}, {}, {}], customerMoves: [] },
};
const ROW = { ref: "case", label: "Wholesale Case", current: "$14.50", restoreTo: "$13.91" };
const CHANGED: UndoOutcome = { status: "changed", revision: 8, priceState: "state-8", rows: [ROW] };

const undo = jest.fn();

/** A pricing section with stand-ins for K3's save bar: save sets lastSave, edit sets dirty. */
function Section({ save = SAVE }: { save?: LastSave }) {
  const [lastSave, setLastSave] = React.useState<LastSave | null>(null);
  const [dirty, setDirty] = React.useState(false);
  return (
    <section aria-label="Prices">
      <button
        onClick={() => {
          setLastSave(save);
          setDirty(false);
        }}
      >
        do save
      </button>
      <button onClick={() => setDirty(true)}>do edit</button>
      <button onClick={() => setLastSave(null)}>do forget</button>
      <PriceSaveStatusLine
        lastSave={lastSave}
        dirty={dirty}
        undo={undo}
        onUndone={() => setLastSave(null)}
      />
    </section>
  );
}

const saveIt = () => fireEvent.click(screen.getByText("do save"));
const undoBtn = () => screen.getByRole("button", { name: "Undo" });
const openPreview = async () => {
  undo.mockResolvedValueOnce(CHANGED);
  render(<Section />);
  saveIt();
  fireEvent.click(undoBtn());
  await screen.findByText("Wholesale Case");
};

beforeEach(() => {
  toast.mockReset();
  undo.mockReset();
});

describe("PriceSaveStatusLine (V07)", () => {
  it("shows Saved + Undo in the pricing section after a save, and fires no toast", () => {
    render(<Section />);
    saveIt();
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Saved 3 prices.");
    expect(screen.getByRole("region", { name: "Prices" })).toContainElement(line);
    expect(undoBtn()).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("builds the summary from counts only", () => {
    render(<Section save={{ ...SAVE, undo: { patches: [{}], customerMoves: [{}, {}] } }} />);
    saveIt();
    expect(screen.getByRole("status")).toHaveTextContent("Saved 1 price and 2 customer prices.");
  });

  it("does not steal focus when the save lands", () => {
    render(<Section />);
    const trigger = screen.getByText("do save");
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it("Undo runs the inverse write exactly once, then focuses the line", async () => {
    undo.mockResolvedValue({ status: "undone" });
    render(<Section />);
    saveIt();
    fireEvent.click(undoBtn());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save undone"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith({ confirmed: false });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(toast).not.toHaveBeenCalled();
  });

  it("K8: once the draft forgets the undone save, 'Save undone.' stays and Undo is gone", async () => {
    undo.mockResolvedValueOnce({ status: "undone" });
    render(<Section />);
    saveIt();
    fireEvent.click(undoBtn());
    expect(await screen.findByText("Save undone.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    // the Undo-able line, by contrast, goes when the draft forgets its save without an undo
    fireEvent.click(screen.getByText("do edit"));
    expect(screen.queryByText("Save undone.")).toBeNull();
  });

  it("K8: an Undo-able line goes when the draft forgets its save (nothing left to undo)", () => {
    render(<Section />);
    saveIt();
    expect(undoBtn()).toBeTruthy();
    fireEvent.click(screen.getByText("do forget"));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a second edit clears the Undo", () => {
    render(<Section />);
    saveIt();
    fireEvent.click(screen.getByText("do edit"));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("previews first when prices changed, and writes nothing", async () => {
    await openPreview();
    expect(screen.getByText("$13.91")).toBeInTheDocument();
    expect(screen.getByText("would become")).toBeInTheDocument();
    expect(undoBtn()).toHaveAttribute("aria-controls", screen.getByRole("group").id);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("K8: the preview says how many customer prices the Undo also writes", async () => {
    undo.mockResolvedValueOnce({ ...CHANGED, customerMoves: 2 });
    render(<Section />);
    saveIt();
    fireEvent.click(undoBtn());
    expect(await screen.findByText("and 2 customer prices")).toBeTruthy();
  });

  it("K8: a strict-undo conflict lists the customer cells that changed, and Undo still needs the fresh tokens", async () => {
    undo.mockResolvedValueOnce({
      ...CHANGED,
      conflicts: [{ ref: "c0", label: "Acme, Can", current: "$1.20", restoreTo: "$1.13" }],
    });
    render(<Section />);
    saveIt();
    fireEvent.click(undoBtn());
    const list = await screen.findByTestId("units-v2-undo-conflicts");
    expect(list.textContent).toContain("Customer prices changed since you saved");
    expect(list.textContent).toContain("Acme, Can");
    expect(list.textContent).toContain("$1.20");
    undo.mockResolvedValueOnce({ status: "undone" });
    fireEvent.click(screen.getByRole("button", { name: "Undo these prices" }));
    await waitFor(() =>
      expect(undo).toHaveBeenLastCalledWith({
        confirmed: true,
        expectedRevision: 8,
        expectedPriceState: "state-8",
      }),
    );
  });

  it("the confirmed Undo re-sends the preview's revision and price state", async () => {
    await openPreview();
    undo.mockResolvedValueOnce({ status: "undone" });
    fireEvent.click(screen.getByRole("button", { name: "Undo these prices" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save undone"));
    expect(undo).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenLastCalledWith({
      confirmed: true,
      expectedRevision: 8,
      expectedPriceState: "state-8",
    });
  });

  it("a confirmed Undo answered `changed` again re-previews with the newer tokens", async () => {
    await openPreview();
    undo.mockResolvedValueOnce({
      status: "changed",
      revision: 9,
      priceState: "state-9",
      rows: [{ ...ROW, label: "Wholesale Box", current: "$99.00" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo these prices" }));
    expect(await screen.findByText("Wholesale Box")).toBeInTheDocument();
    expect(screen.queryByText("Wholesale Case")).toBeNull();
    undo.mockResolvedValueOnce({ status: "undone" });
    fireEvent.click(screen.getByRole("button", { name: "Undo these prices" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save undone"));
    expect(undo).toHaveBeenLastCalledWith({
      confirmed: true,
      expectedRevision: 9,
      expectedPriceState: "state-9",
    });
  });

  it("Escape closes the preview and returns focus to Undo", async () => {
    await openPreview();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Wholesale Case")).toBeNull();
    expect(document.activeElement).toBe(undoBtn());
  });

  it("Keep current prices closes the preview, writes nothing and refocuses Undo", async () => {
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Keep current prices" }));
    expect(screen.queryByText("Wholesale Case")).toBeNull();
    expect(document.activeElement).toBe(undoBtn());
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("a failed confirm shows the error and refocuses Undo", async () => {
    await openPreview();
    undo.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Undo these prices" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't undo"));
    expect(document.activeElement).toBe(undoBtn());
  });

  it("disables both preview buttons while the confirmed write is in flight", async () => {
    await openPreview();
    undo.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Undo these prices" }));
    expect(screen.getByRole("button", { name: "Keep current prices" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo these prices" })).toBeDisabled();
  });

  it("an already-undone save says so and offers no Undo", async () => {
    undo.mockResolvedValueOnce({ status: "unavailable" });
    render(<Section />);
    saveIt();
    fireEvent.click(undoBtn());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("can't be undone"));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
