"use client";

import * as React from "react";

/**
 * In-page jump links for the product page (V19). Each section is a heading that may or may not be on
 * the page (a family has no units grid, the Customer view loads later), so the strip is built from the
 * ids that exist in the DOM and follows it as sections appear. A link is never shown for a missing one.
 *
 * `fallback` names an existing element to adopt when no element carries the section id yet (the prices
 * grid title; the Customer view heading carries `id="h-cust"` itself, so it needs none). The adopted element keeps any id it already has; the link points at it. The Product
 * section is the page h1 carrying `id="h-product"` (set by the page itself); there is deliberately no
 * `h1` fallback, because the dashboard header has an h1 of its own that comes first in the DOM.
 *
 * Whatever this component adds to a heading (tabindex, data-jump-target, an id) is removed again when it
 * unmounts, so nothing leaks onto the next route.
 */
const SECTIONS: { id: string; label: string; short: string; fallback?: string }[] = [
  { id: "h-product", label: "Product", short: "Product" },
  { id: "h-units", label: "Units and prices", short: "Prices", fallback: "#units-v2-grid-title" },
  { id: "h-exc", label: "Customers and tiers", short: "Tiers" },
  { id: "h-cust", label: "Customer view", short: "Customer" },
  { id: "h-sales", label: "Sales", short: "Sales" },
];

interface Resolved {
  id: string;
  label: string;
  /** The label used below `sm`, where the five full labels do not fit one row. */
  short: string;
  /** The id the link points at (the section id, or the adopted element's own id). */
  hrefId: string;
}

/** What was added to an element, so unmount can take exactly that back out. */
type Stamp = {
  id: boolean;
  tabindex: boolean;
  /** The element carried a style attribute before we touched it (so an emptied one is only removed if we added it). */
  hadStyle: boolean;
  /** The `--jump-inset` px stamped on the element (0 = none). */
  inset: number;
};

/** Custom properties: the strip's clearance goes on `#main-content`, a heading's own in-card inset on the heading. */
const OFFSET_VAR = "--jump-offset";
const INSET_VAR = "--jump-inset";
/** Breathing room between the strip's bottom edge and a landed heading. */
const CLEARANCE_PX = 8;
/** A heading this close to its card's top edge also keeps the card's edge in view (apple-design). */
const INSET_MAX_PX = 32;
const CARD_SELECTOR = 'section, article, [class*="rounded-"][class*="border"]';
/** How long a jump may settle (the late-loading sections shift the page), measured from the click. */
const SETTLE_WINDOW_MS = 1500;
/** A smooth scroll never runs longer than this; if `scrollend` never came, stop calling it running. */
const SCROLL_RUNNING_CAP_MS = 800;
/** Within this many px of where it should be, a target is left alone. */
const SLACK_PX = 4;
/** Give up waiting for the layout to hold still after this many frames. */
const MAX_STILL_FRAMES = 60;
/** How long a hash that names a not-yet-mounted section is waited for before it is dropped. */
const HASH_WAIT_MS = 8000;
/** Events that mean the person took over the scroll. NEVER `scroll`: the smooth scroll fires it itself. */
const USER_TAKEOVER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Remove a custom property; drop the style attribute again only if it was ours alone. */
function clearVar(el: HTMLElement, name: string, hadStyle: boolean) {
  el.style.removeProperty(name);
  if (!hadStyle && el.getAttribute("style") === "") el.removeAttribute("style");
}

/**
 * A heading that sits just inside a card (the grid title in its card, Sales in its card header) also keeps the
 * card's top edge in view: the gap between the two is added to its scroll margin through `--jump-inset`.
 */
function stampInset(el: HTMLElement, stamp: Stamp) {
  const card = el.parentElement?.closest(CARD_SELECTOR) ?? null;
  const gap = card
    ? Math.round(el.getBoundingClientRect().top - card.getBoundingClientRect().top)
    : 0;
  const next = gap > 0 && gap <= INSET_MAX_PX ? gap : 0;
  if (next === stamp.inset) return;
  stamp.inset = next;
  if (next > 0) el.style.setProperty(INSET_VAR, `${next}px`);
  else clearVar(el, INSET_VAR, stamp.hadStyle);
}

