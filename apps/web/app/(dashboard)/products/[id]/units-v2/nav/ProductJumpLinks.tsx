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
const SECTIONS: { id: string; label: string; fallback?: string }[] = [
  { id: "h-product", label: "Product" },
  { id: "h-units", label: "Units and prices", fallback: "#units-v2-grid-title" },
  { id: "h-exc", label: "Customers and tiers" },
  { id: "h-cust", label: "Customer view" },
  { id: "h-sales", label: "Sales" },
];

interface Resolved {
  id: string;
  label: string;
  /** The id the link points at (the section id, or the adopted element's own id). */
  hrefId: string;
}

/** What was added to an element, so unmount can take exactly that back out. */
type Stamp = { id: boolean; tabindex: boolean };

function resolve(stamps: Map<HTMLElement, Stamp>): Resolved[] {
  const out: Resolved[] = [];
  for (const s of SECTIONS) {
    const el =
      document.getElementById(s.id) ??
      (s.fallback ? document.querySelector<HTMLElement>(s.fallback) : null);
    if (!el) continue;
    if (!stamps.has(el)) {
      const stamp: Stamp = { id: false, tabindex: false };
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
    }
    out.push({ id: s.id, label: s.label, hrefId: el.id });
  }
  return out;
}

function unstamp(stamps: Map<HTMLElement, Stamp>) {
  stamps.forEach((stamp, el) => {
    el.removeAttribute("data-jump-target");
    if (stamp.tabindex) el.removeAttribute("tabindex");
    if (stamp.id) el.removeAttribute("id");
  });
  stamps.clear();
}

const same = (a: Resolved[], b: Resolved[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.hrefId === b[i].hrefId);

// A programmatically focused heading is not a control: no ring (P01).
const SCOPED_CSS = `[data-jump-target][tabindex="-1"]:focus{outline:none}
.units-v2-jump-strip[data-fade="true"]{-webkit-mask-image:linear-gradient(90deg,#000 85%,transparent);mask-image:linear-gradient(90deg,#000 85%,transparent)}`;

export function ProductJumpLinks() {
  const [sections, setSections] = React.useState<Resolved[]>([]);
  const [current, setCurrent] = React.useState<string | null>(null);
  const [fade, setFade] = React.useState(false);
  const stripRef = React.useRef<HTMLDivElement>(null);
  const stamps = React.useRef(new Map<HTMLElement, Stamp>());

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

  // aria-current follows the section in view (P09).
  const key = sections.map((s) => s.hrefId).join("|");
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || sections.length === 0) return;
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set((e.target as HTMLElement).id, e.isIntersecting);
        const on = sections.find((s) => visible.get(s.hrefId));
        if (on) setCurrent(on.id);
        else if ([...visible.values()].every((v) => !v)) setCurrent(null);
      },
      { rootMargin: "-10% 0px -60% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(s.hrefId);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

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

  if (sections.length < 2) return null;

  const go = (e: React.MouseEvent, s: Resolved) => {
    const el = document.getElementById(s.hrefId);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView?.({ block: "start", behavior: "smooth" });
    el.focus({ preventScroll: true });
    setCurrent(s.id);
  };

  return (
    <nav
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
            aria-current={current === s.id ? "true" : undefined}
            onClick={(e) => go(e, s)}
            className="inline-flex min-h-[44px] items-center whitespace-nowrap rounded-full px-3 text-sm font-semibold text-navy/70 hover:bg-surface-raised hover:text-navy aria-[current=true]:bg-surface-raised aria-[current=true]:text-navy"
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
