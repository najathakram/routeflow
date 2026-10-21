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
const isPinned = () => line().className.split(/\s+/).includes("fixed");
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
    for (const c of ["fixed", "bg-white/95", "backdrop-blur"]) expect(cls).toContain(c);
    // A sticky line only sticks inside its own (short) section, so it never reached the viewport bottom.
    expect(cls).not.toContain("sticky");
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

  it("holds when the line pins under a pointer already resting there (no mouseenter ever fires)", () => {
    // K11-20c (MM probe at 768/390): the line pins where the bar's Save was, under the pointer that just clicked it.
    // The browser reports it as :hover, but a node that appears under a still pointer never gets mouseenter.
    const matches = jest.spyOn(Element.prototype, "matches");
    matches.mockImplementation(function (this: Element, sel: string) {
      return sel === ":hover" ? this.id === "units-msg" : false;
    });
    try {
      render(<Section />);
      save("a1");
      tick(20_000);
      expect(isPinned()).toBe(true);
      matches.mockImplementation(() => false);
      fireEvent.mouseLeave(line());
      tick(4999);
      expect(isPinned()).toBe(true);
      tick(1);
      tick(200);
      expect(isPinned()).toBe(false);
    } finally {
      matches.mockRestore();
    }
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
        `scroll:${JSON.stringify(arg)}:pinned=${this.className.split(/\s+/).includes("fixed")}`,
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

  describe("no layout shift when the line settles (MM's proof: content below jumped by the line's height)", () => {
    const H = 45;
    let spy: jest.SpyInstance;
    let height = H;
    beforeEach(() => {
      height = H;
      // jsdom cannot lay out: the status node "measures" `height` wherever it is once it has content (an empty one is 0).
      spy = jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.getAttribute("data-testid") === "units-v2-save-status" && this.textContent
          ? height
          : 0;
      });
    });
    afterEach(() => spy.mockRestore());

    const slot = () => line().parentElement as HTMLElement;
    const minH = () => Number.parseFloat(slot().style.minHeight || "0") || 0;
    /** What the section sees for the line: the container's reservation, or the node's own in-flow box. */
    const footprint = () => Math.max(minH(), isPinned() ? 0 : line().offsetHeight);

    it("(e) before any save the container reserves nothing", () => {
      render(<Section />);
      expect(slot().style.minHeight).toBe("");
      expect(footprint()).toBe(0);
    });

    it("(a) while pinned the container reserves the node's measured height; the node is fixed", () => {
      render(<Section />);
      save("a1");
      expect(isPinned()).toBe(true);
      expect(slot().style.minHeight).toBe(`${H}px`);
      expect(slot().getAttribute("role")).toBeNull();
      expect(slot().contains(line())).toBe(true);
      expect(slot().querySelectorAll("[role=status]")).toHaveLength(1);
    });

    it("(b)+(c) the footprint never drops below the pinned height at any step, and one 'Saved' region throughout", () => {
      render(<Section />);
      save("a1");
      const seen: number[] = [];
      const step = () => {
        seen.push(footprint());
        expect(savedRegions()).toHaveLength(1);
        expect(savedRegions()[0]).toBe(line());
      };
      step();
      tick(4999);
      step();
      tick(1); // fading: still fixed, still reserved
      expect(line().getAttribute("data-pinned")).toBe("settling");
      step();
      tick(149);
      step();
      tick(1); // settled in the same render the reservation is dropped
      expect(isPinned()).toBe(false);
      expect(slot().style.minHeight).toBe("");
      step();
      expect(seen.every((h) => h >= H)).toBe(true);
    });

    it("(b) reduced motion: un-pins instantly with no gap in the footprint", () => {
      reducedMotion(true);
      render(<Section />);
      save("a1");
      expect(footprint()).toBe(H);
      tick(5000);
      expect(isPinned()).toBe(false);
      expect(slot().style.minHeight).toBe("");
      expect(footprint()).toBe(H);
    });

    it("(d) a second save restarts the pin and re-measures", () => {
      render(<Section />);
      save("a1");
      tick(5000);
      tick(150);
      expect(slot().style.minHeight).toBe("");
      height = 64; // e.g. the second save wraps to two lines
      save("a2");
      expect(isPinned()).toBe(true);
      expect(slot().style.minHeight).toBe("64px");
      expect(savedRegions()).toHaveLength(1);
    });

    it("re-measures a pinned line whose content changes (a different summary)", () => {
      const { rerender } = render(<Section />);
      save("a1");
      expect(slot().style.minHeight).toBe(`${H}px`);
      height = 70;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(slot().style.minHeight).toBe("70px");
      rerender(<Section />);
    });

    it("Undo while pinned un-pins and drops the reservation in the same render", async () => {
      undo.mockResolvedValueOnce(CHANGED);
      render(<Section />);
      save("a1");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      await screen.findByText("Wholesale Case");
      expect(slot().style.minHeight).toBe("");
    });

    it("a new edit clears the line and the reservation", () => {
      render(<Section />);
      save("a1");
      act(() => setDirty(true));
      expect(slot().style.minHeight).toBe("");
    });
  });

  describe("docked to the viewport bottom (it must not sit where its section ends)", () => {
    const rectOf = (r: Partial<DOMRect>) =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...r }) as DOMRect;
    let spy: jest.SpyInstance;
    afterEach(() => spy?.mockRestore());
    const mockRects = (main: Partial<DOMRect> | null, column: Partial<DOMRect>) => {
      spy = jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
        this: Element,
      ) {
        if (this.id === "main-content" && main) return rectOf(main);
        if (this.tagName === "SECTION") return rectOf(column);
        return rectOf({});
      });
    };

    it("is position: fixed (one node), bottom = the gap under #main-content, left/width = the content column", () => {
      const main = document.createElement("div");
      main.id = "main-content";
      document.body.appendChild(main);
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
      mockRects({ bottom: 880 }, { left: 280, width: 760 });
      render(<Section />);
      save("a1");
      expect(savedRegions()).toHaveLength(1);
      const el = line();
      expect(el.className.split(/\s+/)).toContain("fixed");
      expect(el.style.bottom).toBe("20px");
      expect(el.style.left).toBe("280px");
      expect(el.style.width).toBe("760px");
      tick(5000);
      tick(200);
      // Settled: the same node, back in the flow, with no fixed geometry left over.
      expect(line()).toBe(el);
      expect(el.className.split(/\s+/)).not.toContain("fixed");
      expect(el.style.bottom).toBe("");
      expect(el.style.left).toBe("");
    });

    it("sits flush at the viewport bottom when there is no shell", () => {
      mockRects(null, { left: 0, width: 500 });
      render(<Section />);
      save("a1");
      expect(line().style.bottom).toBe("0px");
    });
  });
});