const restampInsets = (stamps: Map<HTMLElement, Stamp>) =>
  stamps.forEach((stamp, el) => stampInset(el, stamp));

function resolve(stamps: Map<HTMLElement, Stamp>): Resolved[] {
  const out: Resolved[] = [];
  for (const s of SECTIONS) {
    const el =
      document.getElementById(s.id) ??
      (s.fallback ? document.querySelector<HTMLElement>(s.fallback) : null);
    if (!el) continue;
    if (!stamps.has(el)) {
      const stamp: Stamp = {
        id: false,
        tabindex: false,
        hadStyle: el.hasAttribute("style"),
        inset: 0,
      };
      if (!el.id) {
        el.id = s.id;
        stamp.id = true;
      }
      if (!el.hasAttribute("tabindex")) {
        el.setAttribute("tabindex", "-1");
        stamp.tabindex = true;
      }
      el.setAttribute("data-jump-target", "");
      stamps.set(el, stamp);
      stampInset(el, stamp);
    }
    out.push({ id: s.id, label: s.label, short: s.short, hrefId: el.id });
  }
  return out;
}

function unstamp(stamps: Map<HTMLElement, Stamp>) {
  stamps.forEach((stamp, el) => {
    el.removeAttribute("data-jump-target");
    if (stamp.inset > 0) clearVar(el, INSET_VAR, stamp.hadStyle);
    if (stamp.tabindex) el.removeAttribute("tabindex");
    if (stamp.id) el.removeAttribute("id");
  });
  stamps.clear();
}

