import * as React from "react";
import { render, act, cleanup } from "@testing-library/react";
import { registerDraftDockSlot, useDraftDockSlot } from "./draft-dock-slot";

/** SA-1066 A-3: the store that carries the till header's slot element to the draft dock, which sits elsewhere in the tree. */
function Reader({ onRender }: { onRender: (el: HTMLElement | null) => void }) {
  onRender(useDraftDockSlot());
  return null;
}

afterEach(() => {
  cleanup();
  act(() => registerDraftDockSlot(null));
});

describe("draft-dock-slot store", () => {
  it("reads null until a slot registers, then the element, then null again when it goes", () => {
    const seen: Array<HTMLElement | null> = [];
    render(<Reader onRender={(el) => seen.push(el)} />);
    expect(seen[seen.length - 1]).toBeNull();

    const el = document.createElement("div");
    act(() => registerDraftDockSlot(el));
    expect(seen[seen.length - 1]).toBe(el);

    act(() => registerDraftDockSlot(null));
    expect(seen[seen.length - 1]).toBeNull();
  });

  it("registering the element already held does not re-render a reader", () => {
    let renders = 0;
    render(<Reader onRender={() => renders++} />);
    const el = document.createElement("div");
    act(() => registerDraftDockSlot(el));
    const after = renders;
    act(() => registerDraftDockSlot(el));
    expect(renders).toBe(after);
  });

  it("an unmounted reader is unsubscribed: a later registration does not touch it", () => {
    let renders = 0;
    const { unmount } = render(<Reader onRender={() => renders++} />);
    unmount();
    const after = renders;
    act(() => registerDraftDockSlot(document.createElement("div")));
    expect(renders).toBe(after);
  });
});
