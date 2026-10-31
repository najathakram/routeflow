import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// findBy*/waitFor default to 1 s; give slow hosts headroom (see testTimeout in jest.config.js).
configure({ asyncUtilTimeout: 10_000 });

// Per-test isolation for history.state (e.g. the settings hub keeps its search on its own history entry).
afterEach(() => {
  try {
    window.history.replaceState(null, "");
  } catch {
    /* no DOM in this environment */
  }
});

// jsdom has no matchMedia; components that read it on mount (the install banner, reduced-motion hooks) would throw.
// The stub matches nothing, the answer code that treats "no matchMedia" as narrow already got. A suite that needs the wide
// layout calls setWideViewport() (test-utils/viewport.ts); one that needs another answer sets its own.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
