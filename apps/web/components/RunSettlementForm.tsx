"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Input, Textarea, useToast } from "@routeflow/ui/web";
import {
  computeVariance,
  expectedPhysicalCash,
  roundMoney,
  varianceNeedsReason,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import { useSettleRun, useUpdateRouteRunStatus, type RouteRun } from "@/lib/api/routes";
import { formatMoney } from "@/lib/format";
import { genericToastCopy } from "@/lib/generic-toast-copy";

// An uncoded 400 here is a stop reopened since the page loaded, or a run that moved on: the screen
// refreshes, so the sentence points at it.
const REFUSAL_COPY = "The run changed while you were saving. Check its stops, then try again.";

/**
 * SA-1098 A-1 (PR-S): the one run-settlement form, behind the driver's "Settle your run" and the office's
 * "Settle run" / "Amend". It shows what the server expects (cash and checks on two lines), takes one count,
 * and asks for a reason only when the count differs by more than a cent. The server computes the expected
 * figure itself and stays the judge: a count it refuses for want of a reason re-opens the reason here.
 *
 * - `driver`: settles once, then finishes the run (PATCH COMPLETED). Settle and finish are two writes, so a
 *   retry after a failed finish sends only the finish, and a lost settle response (`RUN_ALREADY_SETTLED`)
 *   carries on to the finish, the same as the native screen.
 * - `office`: settles only. Finishing is its own button on the run page.
 * - `amend`: writes a new count over an existing settlement (an operator may; a driver may not).
 */
export type RunSettlementMode = "driver" | "office" | "amend";

type RunFigures = Pick<RouteRun, "id" | "collectedPayments" | "settlementNote">;

const SUBMIT_LABEL: Record<RunSettlementMode, string> = {
  driver: "Settle and finish route",
  office: "Settle run",
  amend: "Save new count",
};

function parseCount(raw: string): number | null {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) return null;
  return roundMoney(n);
}

function errorCode(e: unknown): string | undefined {
  return (e as { response?: { data?: { code?: string } } })?.response?.data?.code;
}

export function RunSettlementForm({
  run,
  mode,
  onDone,
}: {
  run: RunFigures;
  mode: RunSettlementMode;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const settleRun = useSettleRun();
  const updateStatus = useUpdateRouteRunStatus();

  const [counted, setCounted] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [serverDemandsReason, setServerDemandsReason] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  // Set once this form's settlement is on record, so a retry after a failed finish sends only the finish.
  const settledRef = React.useRef(false);
  // The submit latch is a ref set before the first await, never the `saving` state: two taps in one
  // tick both read a stale `saving` and would send two settlements. Released in `finally` so a failed
  // attempt can retry (lesson on money-writing submits).
  const inFlight = React.useRef(false);

  const loaded = run.collectedPayments != null;
  const expected = expectedPhysicalCash(run.collectedPayments) ?? 0;
  const cash = run.collectedPayments?.cashTotal ?? 0;
  const checks = run.collectedPayments?.checkTotal ?? 0;
  const countedNum = parseCount(counted);
  const needsReason =
    serverDemandsReason || (countedNum != null && varianceNeedsReason(expected, countedNum));
  const variance = countedNum == null ? 0 : computeVariance(expected, countedNum);

  // A driver settles once: a run settled before this screen opened goes straight to finishing.
  const needsSettle = mode !== "driver" || (!settledRef.current && run.settlementNote == null);

  async function submit() {
    if (!loaded || inFlight.current) return;
    if (needsSettle) {
      if (countedNum == null) {
        setError("Enter the cash and checks you counted.");
        return;
      }
      if (needsReason && reason.trim() === "") {
        setError("Add a reason for the difference.");
        return;
      }
    }
    setError(null);
    inFlight.current = true;
    setSaving(true);
    try {
      if (needsSettle) {
        try {
          await settleRun.mutateAsync({
            id: run.id,
            countedCash: countedNum as number,
            varianceReason: needsReason ? reason.trim() : undefined,
          });
        } catch (e) {
          // A settle whose response was lost already landed: carry on to the finish (driver only; the
          // server never gives an operator this code).
          if (mode !== "driver" || errorCode(e) !== API_ERROR_CODES.RUN_ALREADY_SETTLED) throw e;
          toast({ title: "Settlement already recorded.", variant: "success" });
        }
        settledRef.current = true;
      } else {
        toast({ title: "Settlement already recorded.", variant: "success" });
      }
      if (mode === "driver") {
        await updateStatus.mutateAsync({ id: run.id, status: "COMPLETED" });
      }
      onDone();
    } catch (e) {
      if (errorCode(e) === API_ERROR_CODES.RUN_VARIANCE_REASON_REQUIRED) {
        // The expected figure moved since this page loaded (a payment landed). Keep the count, open the
        // reason and refresh the figure.
        setServerDemandsReason(true);
        setError("The expected amount changed. Add a reason for the difference and save again.");
      } else {
        toast({
          title: "Couldn't save the settlement",
          description: genericToastCopy(e, REFUSAL_COPY),
          variant: "error",
        });
      }
      // A stop reopened meanwhile, or another driver's run: refresh and let the screen show the truth.
      void queryClient.invalidateQueries({ queryKey: ["route-runs"] });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-navy/70">
        {loaded
          ? `Collected on this run: ${run.collectedPayments?.count ?? 0} payment${
              run.collectedPayments?.count === 1 ? "" : "s"
            }.`
          : "Loading what this run collected…"}
      </p>

      <dl className="divide-y divide-surface-border rounded-lg border border-surface-border">
        {cash > 0 && (
          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
            <dt className="text-navy/80">Cash</dt>
            <dd className="font-medium text-navy">{formatMoney(cash)}</dd>
          </div>
        )}
        {checks > 0 && (
          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
            <dt className="text-navy/80">Checks</dt>
            <dd className="font-medium text-navy">{formatMoney(checks)}</dd>
          </div>
        )}
        <div className="flex items-center justify-between bg-surface-raised px-4 py-2.5 text-sm">
          <dt className="font-semibold text-navy">Cash and checks to hand in</dt>
          <dd className="font-semibold text-navy" data-testid="settlement-expected">
            {formatMoney(expected)}
          </dd>
        </div>
      </dl>

      {needsSettle && (
        <>
          <Input
            label="Cash and checks counted"
            inputMode="decimal"
            autoComplete="off"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            disabled={saving}
          />
          {needsReason && (
            <div className="space-y-1">
              {countedNum != null && variance !== 0 && (
                <p className="text-sm text-navy/70">
                  {`The count is ${formatMoney(Math.abs(variance))} ${variance > 0 ? "over" : "short"}.`}
                </p>
              )}
              <Textarea
                label="Why is it different?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                disabled={saving}
              />
            </div>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <Button
        variant="primary"
        className="w-full"
        onClick={submit}
        loading={saving}
        disabled={!loaded || saving}
      >
        {SUBMIT_LABEL[mode]}
      </Button>
    </div>
  );
}
