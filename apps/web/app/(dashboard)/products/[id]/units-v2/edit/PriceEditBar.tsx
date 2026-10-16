"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { GRID_BORDER } from "../../ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { usePriceDraft } from "./usePriceDraft";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const BTN =
  "h-9 rounded-md border bg-white px-3 text-sm font-medium text-navy hover:bg-surface-muted " +
  GRID_BORDER;

/**
 * V14: the ONE save bar (message left, Cancel then Save right), sticky to the bottom, clear of the draft
 * dock's band (bottom-24). V04: a labelled region with a "Ctrl+S saves" hint; Save stays focusable
 * (aria-disabled) so the skip link can always reach it. Cancel on a changed draft asks first.
 * A failed save keeps the draft and says why in a role="alert" line.
 */
export function PriceEditBar() {
  const d = usePriceDraft();
  const [confirm, setConfirm] = React.useState(false);
  React.useEffect(() => {
    if (!d.editing) setConfirm(false);
  }, [d.editing]);
  if (!d.editing) return null;
  const label = (ref: string) => d.grid?.rows.find((r) => r.ref === ref)?.label ?? ref;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      data-testid={T.editbar}
      className={`sticky bottom-0 z-30 -mx-4 mt-4 border-t bg-white/95 px-4 py-3 backdrop-blur ${GRID_BORDER}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div data-testid={T.ebText} className="min-w-0 flex-1 text-sm text-navy" aria-live="polite">
          {confirm ? (
            <strong>Discard your unsaved changes?</strong>
          ) : d.problems.length > 0 ? (
            <ul data-testid={T.ebProblems} className="space-y-0.5 text-red-600">
              {d.problems.map((p) => (
                <li key={`${p.ref}|${p.tier}`}>
                  {label(p.ref)} {d.tierName(p.tier)}: {p.message}
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
          {d.saveError && (
            <p role="alert" data-testid={T.ebError} className="mt-1 text-red-600">
              {d.saveError.message}
              {d.saveError.problems.map((p) => (
                <span key={p} className="block">
                  {p}
                </span>
              ))}
            </p>
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
