import { act, renderHook } from "@testing-library/react";
import { useBelowBreakpoint } from "./useBelowBreakpoint";

/**
 * ONE phone-breakpoint hook (row 730): it replaces useBelowMd (768) and the order detail's usePhoneWidth (640).
 * jsdom has no matchMedia, so a controllable stub is the viewport.
 */
let width = 390;
const listeners = new Set<() => void>();
const realMatchMedia = window.matchMedia;
function installViewport() {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      get matches() {
        return max ? width <= Number(max[1]) : false;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
      onchange: null,
    };
  }) as unknown as typeof window.matchMedia;
}
const resize = (w: number) => {
  width = w;
  listeners.forEach((l) => l());
};

afterEach(() => {
  window.matchMedia = realMatchMedia;
  listeners.clear();
  width = 390;
});

describe("useBelowBreakpoint", () => {
  it("is false where matchMedia is absent (jsdom, server): the desktop layout", () => {
    const sm = renderHook(() => useBelowBreakpoint("sm"));
    const md = renderHook(() => useBelowBreakpoint("md"));
    expect(sm.result.current).toBe(false);
    expect(md.result.current).toBe(false);
  });

  it("sm is below 640px and md below 768px, read on the first render", () => {
    installViewport();
    width = 700;
    expect(renderHook(() => useBelowBreakpoint("sm")).result.current).toBe(false);
    expect(renderHook(() => useBelowBreakpoint("md")).result.current).toBe(true);
    width = 390;
    expect(renderHook(() => useBelowBreakpoint("sm")).result.current).toBe(true);
    width = 768;
    expect(renderHook(() => useBelowBreakpoint("md")).result.current).toBe(false);
  });

  it("follows a resize across the breakpoint, both ways", () => {
    installViewport();
    const { result } = renderHook(() => useBelowBreakpoint("md"));
    expect(result.current).toBe(true);
    act(() => resize(1024));
    expect(result.current).toBe(false);
    act(() => resize(500));
    expect(result.current).toBe(true);
  });

  it("stops listening on unmount", () => {
    installViewport();
    const { unmount } = renderHook(() => useBelowBreakpoint("sm"));
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