const same = (a: Resolved[], b: Resolved[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.hrefId === b[i].hrefId);

// A programmatically focused heading is not a control: no ring (P01).
const SCOPED_CSS = `[data-jump-target][tabindex="-1"]:focus{outline:none}
[data-jump-target]{scroll-margin-top:calc(var(--jump-offset,0px) + var(--jump-inset,0px))}
.units-v2-jump-strip[data-fade="true"]{-webkit-mask-image:linear-gradient(90deg,#000 75%,transparent);mask-image:linear-gradient(90deg,#000 75%,transparent)}`;

export function ProductJumpLinks() {
  const [sections, setSections] = React.useState<Resolved[]>([]);
  const [current, setCurrent] = React.useState<string | null>(null);
  const [fade, setFade] = React.useState(false);
  const [stripH, setStripH] = React.useState(0);
  const navRef = React.useRef<HTMLElement>(null);
  const stripRef = React.useRef<HTMLDivElement>(null);
  const stamps = React.useRef(new Map<HTMLElement, Stamp>());
  /** Strip height + clearance while the strip is sticky, else 0: where a landed heading's top should sit. */
  const offsetRef = React.useRef(0);
  /** The id aria-current is pinned to while a jump settles. */
  const heldRef = React.useRef<string | null>(null);
  /** Ends the jump in flight (the settle window, the pending re-scroll and its listeners). */
  const jumpRef = React.useRef<(() => void) | null>(null);

  // Read the sections before first paint, then follow the DOM as sections arrive.
  React.useLayoutEffect(() => {
    const scan = () =>
      setSections((prev) => {
        const next = resolve(stamps.current);
        return same(prev, next) ? prev : next;
      });
    scan();
    const owned = stamps.current;
    if (typeof MutationObserver === "undefined") return () => unstamp(owned);
    let raf = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(scan);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
      unstamp(owned);
    };
  }, []);

  const show = sections.length >= 2;

  // K11-01: the strip sticks to the top of the scroller and covers what a jump lands on. Its measured height
  // (never a constant) goes on `#main-content` as --jump-offset, which every jump target takes as its
  // scroll-margin-top. No strip, or a strip that is not sticky, means no variable and no stray gap.
  React.useLayoutEffect(() => {
    const nav = navRef.current;
    const main = document.getElementById("main-content");
    if (!show || !nav) {
      offsetRef.current = 0;
      setStripH(0);
      return;
    }
    const hadStyle = !!main?.hasAttribute("style");
    const apply = () => {
      const sticky = getComputedStyle(nav).position === "sticky";
      const h = sticky ? Math.ceil(nav.getBoundingClientRect().height) : 0;
      offsetRef.current = sticky ? h + CLEARANCE_PX : 0;
      setStripH(h);
      if (main) {
        if (sticky) main.style.setProperty(OFFSET_VAR, `${h + CLEARANCE_PX}px`);
        else clearVar(main, OFFSET_VAR, hadStyle);
      }
      restampInsets(stamps.current);
    };
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(nav);
    window.addEventListener("resize", apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
      offsetRef.current = 0;
      if (main) clearVar(main, OFFSET_VAR, hadStyle);
    };
  }, [show]);

  // aria-current follows the section in view (P09). The observer's top edge is the strip's bottom edge, and a
  // jump pins the clicked id for its settle window so the pill does not flip to the next section.
  const key = sections.map((s) => s.hrefId).join("|");
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || sections.length === 0) return;
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set((e.target as HTMLElement).id, e.isIntersecting);
        if (heldRef.current) return;
        const on = sections.find((s) => visible.get(s.hrefId));
        if (on) setCurrent(on.id);
        else if ([...visible.values()].every((v) => !v)) setCurrent(null);
      },
      { rootMargin: `${-stripH}px 0px -60% 0px` },
    );
    for (const s of sections) {
      const el = document.getElementById(s.hrefId);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stripH]);

  // The strip fades at its edge while it can still scroll (P10).
  const syncFade = React.useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const over = el.scrollWidth > el.clientWidth + 1;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setFade(over && !atEnd);
  }, []);
  React.useEffect(() => {
    syncFade();
    window.addEventListener("resize", syncFade);
    return () => window.removeEventListener("resize", syncFade);
  }, [syncFade, key]);

  /**
   * Scroll to a section, focus its heading, and settle (K11-01). The Customer view and the grid mount after the
   * prices load, which shifts the page under the first scroll, so for 1.5 s from now a page shift that leaves the
   * target off its mark gets ONE more scroll: right away while the first smooth scroll is still running, else once
   * the layout has held still for two frames. The re-scroll never focuses anything, and any sign that the person
   * took over (wheel, touch, pointer, key, focus leaving the heading, another jump) ends the whole thing.
   */
  const startJump = React.useCallback((id: string, hrefId: string, focus: boolean): boolean => {
    const el = document.getElementById(hrefId);
    if (!el) return false;
    jumpRef.current?.();
    const scroller: EventTarget = document.getElementById("main-content") ?? document;
    const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
    const scrollToTarget = () => el.scrollIntoView?.({ block: "start", behavior });
    const cleanups: Array<() => void> = [];
    let over = false;
    let corrected = false;
    let waiting = false;
    let running = false;

    const end = () => {
      if (over) return;
      over = true;
      cleanups.forEach((f) => f());
      if (heldRef.current === id) heldRef.current = null;
      if (jumpRef.current === end) jumpRef.current = null;
    };
    const listen = (target: EventTarget, type: string, fn: EventListener) => {
      target.addEventListener(type, fn, { passive: true });
      cleanups.push(() => target.removeEventListener(type, fn));
    };
    const after = (ms: number, fn: () => void) => {
      const t = window.setTimeout(fn, ms);
      cleanups.push(() => window.clearTimeout(t));
    };

    scrollToTarget();
    if (focus) {
      el.focus({ preventScroll: true });
      listen(el, "focusout", end);
    }
    heldRef.current = id;
    setCurrent(id);
    jumpRef.current = end;

    if ("onscrollend" in window && behavior === "smooth") {
      running = true;
      const stop = () => {
        running = false;
      };
      listen(scroller, "scrollend", stop);
      after(SCROLL_RUNNING_CAP_MS, stop);
    }

    const expectedTop = () =>
      (document.getElementById("main-content")?.getBoundingClientRect().top ?? 0) +
      offsetRef.current +
      (stamps.current.get(el)?.inset ?? 0);
    const correct = () => {
      if (over || corrected) return;
      if (Math.abs(el.getBoundingClientRect().top - expectedTop()) <= SLACK_PX) return;
      corrected = true;
      scrollToTarget();
    };
    const onShift = () => {
      if (over || corrected || waiting) return;
      if (running) return correct();
      waiting = true;
      let prev = el.getBoundingClientRect().top;
      let still = 0;
      let frames = 0;
      let raf = 0;
      const tick = () => {
        if (over) return;
        const top = el.getBoundingClientRect().top;
        still = top === prev ? still + 1 : 0;
        prev = top;
        if (still >= 2 || ++frames > MAX_STILL_FRAMES) {
          waiting = false;
          if (still >= 2) correct();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      cleanups.push(() => cancelAnimationFrame(raf));
    };

    if (typeof MutationObserver !== "undefined") {
      const mo = new MutationObserver((records) => {
        const nav = navRef.current;
        if (records.some((r) => !nav || !nav.contains(r.target))) onShift();
      });
      mo.observe(document.body, { childList: true, subtree: true });
      cleanups.push(() => mo.disconnect());
    }
    for (const type of USER_TAKEOVER_EVENTS) listen(scroller, type, end);
    after(SETTLE_WINDOW_MS, end);
    return true;
  }, []);

  React.useEffect(() => () => jumpRef.current?.(), []);

  // K11-03: a refresh comes back to the section the person jumped to. The hash names a section (by its id, or by
  // the adopted element's own id); it is followed ONCE, as soon as that section exists, with the same settling as a
  // click. It is dropped when the person scrolls or jumps first, or the section never turns up.
  const hashDone = React.useRef(false);
  React.useEffect(() => {
    if (!window.location.hash) {
      hashDone.current = true;
      return;
    }
    const scroller: EventTarget = document.getElementById("main-content") ?? document;
    const stop = () => {
      hashDone.current = true;
    };
    for (const type of USER_TAKEOVER_EVENTS)
      scroller.addEventListener(type, stop, { passive: true });
    const t = window.setTimeout(stop, HASH_WAIT_MS);
    return () => {
      for (const type of USER_TAKEOVER_EVENTS) scroller.removeEventListener(type, stop);
      window.clearTimeout(t);
    };
  }, []);
  React.useEffect(() => {
    if (hashDone.current) return;
    const raw = window.location.hash.slice(1);
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      // a malformed escape: match the raw text
    }
    const hit = sections.find((s) => s.id === name || s.hrefId === name);
    if (!hit) return;
    hashDone.current = true;
    startJump(hit.id, hit.hrefId, true);
  }, [sections, startJump]);

  if (!show) return null;

  const go = (e: React.MouseEvent, s: Resolved) => {
    if (!document.getElementById(s.hrefId)) return;
    e.preventDefault();
    hashDone.current = true;
    if (!startJump(s.id, s.hrefId, true)) return;
    // The hash is the section's own id; replaceState keeps the path, the query (`?customer=`) and the
    // router's history state, and adds no history entry.
    try {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}#${s.hrefId}`,
      );
    } catch {
      // a sandboxed frame may refuse; the jump itself already happened
    }
  };

  return (
    <nav
      ref={navRef}
      data-testid="units-v2-jump"
      aria-label="On this page"
      className="sticky top-0 z-10 -mx-1 border-b border-surface-border bg-surface px-1"
    >
      <style>{SCOPED_CSS}</style>
      <div
        ref={stripRef}
        data-testid="units-v2-jump-strip"
        data-fade={fade ? "true" : "false"}
        onScroll={syncFade}
        className="units-v2-jump-strip flex gap-1 overflow-x-auto py-1.5"
      >
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.hrefId}`}
            data-testid={`units-v2-jump-${s.id}`}
            aria-label={s.label}
            aria-current={current === s.id ? "true" : undefined}
            onClick={(e) => go(e, s)}
            className="inline-flex min-h-[44px] items-center whitespace-nowrap rounded-full px-2.5 text-sm sm:px-3 font-semibold text-navy/70 hover:bg-surface-raised hover:text-navy aria-[current=true]:bg-surface-raised aria-[current=true]:text-navy"
          >
            {s.label === s.short ? (
              s.label
            ) : (
              <>
                <span className="sm:hidden">{s.short}</span>
                <span className="hidden sm:inline">{s.label}</span>
              </>
            )}
          </a>
        ))}
      </div>
    </nav>
  );
}
