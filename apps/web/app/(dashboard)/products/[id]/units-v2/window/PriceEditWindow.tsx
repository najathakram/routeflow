"use client";

import * as React from "react";
import { FloatingPanel, type FloatingPanelTarget } from "@routeflow/ui/web";
import type { UnitsCardProduct } from "../../ProductUnitsCard";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { ChangePrices, useChangePrices } from "../change-prices/ChangePrices";
import { closeTopEscapePanel } from "../confirm/useEscapeCloses";
import { EditablePricesGrid } from "../edit/EditablePricesGrid";
import { PriceEditBar } from "../edit/PriceEditBar";
import { usePriceDraft } from "../edit/usePriceDraft";

/** Why the window asked to close: a save went through, the owner cancelled a clean draft, or discarded a dirty one. */
export type PriceEditWindowReason = "saved" | "cancel" | "discarded";

/** The body is a table from this width up (its own width, never the viewport's), cards below. */
const TABLE_MIN_WIDTH = 560;
type BodyLayout = "table" | "cards";
const layoutFor = (width: number): BodyLayout => (width >= TABLE_MIN_WIDTH ? "table" : "cards");
/** Until the body has been measured: the panel is anchored (and wide enough for a table) from md up. */
const guessLayout = (): BodyLayout =>
  typeof window !== "undefined" && window.innerWidth < 768 ? "cards" : "table";

const instanceSuffix = (uid: string) => `-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`;

/**
 * K11-20: the price editor as a small floating window over the card that opened it. It is the v2 editor itself, not a
 * copy: the same grid in edit mode, the same Change prices and Also-update panels, the same bar and the same draft
 * (this must be mounted inside a PriceDraftProvider). Only one editor edits at a time: the window starts the draft in
 * its own surface and the inline grid steps aside. It closes when the draft ends (saved, cancelled or discarded) and
 * says why; a dirty close always asks first, so there is never a hidden draft.
 */
