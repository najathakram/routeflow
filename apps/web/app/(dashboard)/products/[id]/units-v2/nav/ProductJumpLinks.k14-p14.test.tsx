import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { ProductJumpLinks } from "./ProductJumpLinks";

/** K14 P14: Customer view stays the current tab while its section is in view, after its heading scrolled above the strip. */
type Entry = Partial<IntersectionObserverEntry>;
let cb: ((e: Entry[]) => void) | null = null;
class FakeIO {
  constructor(c: (e: Entry[]) => void) {
    cb = c;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const original = (window as { IntersectionObserver?: unknown }).IntersectionObserver;
beforeEach(() => {
  (window as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
  Element.prototype.scrollIntoView = jest.fn();
});
afterAll(() => {
  (window as { IntersectionObserver?: unknown }).IntersectionObserver = original;
});

const top = (id: string, y: number) => {
  document.getElementById(id)!.getBoundingClientRect = () => ({ top: y }) as DOMRect;
};

it("keeps Customer view current when its heading has scrolled above the strip and no heading is in the band", () => {
  render(
    <div>
      <ProductJumpLinks />
      <h1 id="h-product">Cola</h1>
      <h2 id="h-units">Units</h2>
      <h2 id="h-cust">Customer</h2>
      <h2 id="h-sales">Sales</h2>
    </div>,
  );
  top("h-product", -2000);
  top("h-units", -1200);
  top("h-cust", -300);
  top("h-sales", 1500);
  act(() => {
    cb?.([{ target: document.getElementById("h-cust")!, isIntersecting: false }]);
  });
  expect(screen.getByTestId("units-v2-jump-h-cust")).toHaveAttribute("aria-current", "true");
  expect(screen.getByTestId("units-v2-jump-h-units")).not.toHaveAttribute("aria-current");
});

it("marks nothing at the page top, before any heading has passed", () => {
  render(
    <div>
      <ProductJumpLinks />
      <h1 id="h-product">Cola</h1>
      <h2 id="h-units">Units</h2>
    </div>,
  );
  top("h-product", 50);
  top("h-units", 600);
  act(() => {
    cb?.([{ target: document.getElementById("h-units")!, isIntersecting: false }]);
  });
  expect(screen.getByTestId("units-v2-jump-h-units")).not.toHaveAttribute("aria-current");
});
