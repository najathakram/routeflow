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

/**
 * Make `window.matchMedia` answer as a viewport of the given width: `(min-width: Npx)` matches when the
 * width is at least N, `(max-width: Npx)` when it is at most N, and every other query does not match.
 * Returns `resize`, which changes the width and tells every `change` listener, so a test can cross a
 * breakpoint the way a rotated phone or a dragged window does (wrap the call in `act`).
 */
export function setViewportWidth(initial: number): (width: number) => void {
  let width = initial;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const m = /^\(\s*(min|max)-width:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(query.trim());
      const answer = () =>
        m == null ? false : m[1] === "min" ? width >= Number(m[2]) : width <= Number(m[2]);
      return {
        get matches() {
          return answer();
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type: string, listener: unknown) => {
          listeners.add(listener as () => void);
        },
        removeEventListener: (_type: string, listener: unknown) => {
          listeners.delete(listener as () => void);
        },
        dispatchEvent: () => false,
      } as MediaQueryList;
    },
  });
  return (next: number) => {
    width = next;
    listeners.forEach((l) => l());
  };
}
