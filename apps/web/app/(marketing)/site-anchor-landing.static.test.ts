/**
 * @jest-environment jsdom
 */
// Owner report: "When I tap Use cases on the site to open, it goes to the top of the page." The home
// page used to reach a #hash only after its deferred scripts had run, so on a slow phone the person sat
// at the top for seconds. An inline script now moves to the target as soon as the page can be laid out
// and keeps it there while the layout settles. The e2e spec 36 (T20) measures it under a slow phone's
// CPU and network; these pin the script itself and that every home anchor the site links to exists.
import * as fs from "fs";
import * as path from "path";

const SITE = path.resolve(__dirname, "../../public/site");
const home = fs.readFileSync(path.join(SITE, "home.html"), "utf8");

const SNIPPET_MARK = "Land on a home anchor";
const script = (() => {
  const at = home.indexOf(SNIPPET_MARK);
  const open = home.lastIndexOf("<script>", at);
  return home.slice(open + "<script>".length, home.indexOf("</script>", at));
})();

describe("home anchor landing script", () => {
  it("sits in the page itself, before the first deferred script", () => {
    const at = home.indexOf(SNIPPET_MARK);
    expect(at).toBeGreaterThan(0);
    const firstDeferred = home.search(/<script src="[^"]+" defer>/);
    expect(firstDeferred).toBeGreaterThan(at);
    expect(home.match(new RegExp(SNIPPET_MARK, "g"))).toHaveLength(1);
  });

  describe("behaviour", () => {
    let y: number;
    let top: number;
    let scrollTo: jest.Mock;
    let target: HTMLElement;

    const run = (hash: string, navType = "navigate") => {
      // replaceState sets the hash without the hashchange event a real navigation has already fired.
      window.history.replaceState(null, "", hash || window.location.pathname);
      Object.defineProperty(performance, "getEntriesByType", {
        configurable: true,
        value: () => [{ type: navType }],
      });
      new Function(script)();
    };

    beforeEach(() => {
      jest.useFakeTimers();
      y = 0;
      top = 5000;
      document.body.innerHTML = '<section id="use-cases"></section>';
      target = document.getElementById("use-cases")!;
      target.getBoundingClientRect = () => ({ top: top - y }) as DOMRect;
      Object.defineProperty(window, "pageYOffset", { configurable: true, get: () => y });
      scrollTo = jest.fn((_x: number, ny: number) => {
        y = ny;
      });
      window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
      window.history.replaceState(null, "", window.location.pathname);
    });

    it("moves to the target at once, without waiting for any other script", () => {
      run("#use-cases");
      expect(scrollTo).toHaveBeenCalledWith(0, 5000);
    });

    it("moves again when the layout shifts above the target", () => {
      run("#use-cases");
      top = 9000;
      jest.advanceTimersByTime(300);
      expect(scrollTo).toHaveBeenLastCalledWith(0, 9000);
    });

    // With the #hash off the address the browser makes no jump of its own, so it also sets no starting
    // point for Tab: the next Tab went to the top of the page (skip link) instead of on from the section.
    // The script sets it itself, once, without leaving focus or a tabindex behind.
    it("sets the Tab starting point at the target once, leaving no focus and no tabindex", () => {
      const focus = jest.spyOn(target, "focus");
      const blur = jest.spyOn(target, "blur");
      run("#use-cases");
      top = 9000;
      jest.advanceTimersByTime(600);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(blur).toHaveBeenCalledTimes(1);
      expect(target.hasAttribute("tabindex")).toBe(false);
      expect(document.activeElement).toBe(document.body);
    });

    it("keeps a tabindex the target already has", () => {
      target.setAttribute("tabindex", "0");
      run("#use-cases");
      expect(target.getAttribute("tabindex")).toBe("0");
    });

    it("sets no starting point for an unknown id, a reload or a missing hash", () => {
      const focus = jest.spyOn(target, "focus");
      run("#nothing-here");
      run("#use-cases", "reload");
      run("");
      expect(focus).not.toHaveBeenCalled();
    });

    it("stops as soon as the person touches, scrolls or presses a key", () => {
      for (const type of ["touchstart", "wheel", "keydown", "pointerdown"]) {
        scrollTo.mockClear();
        y = 0;
        top = 5000;
        run("#use-cases");
        window.dispatchEvent(new Event(type));
        top = 7000;
        jest.advanceTimersByTime(600);
        expect(scrollTo.mock.calls.slice(1)).toEqual([]);
      }
    });

    it("stops on a later hash change", () => {
      run("#use-cases");
      window.dispatchEvent(new Event("hashchange"));
      scrollTo.mockClear();
      top = 8000;
      jest.advanceTimersByTime(600);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("stops after the layout has stayed put once loaded", () => {
      run("#use-cases");
      window.dispatchEvent(new Event("load"));
      jest.advanceTimersByTime(2000);
      scrollTo.mockClear();
      top = 8000;
      jest.advanceTimersByTime(2000);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("keeps the #hash off the address until load, then puts it back (the browser's own jump cannot pull a scrolling person back)", () => {
      run("#use-cases");
      expect(window.location.hash).toBe("");
      window.dispatchEvent(new Event("wheel"));
      jest.advanceTimersByTime(600);
      expect(window.location.hash).toBe("");
      window.dispatchEvent(new Event("load"));
      jest.advanceTimersByTime(10);
      expect(window.location.hash).toBe("#use-cases");
    });

    it("does not put the old hash back over a hash the person has since chosen", () => {
      run("#use-cases");
      window.history.replaceState(null, "", "#stores");
      window.dispatchEvent(new Event("load"));
      jest.advanceTimersByTime(10);
      expect(window.location.hash).toBe("#stores");
    });

    it("gives up at once when the target is fixed (a menu, a bar)", () => {
      target.style.position = "fixed";
      run("#use-cases");
      jest.advanceTimersByTime(3000);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("gives up when its moves do not bring the target to the top (pinned, or below what the page can scroll)", () => {
      // the page cannot scroll past 1000, so the target never gets near the top
      scrollTo = jest.fn((_x: number, ny: number) => {
        y = Math.min(ny, 1000);
      });
      window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
      run("#use-cases");
      window.dispatchEvent(new Event("load"));
      jest.advanceTimersByTime(2000);
      const calls = scrollTo.mock.calls.length;
      expect(calls).toBeLessThan(10);
      jest.advanceTimersByTime(30000);
      expect(scrollTo.mock.calls.length).toBe(calls);
    });

    it("does not keep the 30 second timer alive when a target cannot move", () => {
      scrollTo = jest.fn();
      window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
      run("#use-cases");
      window.dispatchEvent(new Event("load"));
      jest.advanceTimersByTime(2000);
      const calls = scrollTo.mock.calls.length;
      jest.advanceTimersByTime(30000);
      expect(scrollTo.mock.calls.length).toBe(calls);
    });

    it("leaves a page with no hash, an unknown hash, a reload and back/forward alone", () => {
      run("");
      run("#nothing-here");
      expect(window.location.hash).toBe("#nothing-here");
      run("#%");
      run("#use-cases", "reload");
      run("#use-cases", "back_forward");
      jest.advanceTimersByTime(1000);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });
});

describe("every home anchor the site links to exists on the home page", () => {
  const ids = new Set([...home.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const pages = fs.readdirSync(SITE).filter((f) => f.endsWith(".html"));

  it.each(pages)("%s: links to /#x and #x name real sections", (file) => {
    const html = fs.readFileSync(path.join(SITE, file), "utf8");
    const own = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const missing: string[] = [];
    for (const m of html.matchAll(/href="(\/?)#([^"]+)"/g)) {
      const known = m[1] === "/" || file === "home.html" ? ids : own;
      if (!known.has(m[2])) missing.push(m[0]);
    }
    expect(missing).toEqual([]);
  });

  it("the sections people are sent to keep room for the sticky header", () => {
    const css = fs.readFileSync(path.join(SITE, "css/home.css"), "utf8");
    const up = fs.readFileSync(path.join(SITE, "css/home-up.css"), "utf8");
    expect(css).toMatch(/\.inc\{[^}]*scroll-margin-top:68px/);
    expect(up).toMatch(/#stores,#founder,#faq\{scroll-margin-top:68px/);
  });
});

// A question or card opened after scrolling down asks for ScrollTrigger.refresh(), which scrolls to the top to
// measure and back. With the site's scroll-behavior:smooth both calls were animated: the page swooped toward
// the top (WebKit: about 3,700 px), and on a phone a touch in that window left the person there. Every refresh now
// runs with instant scrolling. The behaviour in a real browser is e2e spec 36, T20 (never moves the page).
describe("every ScrollTrigger refresh runs with instant scrolling", () => {
  const up = fs.readFileSync(path.join(SITE, "js/home-up.js"), "utf8");
  const from = up.indexOf("var smoothHeld = 0");
  const refreshAt = up.indexOf('ST.addEventListener("refresh",', from);
  const block = up.slice(from, up.indexOf("\n", refreshAt));
  const make = (inline = "") => {
    const handlers: Record<string, () => void> = {};
    const html = { style: { scrollBehavior: inline } };
    const ST = {
      addEventListener: (name: string, fn: () => void) => {
        handlers[name] = fn;
      },
    };
    new Function("ST", "html", block)(ST, html);
    return { html, init: () => handlers.refreshInit!(), done: () => handlers.refresh!() };
  };

  it("is in the home script, registered on ScrollTrigger's own refresh events", () => {
    expect(from).toBeGreaterThan(0);
    expect(block).toContain('ST.addEventListener("refreshInit"');
    expect(block).toContain('ST.addEventListener("refresh"');
  });

  it("scrolls instantly while a refresh runs, and puts the setting back after", () => {
    const t = make();
    t.init();
    expect(t.html.style.scrollBehavior).toBe("auto");
    t.done();
    expect(t.html.style.scrollBehavior).toBe("");
  });

  it("restores whatever the page had set, not a fixed value", () => {
    const t = make("smooth");
    t.init();
    expect(t.html.style.scrollBehavior).toBe("auto");
    t.done();
    expect(t.html.style.scrollBehavior).toBe("smooth");
  });

  it("holds through a refresh inside a refresh and releases at the last one", () => {
    const t = make();
    t.init();
    t.init();
    t.done();
    expect(t.html.style.scrollBehavior).toBe("auto");
    t.done();
    expect(t.html.style.scrollBehavior).toBe("");
  });

  it("a stray refresh event never leaves it stuck", () => {
    const t = make("smooth");
    t.done();
    expect(t.html.style.scrollBehavior).toBe("smooth");
  });
});
