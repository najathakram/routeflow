"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { usePricesV2Enabled } from "@/lib/api/units-v2";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { PLAN_TESTIDS as T } from "./plan-testids";

/** The "Change prices" opener and its panel (V17: closing returns focus to the opener). Renders nothing with the flag off. */
export function ChangePrices() {
  const enabled = usePricesV2Enabled();
  const [open, setOpen] = React.useState(false);
  const opener = React.useRef<HTMLButtonElement>(null);
  if (!enabled) return null;
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
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
