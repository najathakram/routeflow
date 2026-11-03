"use client";

import * as React from "react";
import { Button, Modal } from "@routeflow/ui/web";
import { RunSettlementForm } from "@/components/RunSettlementForm";
import { driverRunFooter } from "@/lib/run-settlement-controls";
import type { RouteRun } from "@/lib/api/routes";

/**
 * SA-1098 A-1 (PR-S): the driver's run footer on Today's route (placed above the all-done stop list, so it is in
 * thumb reach on a long run). Once no stop is left, a run holding cash or checks
 * with no settlement on record offers one primary, "Settle your run": the server's figure, one count, a reason only
 * when it differs by more than a cent, then the run finishes. The decision is `driverRunFooter` (one function, so
 * this footer and the office card cannot drift). It reads the money figure on the run, never the `driver_payments`
 * add-on, so cash already taken can still be settled after the add-on is removed.
 *
 * Finishing a run with nothing to settle ("Finish route") is its own control, not this component's.
 */
export function RunSettleFooter({ run }: { run: RouteRun }) {
  const [open, setOpen] = React.useState(false);
  if (driverRunFooter(run) !== "SETTLE") return null;

  return (
    <div className="px-5 pb-5">
      <Button
        variant="primary"
        size="lg"
        className="h-14 w-full text-base font-semibold"
        onClick={() => setOpen(true)}
      >
        Settle your run
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Settle your run"
        description="Count the cash and checks you collected, then hand them in."
      >
        {open && <RunSettlementForm run={run} mode="driver" onDone={() => setOpen(false)} />}
      </Modal>
    </div>
  );
}
