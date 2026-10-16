"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { usePricesV2Enabled } from "@/lib/api/units-v2";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { useEscapeCloses } from "../confirm/useEscapeCloses";
import { PLAN_TESTIDS as T } from "./plan-testids";

/** The "Change prices" opener and its panel (V17: closing returns focus to the opener). Renders nothing with the flag off. */
export function ChangePrices() {
  const enabled = usePricesV2Enabled();
  const [open, setOpen] = React.useState(false);
  const opener = React.useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  // V17: Escape closes the topmost open panel on the shared stack and returns focus to the opener.
  useEscapeCloses(open && enabled, close, opener);
  if (!enabled) return null;
  return (
    <>
      <Button
        ref={opener}
        id="btn-change-open"
        data-testid={T.openChange}
        variant="secondary"
        size="sm"
        type="button"
        aria-expanded={open}
        aria-controls={T.changePanel}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Change prices
      </Button>
      {open && <ChangePricesPanel onClose={close} />}
    </>
  );
}
