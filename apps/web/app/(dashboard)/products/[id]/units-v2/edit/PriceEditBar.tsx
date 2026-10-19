"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { FRAME_BORDER } from "../../ProductPricesGrid";
import { StaleRevisionNotice } from "../confirm/StaleRevisionNotice";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { useShellBottom } from "./useClearOfShellPadding";
import { usePriceDraft } from "./usePriceDraft";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const BTN =
  "h-9 rounded-md border bg-white px-3 text-sm font-medium text-navy hover:bg-surface-muted " +
  "border-line-strong";

/**
 * F22: the dashboard's `#main-content` is the scroller; the scroller's scroll-padding-bottom is the bar's measured
 * height, so a price box that takes focus (Tab, a click) scrolls clear of the bar. Let go when the bar goes (the same
 * cure as the counter's checkout bar, #3500). The bar's own `bottom` (through the shell's pb-24) is the shared
 * `useShellBottom`, the one rule the pinned saved line uses too.
 */
function useBarScrollPadding() {
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
    if (!main || height === 0) return;
    const before = main.style.getPropertyValue("scroll-padding-bottom");
    main.style.setProperty("scroll-padding-bottom", `${height}px`);
    // K13 P10/P11: the content under the sticky bar is padded by the bar's height, so the last card scrolls clear of it.
    const padBefore = main.style.getPropertyValue("padding-bottom");
    const pad = Number(getComputedStyle(main).paddingBottom.replace("px", ""));
    main.style.setProperty("padding-bottom", `${(Number.isFinite(pad) ? pad : 0) + height}px`);
    return () => {
      if (before) main.style.setProperty("scroll-padding-bottom", before);
      else main.style.removeProperty("scroll-padding-bottom");
      if (padBefore) main.style.setProperty("padding-bottom", padBefore);
      else main.style.removeProperty("padding-bottom");
    };
  }, [height]);
  return ref;
}

const FINISH_FIRST = "Finish Change prices first.";
// N3: what Ctrl/Cmd+S says to a screen reader. Not the slot button's words: that sentence is on screen once, in the slot.
const SAVE_PAUSED = "Save is paused while Change prices is open.";

/** K11-15: right after Change prices Apply the bar says what is staged; any later edit is the plain count. */
// K12 F05: the Auto prices that follow are named, so this count and the panel's "N prices will change" add up.
const countLine = (count: number, lead: string | null, follows = 0) =>
  lead
    ? `${lead}: ${count} price${count === 1 ? "" : "s"} ready${
        follows > 0
          ? `, and ${follows} Auto price${follows === 1 ? "" : "s"} follow${follows === 1 ? "s" : ""}`
          : ""
      }. Save to keep ${count === 1 ? "it" : "them"}.`
    : `${count} unsaved`;

/**
 * V14: the ONE save bar (message left, Cancel then Save right), sticky to the bottom, clear of the draft
 * dock's band (bottom-24). V04: a labelled region with a "Ctrl+S saves" hint; Save stays focusable
 * (aria-disabled) so the skip link can always reach it. Cancel on a changed draft asks first.
 * A failed save keeps the draft and says why in a role="alert" line.
 *
 * K11-20: `placement="page"` (default) is all of the above and shows while the inline section edits.
 * `placement="window"` is the floating price window's footer: pinned by the window (not sticky), no change to
 * `#main-content`, and shown while the window edits. Message, problems, conflicts, the stale notice, Cancel, Save and
 * the discard question are the same. `asking` / `onAskingChange` let the window put the bar into (and out of) the
 * discard question from its own close paths; left out, the bar keeps that state itself.
 */
