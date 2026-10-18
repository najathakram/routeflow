import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PriceSaveStatusLine } from "./SaveStatusLine";
import type { LastSave } from "./types";

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const SAVE: LastSave = {
  auditId: "audit-1",
  revision: 7,
  undo: { patches: [{}], customerMoves: [] },
};
const undo = jest.fn();

/** The page with both surfaces: the section's inline line always mounted, the window's only while it is live. */
function Page() {
  const [lastSave, setLastSave] = React.useState<LastSave | null>(null);
  const [dirty, setDirty] = React.useState(false);
  return (
    <>
      <button onClick={() => (setLastSave(SAVE), setDirty(false))}>window save</button>
      <button onClick={() => setDirty(true)}>do edit</button>
      <PriceSaveStatusLine lastSave={null} undo={undo} />
      <PriceSaveStatusLine
        id="units-msg-window"
        idleUnmounted
        lastSave={lastSave}
        dirty={dirty}
        undo={undo}
        onUndone={() => setLastSave(null)}
      />
    </>
  );
}

beforeEach(() => undo.mockReset());

describe("PriceSaveStatusLine (K11-20c: one live region)", () => {
  it("an idle window line mounts no node, so the page has one status region", () => {
    render(<Page />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(document.getElementById("units-msg")).not.toBeNull();
    expect(document.getElementById("units-msg-window")).toBeNull();
  });

  it("mounts the window line for its save, and unmounts it again on the next edit", () => {
    render(<Page />);
    fireEvent.click(screen.getByText("window save"));
    expect(document.getElementById("units-msg-window")).toHaveTextContent("Saved");
    fireEvent.click(screen.getByText("do edit"));
    expect(document.getElementById("units-msg-window")).toBeNull();
  });

  it("keeps 'Save undone.' mounted after the draft forgets the save, until the next edit", async () => {
    undo.mockResolvedValueOnce({ status: "undone" });
    render(<Page />);
    fireEvent.click(screen.getByText("window save"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(document.getElementById("units-msg-window")).toHaveTextContent("Save undone."),
    );
    expect(document.activeElement?.id).toBe("units-msg-window");
    fireEvent.click(screen.getByText("do edit"));
    expect(document.getElementById("units-msg-window")).toBeNull();
  });
});
