import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ProductJumpLinks } from "./ProductJumpLinks";

/**
 * K11-01 / K11-03: the jump strip lands on its target and a refresh comes back to it.
 *
 * jsdom cannot lay anything out, so the logic is proven with the browser seams mocked:
 * getBoundingClientRect (by element id / test id), ResizeObserver, IntersectionObserver, matchMedia and
 * scrollIntoView. The pixels themselves are proven in the Playwright spec (e2e/k11-l1-nav.spec.ts).
 */

type IOCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let ioCallback: IOCallback | null = null;
let ioOptions: IntersectionObserverInit | undefined;
class FakeIO {
  constructor(cb: IOCallback, opts?: IntersectionObserverInit) {
    ioCallback = cb;
    ioOptions = opts;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

interface FakeROInstance {
  cb: () => void;
  live: boolean;
}
let roInstances: FakeROInstance[] = [];
class FakeRO {
  private inst: FakeROInstance;
  constructor(cb: () => void) {
    this.inst = { cb, live: true };
    roInstances.push(this.inst);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.inst.live = false;
  }
}
const fireRO = () =>
  act(() => {
    roInstances.filter((r) => r.live).forEach((r) => r.cb());
  });

const NAV_H = { v: 52 };
const rectById: Record<string, { top: number; height?: number }> = {};
const keyOf = (el: Element) => el.id || el.getAttribute("data-testid") || "";

interface Scrolled {
  el: Element;
  behavior: ScrollBehavior | undefined;
}
let scrolled: Scrolled[] = [];
let reduceMotion = false;
let styleEl: HTMLStyleElement;
let main: HTMLElement;
let host: HTMLElement;
const spies: jest.SpyInstance[] = [];

function Page({ extra = null }: { extra?: React.ReactNode }) {
  return (
    <div>
      <ProductJumpLinks />
      <h1 id="h-product">Cola</h1>
      <section>
        <div data-testid="grid-card" className="rounded-lg border">
          <h2 id="units-v2-grid-title">Prices</h2>
        </div>
      </section>
      <h2 id="h-cust">Customer view</h2>
      <h2 id="h-sales">Sales</h2>
      {extra}
    </div>
  );
}

const link = (id: string) => screen.getByTestId(`units-v2-jump-${id}`);
const target = (id: string) => document.getElementById(id)!;
const offsetVar = () => main.style.getPropertyValue("--jump-offset");

function mount(ui: React.ReactElement = <Page />) {
  return render(ui, { container: host });
}

/** The page grows under the target: a node lands in the DOM (the Customer view mounting is exactly this). */
async function shiftPage() {
  await act(async () => {
    const d = document.createElement("div");
    d.setAttribute("data-shift", "");
    document.body.appendChild(d);
    await Promise.resolve();
    await Promise.resolve();
  });
}
const frames = (n = 3) =>
  act(() => {
    jest.advanceTimersByTime(16 * n);
  });

beforeAll(() => {
  styleEl = document.createElement("style");
  styleEl.textContent = ".sticky{position:sticky}";
  document.head.appendChild(styleEl);
});
afterAll(() => {
  styleEl.remove();
});

beforeEach(() => {
  jest.useFakeTimers();
  ioCallback = null;
  ioOptions = undefined;
  roInstances = [];
  scrolled = [];
  reduceMotion = false;
  NAV_H.v = 52;
  for (const k of Object.keys(rectById)) delete rectById[k];
  rectById["main-content"] = { top: 0 };
  (window as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
  (window as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
  window.matchMedia = jest.fn().mockImplementation((q: string) => ({
    matches: reduceMotion && q.includes("prefers-reduced-motion"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
    onchange: null,
  }));
  Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
    scrolled.push({ el: this, behavior: (opts as ScrollIntoViewOptions | undefined)?.behavior });
  };
  spies.push(
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const k = keyOf(this);
      const r = k === "units-v2-jump" ? { top: 0, height: NAV_H.v } : (rectById[k] ?? { top: 0 });
      const height = r.height ?? 0;
      return {
        top: r.top,
        y: r.top,
        bottom: r.top + height,
        height,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        toJSON() {},
      } as DOMRect;
    }),
  );
  main = document.createElement("div");
  main.id = "main-content";
  document.body.appendChild(main);
  host = document.createElement("div");
  main.appendChild(host);
});

afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
  document.querySelectorAll("[data-shift]").forEach((n) => n.remove());
  main.remove();
  delete (window as { onscrollend?: unknown }).onscrollend;
  delete (window as { matchMedia?: unknown }).matchMedia;
  jest.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("K11-01: clearance under the sticky strip", () => {
  it("sets --jump-offset on #main-content to the measured strip height + 8px and follows its resizes", () => {
    mount();
    expect(offsetVar()).toBe("60px");
    NAV_H.v = 64;
    fireRO();
    expect(offsetVar()).toBe("72px");
  });

  it("removes the variable on unmount, leaving no style attribute behind", () => {
    const { unmount } = mount();
    expect(offsetVar()).toBe("60px");
    unmount();
    expect(offsetVar()).toBe("");
    expect(main.getAttribute("style") ?? "").toBe("");
  });

  it("sets no variable when the strip is not sticky (offset 0, no stray gap)", () => {
    mount();
    expect(offsetVar()).toBe("60px");
    screen.getByTestId("units-v2-jump").style.position = "static";
    fireRO();
    expect(offsetVar()).toBe("");
  });

  it("sets no variable when the strip renders nothing (fewer than 2 sections)", () => {
    render(
      <div>
        <ProductJumpLinks />
        <h1 id="h-product">Cola</h1>
      </div>,
      { container: host },
    );
    expect(screen.queryByTestId("units-v2-jump")).toBeNull();
    expect(offsetVar()).toBe("");
  });

  it("applies the variable as scroll-margin-top on every [data-jump-target], in its scoped style", () => {
    mount();
    const css = screen.getByTestId("units-v2-jump").querySelector("style")?.textContent ?? "";
    expect(css).toMatch(
      /\[data-jump-target\]\s*\{\s*scroll-margin-top:\s*calc\(var\(--jump-offset,\s*0px\)\s*\+\s*var\(--jump-inset,\s*0px\)\)/,
    );
  });

  it("stamps --jump-inset on a heading that sits within 32px of its card, and takes it back out", () => {
    const before = "";
    rectById["grid-card"] = { top: 100 };
    rectById["units-v2-grid-title"] = { top: 116 };
    const { unmount } = mount();
    expect(target("units-v2-grid-title").style.getPropertyValue("--jump-inset")).toBe("16px");
    // a heading that is not inside a card gets none
    expect(target("h-sales").style.getPropertyValue("--jump-inset")).toBe("");
    const grid = target("units-v2-grid-title");
    unmount();
    expect(grid.style.getPropertyValue("--jump-inset")).toBe(before);
    expect(grid.getAttribute("style") ?? "").toBe("");
  });

  it("stamps no inset when the heading is more than 32px below its card top", () => {
    rectById["grid-card"] = { top: 100 };
    rectById["units-v2-grid-title"] = { top: 150 };
    mount();
    expect(target("units-v2-grid-title").style.getPropertyValue("--jump-inset")).toBe("");
  });

  it("starts the section-in-view observer below the strip (rootMargin top = strip height)", () => {
    mount();
    expect(ioOptions?.rootMargin).toBe("-52px 0px -60% 0px");
  });
});

describe("K11-01: motion", () => {
  it("scrolls smoothly by default", () => {
    mount();
    fireEvent.click(link("h-sales"));
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].behavior).toBe("smooth");
  });

  it("uses behavior auto for the first scroll and the re-scroll under prefers-reduced-motion", async () => {
    reduceMotion = true;
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    expect(scrolled[0].behavior).toBe("auto");
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(2);
    expect(scrolled[1].behavior).toBe("auto");
  });
});

describe("K11-01: the settle window (one re-scroll)", () => {
  it("re-scrolls to the target once when the page shifted it", async () => {
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(2);
    expect(scrolled[1].el).toBe(target("h-sales"));
    // never twice
    rectById["h-sales"] = { top: 500 };
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(2);
  });

  it("does not re-scroll when the target is within 4px of where it should be", async () => {
    mount();
    rectById["h-sales"] = { top: 63 }; // strip 52 + 8 = 60, 3px off
    fireEvent.click(link("h-sales"));
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(1);
  });

  it("measures the target against strip + 8px + its card inset", async () => {
    rectById["grid-card"] = { top: 100 };
    rectById["units-v2-grid-title"] = { top: 116 };
    mount();
    fireEvent.click(link("h-units"));
    rectById["units-v2-grid-title"] = { top: 60 + 16 + 2 }; // 2px off the target of 76: leave it
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(1);
    rectById["units-v2-grid-title"] = { top: 60 };
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(2);
  });

  it("waits for the page to hold still before correcting (a layout still moving does not fire)", async () => {
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    await frames(1);
    rectById["h-sales"] = { top: 340 }; // moved again between frames
    await frames(1);
    expect(scrolled).toHaveLength(1);
    await frames(3);
    expect(scrolled).toHaveLength(2);
  });

  it("issues the new scroll right away while the first smooth scroll is still running (scrollend supported)", async () => {
    (window as { onscrollend?: unknown }).onscrollend = null;
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    expect(scrolled).toHaveLength(2); // no frames waited
  });

  it("waits for stillness once the first scroll has ended (scrollend fired)", async () => {
    (window as { onscrollend?: unknown }).onscrollend = null;
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    act(() => {
      main.dispatchEvent(new Event("scrollend"));
    });
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    expect(scrolled).toHaveLength(1);
    await frames();
    expect(scrolled).toHaveLength(2);
  });

  it("does not correct after the 1.5 s window", async () => {
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    act(() => {
      jest.advanceTimersByTime(1600);
    });
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(1);
  });

  it.each(["wheel", "touchstart", "pointerdown", "keydown"])(
    "a %s on #main-content cancels the pending re-scroll",
    async (type) => {
      mount();
      rectById["h-sales"] = { top: 60 };
      fireEvent.click(link("h-sales"));
      act(() => {
        main.dispatchEvent(new Event(type, { bubbles: true }));
      });
      rectById["h-sales"] = { top: 300 };
      await shiftPage();
      await frames();
      expect(scrolled).toHaveLength(1);
    },
  );

  it("never listens for scroll: the smooth scroll itself fires it", async () => {
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    act(() => {
      main.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(2);
  });

  it("a second jump click replaces the pending target", async () => {
    mount();
    rectById["h-sales"] = { top: 60 };
    rectById["h-cust"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    fireEvent.click(link("h-cust"));
    expect(scrolled.map((s) => s.el.id)).toEqual(["h-sales", "h-cust"]);
    rectById["h-sales"] = { top: 400 };
    rectById["h-cust"] = { top: 300 };
    await shiftPage();
    await frames();
    expect(scrolled.map((s) => s.el.id)).toEqual(["h-sales", "h-cust", "h-cust"]);
  });

  it("focuses the heading at click time only: the re-scroll never focuses anything again", async () => {
    mount();
    rectById["h-sales"] = { top: 60 };
    const focus = jest.spyOn(target("h-sales"), "focus");
    fireEvent.click(link("h-sales"));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(2);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("cancels the re-scroll when focus leaves the target", async () => {
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    expect(target("h-sales")).toHaveFocus();
    act(() => {
      target("h-sales").blur();
    });
    rectById["h-sales"] = { top: 300 };
    await shiftPage();
    await frames();
    expect(scrolled).toHaveLength(1);
  });

  it("keeps aria-current on the clicked id for the window, then follows the page again", () => {
    mount();
    rectById["h-sales"] = { top: 60 };
    fireEvent.click(link("h-sales"));
    expect(link("h-sales")).toHaveAttribute("aria-current", "true");
    act(() => {
      ioCallback?.([{ target: target("h-cust"), isIntersecting: true, intersectionRatio: 1 }]);
    });
    expect(link("h-sales")).toHaveAttribute("aria-current", "true");
    expect(link("h-cust")).not.toHaveAttribute("aria-current");
    act(() => {
      jest.advanceTimersByTime(1600);
    });
    act(() => {
      ioCallback?.([{ target: target("h-cust"), isIntersecting: true, intersectionRatio: 1 }]);
    });
    expect(link("h-cust")).toHaveAttribute("aria-current", "true");
  });

  it("hands aria-current back to the page as soon as the user scrolls", () => {
    mount();
    fireEvent.click(link("h-sales"));
    act(() => {
      main.dispatchEvent(new Event("wheel", { bubbles: true }));
    });
    act(() => {
      ioCallback?.([{ target: target("h-cust"), isIntersecting: true, intersectionRatio: 1 }]);
    });
    expect(link("h-cust")).toHaveAttribute("aria-current", "true");
  });
});
