"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { FRAME_BORDER } from "../../ProductPricesGrid";
import { StaleRevisionNotice } from "../confirm/StaleRevisionNotice";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { usePriceDraft } from "./usePriceDraft";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const BTN =
  "h-9 rounded-md border bg-white px-3 text-sm font-medium text-navy hover:bg-surface-muted " +
  "border-line-strong";

/**
 * F22: the dashboard's `#main-content` is the scroller and has pb-24, and a sticky bar stops at its scroller's padding,
 * so left alone the bar floated 96px up and covered the Case and Piece rows when Edit first opened. The bar's `bottom`
 * is pulled down through that padding so it rests at the real bottom, and the scroller's scroll-padding-bottom is the
 * bar's measured height, so a price box that takes focus (Tab, a click) scrolls clear of the bar. Let go when the bar goes
 * (the same cure as the counter's checkout bar, #3500).
 */
function useClearOfShellPadding() {
  const [inset, setInset] = React.useState(0);
  const [height, setHeight] = React.useState(0);
  const observer = React.useRef<ResizeObserver | null>(null);
  // A callback ref: the bar mounts only while editing, so the observer follows the element, and its height is 0 when gone.
  const ref = React.useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  React.useEffect(() => {
    const main = document.getElementById("main-content");
    if (!main) {
      setInset(0);
      return;
    }
    // The computed padding is always "<n>px" (read with Number(): the edit folder's guard spec keeps float parsers out).
    const padding = Number(getComputedStyle(main).paddingBottom.replace("px", ""));
    setInset(Number.isFinite(padding) ? padding : 0);
    if (height === 0) return;
    const before = main.style.getPropertyValue("scroll-padding-bottom");
    main.style.setProperty("scroll-padding-bottom", `${height}px`);
    return () => {
      if (before) main.style.setProperty("scroll-padding-bottom", before);
      else main.style.removeProperty("scroll-padding-bottom");
    };
  }, [height]);
  return { ref, bottom: inset === 0 ? 0 : -inset };
}

/**
 * V14: the ONE save bar (message left, Cancel then Save right), sticky to the bottom, clear of the draft
 * dock's band (bottom-24). V04: a labelled region with a "Ctrl+S saves" hint; Save stays focusable
 * (aria-disabled) so the skip link can always reach it. Cancel on a changed draft asks first.
 * A failed save keeps the draft and says why in a role="alert" line.
 */
export function PriceEditBar() {
  const d = usePriceDraft();
  const [confirm, setConfirm] = React.useState(false);
  const clear = useClearOfShellPadding();
  React.useEffect(() => {
    if (!d.editing) setConfirm(false);
  }, [d.editing]);
  if (!d.editing) return null;
  const label = (ref: string) => d.grid?.rows.find((r) => r.ref === ref)?.label ?? ref;
  return (
    <div
      ref={clear.ref}
      role="region"
      aria-label="Unsaved changes"
      data-testid={T.editbar}
      style={{ bottom: `${clear.bottom}px` }}
      className={`sticky z-30 -mx-4 mt-4 border-t bg-white/95 px-4 py-3 backdrop-blur ${FRAME_BORDER}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div data-testid={T.ebText} className="min-w-0 flex-1 text-sm text-navy" aria-live="polite">
          {confirm ? (
            <strong>Discard your unsaved changes?</strong>
          ) : d.problems.length > 0 ? (
            <ul data-testid={T.ebProblems} className="space-y-0.5 text-red-600">
              {d.problems.map((p) => (
                <li key={`${p.ref}|${p.tier}`}>
                  {d.tierName(p.tier)} {label(p.ref)}: {p.message}
                </li>
              ))}
            </ul>
          ) : (
            <span>{d.count === 0 ? "Nothing changed yet" : `${d.count} unsaved`}</span>
          )}
          {!confirm && (
            <span data-testid={T.ebHint} className="ml-2 text-xs text-navy/60">
              {isMac() ? "⌘S saves" : "Ctrl+S saves"}
            </span>
          )}
          {d.conflicts.length > 0 && !confirm && (
            <ul data-testid={T.ebConflicts} className="space-y-0.5 text-red-600">
              {d.conflicts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          {d.bakedTitles.length > 0 && !confirm && (
            <ul data-testid={T.ebBaked} className="mt-1 space-y-0.5 text-xs text-navy/70">
              {d.bakedTitles.map((t, i) => (
                <li key={`${i}-${t}`}>Includes: {t}</li>
              ))}
            </ul>
          )}
          {d.notice && !confirm && (
            <p role="status" data-testid={T.ebNotice} className="mt-1 text-amber-800">
              {d.notice}
            </p>
          )}
          {d.saveError?.code === "stale" ? (
            <StaleRevisionNotice onReload={d.reload} />
          ) : (
            d.saveError && (
              <p role="alert" data-testid={T.ebError} className="mt-1 text-red-600">
                {d.saveError.copy}
                {d.saveError.problems.map((p) => (
                  <span key={p} className="block">
                    {p}
                  </span>
                ))}
              </p>
            )
          )}
        </div>
        {confirm ? (
          <div className="flex items-center gap-2">
            <button type="button" data-testid={T.ebDiscard} className={BTN} onClick={d.discard}>
              Discard
            </button>
            <button
              type="button"
              data-testid={T.ebKeep}
              className="h-9 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
              autoFocus
              onClick={() => setConfirm(false)}
            >
              Keep editing
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid={T.ebCancel}
              className={BTN}
              onClick={() => (d.dirty ? setConfirm(true) : d.discard())}
            >
              Cancel
            </button>
            <button
              type="button"
              id={T.ebSave}
              data-testid={T.ebSave}
              aria-disabled={!d.canSave}
              onClick={() => d.canSave && d.save()}
              className="h-9 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              {d.saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * V04: hidden until focused; moves focus to Save. Portalled to the start of the dashboard's
 * `#main-content`, so it is the first focusable element of main (the layout's own "Skip to
 * content" link still comes before it).
 */
export function SkipToSave() {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    const main = document.getElementById("main-content");
    if (!main) return;
    const h = document.createElement("div");
    main.insertBefore(h, main.firstChild);
    setHost(h);
    return () => {
      h.remove();
      setHost(null);
    };
  }, []);
  const link = (
    <a
      href={`#${T.ebSave}`}
      data-testid={T.skipSave}
      onClick={(e) => {
        e.preventDefault();
        document.getElementById(T.ebSave)?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium focus:text-navy focus:shadow"
    >
      Skip to Save
    </a>
  );
  return host ? createPortal(link, host) : link;
}
