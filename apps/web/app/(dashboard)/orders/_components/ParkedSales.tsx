"use client";

// SA-748: the counter header's "Park" and "Parked (n)" buttons, their messages and the two dialogs. Own file so
// CounterSaleScreen takes one mount line and the state setters it already owns.
import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { PARKED_EDITED_PRICES_COPY } from "@/lib/counter-park";
import { ParkedSalesDialog } from "./ParkedSalesDialog";
import { useParkedSales, type ParkedSalesDeps } from "./useParkedSales";

export interface ParkedSalesProps extends ParkedSalesDeps {
  /** the ONE price-edit gate (`canEditPrices(user)`) of the person completing this sale */
  canEditPrices: boolean;
}

export function ParkedSales({ canEditPrices, ...deps }: ParkedSalesProps) {
  const p = useParkedSales(deps);
  const openerRef = React.useRef<HTMLButtonElement>(null);
  // An edited price is checked at Complete against the COMPLETING user (the server refuses it with a fixed 403 copy). A person
  // who cannot edit prices has no Reset control, so a resumed edited line says so up front instead of failing silently.
  const hasEditedLine = deps.cart.lines.some((l) => !!(l as { override?: unknown }).override);
  const headerMessage = p.message?.scope === "header" ? p.message.text : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-testid="counter-park-actions">
        <Button className="min-h-[44px]" variant="secondary" disabled={!p.canPark} onClick={p.park}>
          Park
        </Button>
        <Button
          ref={openerRef}
          className="min-h-[44px]"
          variant="secondary"
          onClick={() => p.setOpen(true)}
        >
          {p.count > 0 ? `Parked (${p.count})` : "Parked"}
        </Button>
      </div>
      {headerMessage ? (
        <p role="alert" className="w-full text-sm text-red-700" data-testid="counter-park-error">
          {headerMessage}
        </p>
      ) : null}
      {!canEditPrices && hasEditedLine ? (
        <p
          role="status"
          className="w-full text-sm text-amber-800"
          data-testid="counter-park-edited"
        >
          {PARKED_EDITED_PRICES_COPY}
        </p>
      ) : null}
      <ParkedSalesDialog parked={p} openerRef={openerRef} />
    </>
  );
}