export function PriceEditBar({
  changePricesOpen = false,
  placement = "page",
  idSuffix,
  asking: askingProp,
  onAskingChange,
}: {
  changePricesOpen?: boolean;
  placement?: "page" | "window";
  /** Suffix for the Save id and the Change prices panel it points at. Default: none on the page, generated in a window. */
  idSuffix?: string;
  asking?: boolean;
  onAskingChange?: (asking: boolean) => void;
}) {
  const d = usePriceDraft();
  const windowed = placement === "window";
  const surface = windowed ? "window" : "inline";
  const uid = React.useId();
  const sfx = idSuffix ?? (windowed ? `-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}` : "");
  const here = d.editingIn === surface;
  const [innerAsking, setInnerAsking] = React.useState(false);
  const asking = askingProp ?? innerAsking;
  const setConfirm = React.useCallback(
    (on: boolean) => {
      setInnerAsking(on);
      onAskingChange?.(on);
    },
    [onAskingChange],
  );
  // K11-18: while Change prices is open the panel owns Cancel and the primary; the bar's pair (and a Discard question
  // that would be a second primary) steps aside, and Ctrl/Cmd+S says so instead of saving.
  const confirm = asking && !changePricesOpen;
  // Keep editing is a fresh node (see the keys below), so focus must be handed back when the question goes: to Cancel,
  // which raised it. A host that controls `asking` (the window) puts focus back itself.
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const wasConfirm = React.useRef(false);
  React.useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (wasConfirm.current && !confirm && lost && askingProp === undefined)
      cancelRef.current?.focus({ preventScroll: true });
    wasConfirm.current = confirm;
  }, [confirm, askingProp]);
  const [told, setTold] = React.useState(false);
  const barRef = useBarScrollPadding();
  const bottom = useShellBottom(d.editing);
  React.useEffect(() => {
    if (!here) setConfirm(false);
  }, [here, setConfirm]);
  React.useEffect(() => {
    if (!changePricesOpen) {
      setTold(false);
      return;
    }
    // A bar that is not shown (the window is the editing surface) must not eat the other surface's Ctrl/Cmd+S.
    if (!here) return;
    setConfirm(false);
    const block = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation(); // before the draft's own Ctrl/Cmd+S listener on the document
        setTold(true);
      }
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [changePricesOpen, here, setConfirm]);
  if (!here) return null;
  const label = (ref: string) => d.grid?.rows.find((r) => r.ref === ref)?.label ?? ref;
  return (
    <div
      // A window's bar neither measures itself for #main-content nor sticks: the window pins it.
      ref={windowed ? undefined : barRef}
      role="region"
      aria-label="Unsaved changes"
      data-testid={T.editbar}
      style={windowed ? undefined : { bottom: `${bottom}px` }}
      className={
        windowed
          ? "bg-white"
          : `sticky z-30 mt-4 rounded-lg border bg-white/95 px-4 py-3 backdrop-blur ${FRAME_BORDER}`
      }
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
            // K11-18: the wider "Finish Change prices first." link would squeeze this onto two lines at phone width
            // (+4 px of bar height); beside the open panel it is stale anyway, so below sm it is read, not shown.
            <span className={changePricesOpen ? "max-sm:sr-only" : undefined}>
              {d.count === 0
                ? "Nothing changed yet"
                : countLine(d.count, d.appliedLead, d.appliedFollows)}
            </span>
          )}
          {told && changePricesOpen && <span className="sr-only">{SAVE_PAUSED}</span>}
          {!confirm && !changePricesOpen && (
            <span data-testid={T.ebHint} className="ml-2 hidden text-xs text-navy/60 md:inline">
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
        {/* Keyed so each state is a fresh set of buttons: Keep editing's autoFocus only runs on a new node, and a reused
            Cancel node would keep focus while reading "Discard". */}
        {confirm ? (
          <div key="confirm" className="flex items-center gap-2">
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
        ) : changePricesOpen ? (
          <div key="finish" className="flex min-h-9 items-center">
            <button
              type="button"
              onClick={() => document.getElementById(`change-panel${sfx}`)?.focus()}
              className="rounded text-sm font-medium text-navy hover:text-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
            >
              {FINISH_FIRST}
            </button>
          </div>
        ) : (
          <div key="actions" className="flex items-center gap-2">
            <button
              ref={cancelRef}
              type="button"
              data-testid={T.ebCancel}
              className={BTN}
              onClick={() => (d.dirty ? setConfirm(true) : d.discard())}
            >
              Cancel
            </button>
            <button
              type="button"
              id={`${T.ebSave}${sfx}`}
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
        // K11-18: with Change prices open the bar has no Save; the next step is Apply (or the panel, while Apply is off).
        const apply = document.getElementById("ch-apply") as HTMLButtonElement | null;
        (
          document.getElementById(T.ebSave) ??
          (apply && !apply.disabled ? apply : document.getElementById("change-panel"))
        )?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium focus:text-navy focus:shadow"
    >
      Skip to Save
    </a>
  );
  return host ? createPortal(link, host) : link;
}
