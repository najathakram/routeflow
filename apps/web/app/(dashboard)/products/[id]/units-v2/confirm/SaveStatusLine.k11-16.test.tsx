import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PriceSaveStatusLine } from "./SaveStatusLine";
import type { LastSave, UndoOutcome } from "./types";

// K11-16: "Saved N prices. Undo" shows where the Edit bar was (the bar's sticky slot) for 5 s, then settles back to its
// place in the section. One live region, never a second copy: the SAME `#units-msg` element is pinned, then un-pinned.

const mk = (auditId: string): LastSave => ({
  auditId,
  revision: 7,
  undo: { patches: [{}, {}, {}], customerMoves: [] },
});
const ROW = { ref: "case", label: "Wholesale Case", current: "$14.50", restoreTo: "$13.91" };
const CHANGED: UndoOutcome = { status: "changed", revision: 8, priceState: "state-8", rows: [ROW] };
const undo = jest.fn();

let setSave: (s: LastSave | null) => void;
let setDirty: (d: boolean) => void;
function Section() {
  const [lastSave, setLastSave] = React.useState<LastSave | null>(null);
  const [dirty, setDirtyState] = React.useState(false);
  setSave = setLastSave;
  setDirty = setDirtyState;
  return (
    <section aria-label="Prices">
      {/* Another live region in the same section, as the real page has (units-v2-add-note). */}
      <p role="status" data-testid="units-v2-add-note" />
      <PriceSaveStatusLine lastSave={lastSave} dirty={dirty} undo={undo} />
    </section>
  );
}

/** The role=status regions whose text mentions "Saved". K11-16: there must only ever be one. */
const savedRegions = () =>
  screen.queryAllByRole("status").filter((n) => /Saved/.test(n.textContent ?? ""));
const line = () => screen.getByTestId("units-v2-save-status");
const isPinned = () => line().className.split(/\s+/).includes("sticky");
const save = (id: string) => act(() => setSave(mk(id)));
const tick = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

function reducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: on && q.includes("prefers-reduced-motion"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  jest.useFakeTimers();
  undo.mockReset();
  reducedMotion(false);
});
afterEach(() => {
  jest.useRealTimers();
  document.getElementById("main-content")?.remove();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("K11-16: the saved line takes the bar's slot for 5 s", () => {
  it("exactly one role=status region carries 'Saved', and it is pinned with the bar's look", () => {
    render(<Section />);
    save("a1");
    expect(savedRegions()).toHaveLength(1);
    expect(savedRegions()[0]).toBe(line());
    const cls = line().className.split(/\s+/);
    for (const c of ["sticky", "bg-white/95", "backdrop-blur"]) expect(cls).toContain(c);
  });

  it("N1: the pinned line has the bar's CURRENT look: a rounded-lg border, off the content edge (no -mx-4 / border-t)", () => {
    render(<Section />);
    save("a1");
    const cls = line().className.split(/\s+/);
    for (const c of ["rounded-lg", "border", "border-surface-border", "px-4", "py-3", "z-30"])
      expect(cls).toContain(c);
    expect(cls).not.toContain("-mx-4");
    expect(cls).not.toContain("border-t");
  });

  it("after 5 s the SAME element loses the pinned look and keeps Saved + Undo (no remount, no second copy)", () => {
    render(<Section />);
    save("a1");
    const el = line();
    tick(4999);
    expect(isPinned()).toBe(true);
    tick(1);
    tick(200);
    expect(line()).toBe(el);
    expect(isPinned()).toBe(false);
    expect(el.className).not.toMatch(/backdrop-blur|bg-white\/95|border-t/);
    expect(savedRegions()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(el).toHaveTextContent("Saved 3 prices.");
  });

  it("restarts the 5 s on each new auditId", () => {
    render(<Section />);
    save("a1");
    tick(3000);
    save("a2");
    tick(3000);
    expect(isPinned()).toBe(true); // 3 s into the second save, the first save's timer is gone
    tick(2000);
    tick(200);
    expect(isPinned()).toBe(false);
    expect(savedRegions()).toHaveLength(1);
  });

  it("pauses while the pointer is over the line, and gives the full 5 s back when it leaves", () => {
    render(<Section />);
    save("a1");
    tick(4000);
    fireEvent.mouseEnter(line());
    tick(20_000);
    expect(isPinned()).toBe(true);
    fireEvent.mouseLeave(line());
    tick(4999);
    expect(isPinned()).toBe(true);
    tick(1);
    tick(200);
    expect(isPinned()).toBe(false);
  });

  it("pauses while focus is inside it (never un-pins under a focused Undo)", () => {
    render(<Section />);
    save("a1");
    const undoBtn = screen.getByRole("button", { name: "Undo" });
    act(() => undoBtn.focus());
    tick(30_000);
    expect(isPinned()).toBe(true);
    expect(undoBtn).toHaveFocus();
    act(() => undoBtn.blur());
    tick(5000);
    tick(200);
    expect(isPinned()).toBe(false);
  });

  it("does not move focus to the line when the save lands", () => {
    render(<Section />);
    const before = document.activeElement;
    save("a1");
    expect(document.activeElement).toBe(before);
  });

  it("a new edit clears the line, pinned or not", () => {
    render(<Section />);
    save("a1");
    act(() => setDirty(true));
    expect(savedRegions()).toHaveLength(0);
    expect(isPinned()).toBe(false);
  });

  it("un-pins with a short opacity fade first, then settles", () => {
    render(<Section />);
    save("a1");
    tick(5000);
    expect(line().className).toContain("opacity-0");
    expect(line().className).toContain("duration-150");
    expect(line().getAttribute("data-pinned")).toBe("settling");
    tick(150);
    expect(line().getAttribute("data-pinned")).toBe("false");
    expect(line().className).not.toContain("opacity-0");
  });

  it("is instant under prefers-reduced-motion", () => {
    reducedMotion(true);
    render(<Section />);
    save("a1");
    tick(5000);
    expect(line().getAttribute("data-pinned")).toBe("false");
    expect(line().className).not.toContain("opacity-0");
  });

  it("Undo while pinned: un-pin first, then scrollIntoView nearest, then the preview", async () => {
    const order: string[] = [];
    Element.prototype.scrollIntoView = jest.fn(function (this: Element, arg?: unknown) {
      order.push(
        `scroll:${JSON.stringify(arg)}:pinned=${this.className.split(/\s+/).includes("sticky")}`,
      );
    });
    undo.mockImplementationOnce(() => {
      order.push("undo-called");
      return Promise.resolve(CHANGED);
    });
    render(<Section />);
    save("a1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(await screen.findByText("Wholesale Case")).toBeInTheDocument();
    expect(order).toEqual(['scroll:{"block":"nearest"}:pinned=false', "undo-called"]);
    expect(isPinned()).toBe(false);
  });

  it("does not re-pin when the preview is dismissed", async () => {
    undo.mockResolvedValueOnce(CHANGED);
    render(<Section />);
    save("a1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    await screen.findByText("Wholesale Case");
    fireEvent.click(screen.getByRole("button", { name: "Keep current prices" }));
    expect(isPinned()).toBe(false);
  });

  it("rests at the real bottom: the pinned line pulls down through the shell's bottom padding (F22)", () => {
    const main = document.createElement("div");
    main.id = "main-content";
    main.style.paddingBottom = "96px";
    document.body.appendChild(main);
    render(<Section />);
    save("a1");
    expect(line().style.bottom).toBe("-96px");
  });

  it("has no bottom offset when there is no shell padding", () => {
    render(<Section />);
    save("a1");
    expect(line().style.bottom).toBe("0px");
  });
});
