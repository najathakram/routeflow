"use client";

import * as React from "react";
import { usePricesV2Enabled } from "@/lib/api/units-v2";
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
}: {
  open: boolean;
  onClose: () => void;
  openerRef: React.RefObject<HTMLElement | null>;
}) {
  useEscapeCloses(open, onClose, openerRef);
  return open ? <ChangePricesPanel onClose={onClose} /> : null;
}