export function PriceEditWindow({
  product,
  open,
  anchor,
  origin,
  focus,
  returnFocus,
  onClose,
}: {
  product: UnitsCardProduct & { msrp?: number | string | null; name?: string | null };
  open: boolean;
  /** The card the window hangs off. */
  anchor: HTMLElement | null | undefined;
  /** What opened it (the header trigger or the price figure that was clicked). */
  origin: HTMLElement | null | undefined;
  /** The price the window opens on; without it, the first editable box. */
  focus?: { ref: string; tier: number };
  /** Fallback only: where focus goes on close when the element that opened the window is gone (the card heading's getter). */
  returnFocus?: FloatingPanelTarget;
  onClose: (reason: PriceEditWindowReason) => void;
}) {
  const d = usePriceDraft();
  const cp = useChangePrices();
  const suffix = instanceSuffix(React.useId());
  const [asking, setAsking] = React.useState(false);

  // Latest values for handlers and effects that must not re-run on every render.
  const live = React.useRef({ d, cpOpen: cp.open, asking, focus, onClose });
  live.current = { d, cpOpen: cp.open, asking, focus, onClose };
  const cpClose = React.useRef(cp.close);
  cpClose.current = cp.close;

  // One close per opening, whichever path gets there first.
  const finished = React.useRef(false);
  const finish = React.useCallback((reason: PriceEditWindowReason) => {
    if (finished.current) return;
    finished.current = true;
    live.current.onClose(reason);
  }, []);

  // --- layout: the window's own width, not the viewport's -------------------------------------------------------
  const [body, setBody] = React.useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = React.useState<BodyLayout | null>(null);
  React.useLayoutEffect(() => {
    if (!body) {
      setLayout(null);
      return undefined;
    }
    // clientWidth is the laid-out width (the open animation scales the box, so its bounding rect would lie).
    if (body.clientWidth > 0) setLayout(layoutFor(body.clientWidth));
    if (typeof ResizeObserver === "undefined") {
      if (body.clientWidth === 0) setLayout(guessLayout());
      return undefined;
    }
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? body.clientWidth;
      if (width > 0) setLayout(layoutFor(width));
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, [body]);

  // --- start: the draft begins in this surface once the layout is known (focus targets name a layout) -------------
  const started = React.useRef(false);
  React.useLayoutEffect(() => {
    if (!open) {
      // Ready for the next opening.
      started.current = false;
      finished.current = false;
      return;
    }
    if (layout === null || started.current) return;
    started.current = true;
    const f = live.current.focus;
    const ok = live.current.d.startEditing(
      f ? { ref: f.ref, tier: f.tier, layout: layout === "table" ? "table" : "card" } : undefined,
      "window",
    );
    // The inline grid is already editing: there is nothing for the window to show.
    if (!ok) finish("cancel");
  }, [open, layout, finish]);

  // --- lifecycle: a new opening is unfinished; a closing never leaves the window's draft behind ----------------------
  React.useEffect(() => {
    if (!open) return undefined;
    return () => {
      const cur = live.current.d;
      if (cur.editingIn === "window") cur.discard();
      setAsking(false);
      cpClose.current();
    };
  }, [open]);

  // --- end: the draft left the window surface (saved, or the bar's Cancel / Discard) --------------------------------
  const prevIn = React.useRef(d.editingIn);
  const wasDirty = React.useRef(false);
  React.useEffect(() => {
    if (open && prevIn.current === "window" && d.editingIn === null) {
      finish(
        d.lastSave?.surface === "window" ? "saved" : wasDirty.current ? "discarded" : "cancel",
      );
    }
    if (d.editingIn === "window") wasDirty.current = d.dirty;
    prevIn.current = d.editingIn;
  }, [open, d.editingIn, d.dirty, d.lastSave, finish]);

  // --- the discard question ---------------------------------------------------------------------------------------
  const beforeAsk = React.useRef<Element | null>(null);
  const ask = React.useCallback((on: boolean) => {
    if (on) beforeAsk.current = document.activeElement;
    setAsking(on);
  }, []);
  const wasAsking = React.useRef(false);
  React.useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (wasAsking.current && !asking && open && lost) {
      // Keep editing took its button away: put focus back where it was (else the first price box).
      const back = beforeAsk.current;
      const target =
        back instanceof HTMLElement && back.isConnected && body?.contains(back)
          ? back
          : body?.querySelector<HTMLElement>('[data-testid^="units-v2-input-"]');
      target?.focus({ preventScroll: true });
    }
    wasAsking.current = asking;
  }, [asking, open, body]);

  // A close that is not a Cancel button: the X, the scrim, and Escape when nothing more local wants it.
  const requestClose = React.useCallback(() => {
    const cur = live.current;
    if (cur.cpOpen) {
      // The Change prices panel owns Cancel while it is open (K11-18): close it first.
      closeTopEscapePanel();
      return;
    }
    if (cur.d.dirty) {
      ask(true);
      return;
    }
    cur.d.discard();
    finish("cancel");
  }, [ask, finish]);

  return (
    <FloatingPanel
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      anchor={anchor}
      origin={origin}
      title="Edit prices"
      description={product.name ?? undefined}
      returnFocus={returnFocus}
      // Radix would dismiss on Escape before our own handlers see it, so the window always decides: (1) a box with
      // something to put back does it itself; (2) an open Change prices panel closes; (3) the discard question is
      // Keep editing; (4) otherwise the close rule.
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.hasAttribute("data-escape-reverts")) return;
        if (live.current.cpOpen) {
          closeTopEscapePanel();
          return;
        }
        if (live.current.asking) {
          ask(false);
          return;
        }
        requestClose();
      }}
      // An outside press is never a silent discard: it takes the same road as the X.
      onInteractOutside={(event) => {
        event.preventDefault();
        if (event.type.includes("pointerDownOutside")) requestClose();
      }}
      footer={
        d.editingIn === "window" ? (
          <PriceEditBar
            placement="window"
            idSuffix={suffix}
            changePricesOpen={cp.open}
            asking={asking}
            onAskingChange={ask}
          />
        ) : null
      }
    >
      <div ref={setBody} data-testid={T.priceWindow}>
        <EditablePricesGrid
          product={product}
          surface="window"
          idSuffix={suffix}
          layout={layout ?? guessLayout()}
          density="compact"
          onOpenChangePrices={cp.enabled ? cp.toggle : undefined}
          changePricesOpen={cp.open}
          changePricesRef={cp.opener}
          panel={
            <ChangePrices
              open={cp.open}
              onClose={cp.close}
              openerRef={cp.opener}
              idSuffix={suffix}
            />
          }
        />
      </div>
    </FloatingPanel>
  );
}
