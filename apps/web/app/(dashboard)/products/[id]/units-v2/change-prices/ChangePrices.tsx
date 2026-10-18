"use client";

import * as React from "react";
import { usePricesV2Enabled } from "@/lib/api/units-v2";
import { UNITS_V2_TESTIDS } from "../../units-v2-testids";
import { useEscapeCloses } from "../confirm/useEscapeCloses";
import { ChangePricesPanel } from "./ChangePricesPanel";

/**
 * State for "Change prices": the opener button lives in K3's Edit row (V08), the panel below it. `close` returns
 * focus to the opener (V17). `enabled` is the plan flag; with it off nothing of Change prices renders.
 */
export function useChangePrices() {
  const enabled = usePricesV2Enabled();
  const [open, setOpen] = React.useState(false);
  const opener = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);
  const toggle = () => (open ? close() : setOpen(true));
  return { enabled, open: open && enabled, opener, toggle, close };
}

/** The Change prices panel. Escape closes it through the shared stack and returns focus to the opener (V17). */
export function ChangePrices({
  open,
  onClose,
  openerRef,
  idSuffix = "",
}: {
  open: boolean;
  onClose: () => void;
  openerRef: React.RefObject<HTMLElement | null>;
  /** K11-20: the floating price window's instance suffix for the fixed ids; the page's own panel has none. */
  idSuffix?: string;
}) {
  useEscapeCloses(open, onClose, openerRef);
  // K11-15: Apply closes the panel and the owner's next step is Save, so focus goes there (Cancel and Escape still go
  // back to the opener). Two commits on purpose: the first starts edit mode and the grid's own effect then puts focus
  // on its first price box (it is an ancestor of this component, so its effect runs after ours); the second is ours.
  const [toSave, setToSave] = React.useState(0);
  React.useEffect(() => {
    if (toSave === 1) setToSave(2);
    if (toSave === 2) {
      document.getElementById(`${UNITS_V2_TESTIDS.ebSave}${idSuffix}`)?.focus();
      setToSave(0);
    }
  }, [toSave, idSuffix]);
  const applied = () => {
    onClose();
    setToSave(1);
  };
  return open ? (
    <ChangePricesPanel onClose={onClose} onApplied={applied} idSuffix={idSuffix} />
  ) : null;
}
