import * as React from "react";
import { act, render } from "@testing-library/react";
import { useBuyerCart, type CartItem } from "./buyer-cart";

/**
 * The cart hook broadcasts a "cart-updated" event so OTHER hook instances in the tab (the nav badge) refresh.
 * Doing that from inside a setState updater runs it during render, and React warns "Cannot update a component
 * while rendering a different component" on the first box click. A mutator must write + broadcast AFTER computing.
 */
const cola: CartItem = {
  productId: "p1",
  name: "Cola",
  unit: "bottle",
  unitsPerBox: 12,
  qty: 24,
  boxes: 2,
  pieces: 0,
};

let api: ReturnType<typeof useBuyerCart>;
function Badge() {
  const c = useBuyerCart("buyer-1", "acme");
  return <span data-testid="badge">{c.totalQty}</span>;
}
function Control() {
  api = useBuyerCart("buyer-1", "acme");
  return <span data-testid="ctl">{api.totalQty}</span>;
}
function Page() {
  return (
    <>
      <Badge />
      <Control />
    </>
  );
}

describe("setBoxesPieces: no setState during render", () => {
  it("a box edit with a second hook instance mounted raises no React render-phase warning", () => {
    localStorage.clear();
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const r = render(<Page />);
    act(() => api.addItem(cola));
    err.mockClear();
    // two edits in one tick: the second updater runs DURING render (React only runs the first eagerly)
    act(() => {
      api.setBoxesPieces("p1", 3, 0);
      api.setBoxesPieces("p1", 4, 0);
    });
    expect(r.getByTestId("badge")).toHaveTextContent("48");
    const warned = err.mock.calls.some((c) => String(c[0]).includes("Cannot update a component"));
    err.mockRestore();
    expect(warned).toBe(false);
  });

  it("a box edit broadcasts cart-updated exactly once, even in StrictMode (a side effect in an updater runs twice)", () => {
    localStorage.clear();
    render(
      <React.StrictMode>
        <Page />
      </React.StrictMode>,
    );
    act(() => api.addItem(cola));
    const seen: Event[] = [];
    const on = (e: Event) => seen.push(e);
    window.addEventListener("cart-updated", on);
    act(() => api.setBoxesPieces("p1", 3, 0));
    window.removeEventListener("cart-updated", on);
    expect(seen).toHaveLength(1);
  });

  it.each([
    [
      "addItem (plus on the catalog / an existing line)",
      (a: typeof api) =>
        a.addItem({
          ...cola,
          productId: "p2",
          qty: 3,
          boxes: undefined,
          pieces: undefined,
          unitsPerBox: 1,
        }),
    ],
    ["updateQty (the simple-qty stepper's + and -)", (a: typeof api) => a.updateQty("p3", 5)],
    ["removeItem", (a: typeof api) => a.removeItem("p3")],
  ])("%s broadcasts cart-updated exactly once, even in StrictMode", (_n, run) => {
    localStorage.clear();
    render(
      <React.StrictMode>
        <Page />
      </React.StrictMode>,
    );
    act(() => api.addItem({ productId: "p3", name: "Chips", unit: "ea", unitsPerBox: 1, qty: 4 }));
    const seen: Event[] = [];
    const on = (e: Event) => seen.push(e);
    window.addEventListener("cart-updated", on);
    act(() => run(api));
    window.removeEventListener("cart-updated", on);
    expect(seen).toHaveLength(1);
  });

  it("two edits in one tick compose (the second sees the first)", () => {
    localStorage.clear();
    render(<Page />);
    act(() => api.addItem(cola));
    act(() => {
      api.setBoxesPieces("p1", 3, 0);
      api.setBoxesPieces("p1", 3, 5);
    });
    expect(api.items[0]).toMatchObject({ boxes: 3, pieces: 5, qty: 41 });
  });
});
