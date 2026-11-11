import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PriceSaveStatusLine } from "./SaveStatusLine";
import type { LastSave } from "./types";

// W-1170 F13: on a phone the 5 s pin gave the line back to its inline slot below the grid, off screen, so the user lost
// Undo. On a coarse pointer or a viewport under 768 px the line stays pinned until the next edit, an Undo or Dismiss.

const mk = (auditId: string): LastSave => ({
  auditId,
  revision: 7,
  undo: { patches: [{}, {}, {}], customerMoves: [] },
});
const undo = jest.fn();
let setSave: (s: LastSave | null) => void;
let setDirty: (d: boolean) => void;
function Section() {
  const [lastSave, setLastSave] = React.useState<LastSave | null>(null);
  const [dirty, setDirtyState] = React.useState(false);
  setSave = setLastSave;
  setDirty = setDirtyState;
  return <PriceSaveStatusLine lastSave={lastSave} dirty={dirty} undo={undo} />;
}
const line = () => screen.getByTestId("units-v2-save-status");
const isPinned = () => line().className.split(/\s+/).includes("fixed");
const tick = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
/** Past the 5 s pin AND the fade that follows it (two timers, the second set after the first commits). */
const pastPin = () => {
  tick(5_000);
  tick(1_000);
  tick(10_000);
};

function media(match: (q: string) => boolean) {
  window.matchMedia = ((q: string) => ({
    matches: match(q),
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
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe("W-1170 F13: the saved line keeps Undo in view on a phone", () => {
  it("coarse pointer: still pinned after 5 s, with a 44 px Dismiss that lets go", () => {
    media((q) => q.includes("pointer: coarse"));
    render(<Section />);
    act(() => setSave(mk("a1")));
    expect(isPinned()).toBe(true);
    pastPin();
    expect(isPinned()).toBe(true);
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss.className).toContain("min-h-11");
    fireEvent.click(dismiss);
    expect(isPinned()).toBe(false);
    expect(screen.getByTestId("units-v2-save-undo")).toBeTruthy();
  });

  it("a narrow viewport (under 768 px) behaves the same", () => {
    media((q) => q.includes("max-width: 767px"));
    render(<Section />);
    act(() => setSave(mk("a1")));
    pastPin();
    expect(isPinned()).toBe(true);
  });

  it("the next edit clears the pinned line", () => {
    media((q) => q.includes("pointer: coarse"));
    render(<Section />);
    act(() => setSave(mk("a1")));
    pastPin();
    act(() => setDirty(true));
    expect(screen.queryByTestId("units-v2-save-status")?.textContent ?? "").not.toContain("Saved");
  });

  it("desktop: unpinned after 5 s and no Dismiss", () => {
    media(() => false);
    render(<Section />);
    act(() => setSave(mk("a1")));
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    pastPin();
    expect(isPinned()).toBe(false);
  });
});
