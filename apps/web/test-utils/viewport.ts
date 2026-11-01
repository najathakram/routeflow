/**
 * Make `window.matchMedia` answer as a desktop viewport (min-width queries up to 1280px match, max-width and every other
 * query do not). The shared jest.setup.ts stub matches nothing (a phone-sized default); a suite whose component reads a
 * min-width query to decide its layout calls this once at the top of the file to ask for the wide layout.
 */
export function setWideViewport(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const m = /^\(\s*min-width:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(query.trim());
      return {
        matches: m != null && Number(m[1]) <= 1280,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}
