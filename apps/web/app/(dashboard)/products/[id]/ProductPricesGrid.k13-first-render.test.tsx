import * as React from "react";
import { renderHook } from "@testing-library/react";
import { useContainsColumn } from "./ProductPricesGrid";

// FE2 / K13 P01: the Contains column decision must be right on the FIRST render. Starting wide and flipping after paint
// would move the grid on load at 768 (a layout shift the feel prober measures).
describe("useContainsColumn first render", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });
  const media = (matches: boolean) =>
    (() => ({
      matches,
      media: "",
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

  it("is narrow from the first render when the viewport is narrow", () => {
    window.matchMedia = media(false);
    const seen: boolean[] = [];
    renderHook(() => {
      const v = useContainsColumn();
      seen.push(v);
      return v;
    });
    expect(seen[0]).toBe(false);
  });

  it("is wide from the first render when the viewport is wide", () => {
    window.matchMedia = media(true);
    const { result } = renderHook(() => useContainsColumn());
    expect(result.current).toBe(true);
  });
});
