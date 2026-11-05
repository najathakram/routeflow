"use client";

import * as React from "react";
import { Modal, Button, Badge, Textarea } from "@routeflow/ui/web";
import {
  buildStopDeliveries,
  caseStepperCasesDelivered,
  caseStepperDecrement,
  caseStepperIncrement,
  fallbackShortPickLines,
  formatCaseStepperSplit,
  isUnitAwareLine,
  linesAwaitingEntry,
  normalizeDeliveryPlan,
  type ShortPickLine,
} from "@routeflow/pricing";
import {
  useCompleteStop,
  useReopenStop,
  useUpdateStopStatus,
  type RouteRun,
  type RouteRunStop,
  type RunStopOrder,
} from "@/lib/api/routes";
import {
  leftToDeliverText,
  stopErrorCopy,
  stopUndoErrorCopy,
  type StopErrorCopy,
} from "@/lib/driver-stop-copy";
import { releaseStopKey } from "@/lib/stop-completion-key";

/** Apple Maps on iOS/iPadOS, Google Maps everywhere else — mirrors the native
 *  app's openInMaps.ts choice of provider (see apps/mobile/components/openInMaps.ts). */
function isApplePhoneOrTablet(): boolean {
  return typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/** Builds a maps search URL for a stop. Prefers "Business Name, Address" so the
 *  maps app matches the real place listing, same preference order as the
 *  native app's stopToWaypoint/openInMaps. Returns null with nothing to search. */
function stopMapsUrl(stop: RouteRunStop): string | null {
  const address = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state}`
    : undefined;
  const label = stop.customer?.businessName;
  const query = address ? (label ? `${label}, ${address}` : address) : label;
  if (!query) return null;
  return isApplePhoneOrTablet()
    ? `http://maps.apple.com/?q=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** The chip beside an order. The stop's own status wins once the stop is done: a held run shows the snapshot from before the
 *  completion, and a skipped stop's orders went back to the office, so neither may read "In progress" beside Undo. */
function orderStatusBadge(status: string, stopStatus?: string) {
  if (stopStatus === "SKIPPED") return null;
  // SA-1101 §4.2: a wholly refused order reads "Refused" once its stop is done, never "Completed" or "Delivered".
  if (status === "REFUSED") return <Badge status="REFUSED" />;
  if (stopStatus === "COMPLETED" && status !== "CANCELLED") return <Badge status="COMPLETED" />;
  if (status === "DELIVERED") return <Badge status="COMPLETED" />;
  if (status === "CANCELLED") return <Badge status="CANCELLED" />;
  if (status === "OUT_FOR_DELIVERY") return <Badge status="IN_PROGRESS" />;
  return <Badge status="SCHEDULED" />;
}

/** Footer actions are 48px tall: a driver taps them one-handed, in a truck, and the design-system default (34px) is a desktop height. */
const TAP = "h-12";

function useOnline(): boolean {
  const [online, setOnline] = React.useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  React.useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

interface PlanOrder {
  order: RunStopOrder;
  lines: ShortPickLine[];
  names: Record<string, string>;
  units: Record<string, string | null>;
}

function LineQty({
  line,
  name,
  value,
  disabled,
  onChange,
}: {
  line: ShortPickLine;
  name: string;
  value: number | undefined;
  disabled: boolean;
  onChange: (qty: number | undefined) => void;
}) {
  const ordered = line.orderedQty;
  if (isUnitAwareLine(line) && value !== undefined) {
    const upb = Number(line.unitsPerBox);
    const cases = caseStepperCasesDelivered(value, ordered, upb);
    const label = (line.unitLabel ?? "").trim() || "Case";
    const shown = formatCaseStepperSplit(cases, Math.max(0, value - cases * upb), label);
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-11"
          aria-label={`Fewer ${name}`}
          disabled={disabled || value <= 0}
          onClick={() => onChange(caseStepperDecrement(value, ordered, upb))}
        >
          −
        </Button>
        <span
          className="min-w-[5.5rem] text-center text-sm font-medium text-navy"
          aria-live="polite"
        >
          {shown}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-11"
          aria-label={`More ${name}`}
          disabled={disabled || value >= ordered}
          onClick={() => onChange(caseStepperIncrement(value, ordered, upb))}
        >
          +
        </Button>
      </div>
    );
  }
  return <QtyInput line={line} name={name} value={value} disabled={disabled} onChange={onChange} />;
}

/** The plain-pack quantity box. It holds what the driver is typing (an emptied box is not "put back to full" under the cursor)
 *  and commits the clamped whole number; an emptied box means 0, except on a line the server served no `remaining` for. */
function QtyInput({
  line,
  name,
  value,
  disabled,
  onChange,
}: {
  line: ShortPickLine;
  name: string;
  value: number | undefined;
  disabled: boolean;
  onChange: (qty: number | undefined) => void;
}) {
  const ordered = line.orderedQty;
  const [text, setText] = React.useState<string | null>(null);
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={ordered}
      step={1}
      aria-label={`Delivered ${name}`}
      className="h-11 w-20 rounded-lg border border-surface-border bg-white px-2 text-right text-sm text-navy"
      value={text ?? (value === undefined ? "" : value)}
      disabled={disabled}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          setText("");
          return onChange(line.needsEntry ? undefined : 0);
        }
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n)) return;
        const clamped = Math.max(0, Math.min(ordered, n));
        setText(String(clamped));
        onChange(clamped);
      }}
    />
  );
}

export interface StopSheetProps {
  /** null closes the sheet — Modal's own open/onClose stays in sync with this. */
  stop: RouteRunStop | null;
  runId: string | null;
  /** The run's status. Deliveries are recorded only while it is IN_PROGRESS (the server refuses them otherwise). */
  runStatus?: RouteRun["status"];
  onClose: () => void;
  /** A completion landed (not a skip or an Undo). The page uses it to keep a run that finished itself on screen for Undo. */
  onCompleted?: (done: { runId: string; stopId: string }) => void;
}

/**
 * SA-1098 PR-2: a stop on the web driver screen. Customer, address and the order lines (what is left to deliver, from the server's
 * own `remaining`), then Delivered / Refused / Skip / Undo. Delivered sends one explicit entry per line of EVERY order at the stop
 * through the shared `buildStopDeliveries`; a short delivery is a changed quantity. It records what was delivered and never takes
 * money (no `payment` in the request).
 */
export function StopSheet({
  stop,
  runId,
  runStatus = "IN_PROGRESS",
  onClose,
  onCompleted,
}: StopSheetProps) {
  const updateStatus = useUpdateStopStatus();
  const complete = useCompleteStop();
  const reopen = useReopenStop();
  const online = useOnline();
  const inFlight = React.useRef(false);

  const [qtyById, setQtyById] = React.useState<Record<string, number | undefined>>({});
  const [refusing, setRefusing] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<StopErrorCopy | null>(null);

  const stopId = stop?.id;
  React.useEffect(() => {
    setQtyById({});
    setRefusing(false);
    setReason("");
    setError(null);
  }, [stopId]);

  // A refresh that shows the stop done settles an earlier attempt whose answer was lost: its key must not outlive it, or after an
  // Undo the same key would answer "completed" for a stop that is open again.
  const shownDone = stop?.status === "COMPLETED" || stop?.status === "SKIPPED";
  // The same refresh also settles the sentence: a lost answer left "we couldn't confirm" on screen, and now the stop reads done.
  React.useEffect(() => {
    if (!stopId || !shownDone) return;
    releaseStopKey(stopId);
    setError(null);
  }, [stopId, shownDone]);

  const mapsUrl = stop ? stopMapsUrl(stop) : null;
  const phone = stop?.customer?.phone?.trim();
  const orders = React.useMemo(() => stop?.orders ?? [], [stop]);

  const plans: PlanOrder[] = React.useMemo(
    () =>
      orders.map((order) => {
        const names: Record<string, string> = {};
        const units: Record<string, string | null> = {};
        for (const li of order.lineItems ?? []) {
          names[li.id] = li.product?.name ?? "Item";
          units[li.id] = li.product?.unit ?? null;
        }
        return { order, lines: fallbackShortPickLines(order), names, units };
      }),
    [orders],
  );

  const linesLoaded = orders.length > 0 && orders.every((o) => Array.isArray(o.lineItems));
  const allLines = plans.flatMap((p) => p.lines);
  const entered = Object.fromEntries(
    Object.entries(qtyById).filter(([, v]) => v !== undefined),
  ) as Record<string, number>;
  const shown = normalizeDeliveryPlan(allLines, entered);
  const awaiting = linesAwaitingEntry(allLines, entered);
  const deliveredTotal = allLines.reduce((n, li) => n + (shown[li.orderItemId] ?? 0), 0);

  const open = stop?.status === "PENDING" || stop?.status === "IN_PROGRESS";
  const runOpen = runStatus === "IN_PROGRESS";
  const busy = complete.isPending || reopen.isPending || updateStatus.isPending;
  const canRecord =
    !!stop && !!runId && open && runOpen && online && linesLoaded && allLines.length > 0 && !busy;

  const fail = (err: unknown) => {
    inFlight.current = false;
    setError(stopErrorCopy(err));
  };

  const failUndo = (err: unknown) => {
    inFlight.current = false;
    setError(stopUndoErrorCopy(err));
  };

  const send = (mode: "deliver" | "refuse") => {
    if (!stop || !runId || inFlight.current) return;
    if (mode === "refuse" && !reason.trim()) return;
    inFlight.current = true;
    setError(null);
    const plan = plans.map((p) => ({
      orderId: p.order.id,
      lines: p.lines,
      deliveredQtyById:
        mode === "refuse"
          ? Object.fromEntries(p.lines.map((li) => [li.orderItemId, 0]))
          : Object.fromEntries(
              p.lines.map((li) => [li.orderItemId, shown[li.orderItemId] ?? li.orderedQty]),
            ),
    }));
    let deliveries;
    try {
      deliveries = buildStopDeliveries(plan);
    } catch {
      inFlight.current = false;
      return;
    }
    complete.mutate(
      {
        runId,
        stopId: stop.id,
        deliveries,
        driverNote: mode === "refuse" ? reason.trim() : undefined,
      },
      {
        onSuccess: () => {
          inFlight.current = false;
          onCompleted?.({ runId, stopId: stop.id });
          onClose();
        },
        onError: fail,
      },
    );
  };

  const handleStart = () => {
    if (!stop || !runId) return;
    setError(null);
    updateStatus.mutate(
      { runId, stopId: stop.id, status: "IN_PROGRESS" },
      { onSuccess: onClose, onError: fail },
    );
  };

  const handleSkip = () => {
    if (!stop || !runId) return;
    if (!window.confirm(`Skip the stop at ${stop.customer?.businessName ?? "this address"}?`))
      return;
    setError(null);
    updateStatus.mutate(
      { runId, stopId: stop.id, status: "SKIPPED" },
      { onSuccess: onClose, onError: fail },
    );
  };

  const handleUndo = () => {
    if (!stop || !runId) return;
    if (!window.confirm("Undo this stop? It goes back on the route.")) return;
    setError(null);
    reopen.mutate({ runId, stopId: stop.id }, { onSuccess: onClose, onError: failUndo });
  };

  const done = stop?.status === "COMPLETED" || stop?.status === "SKIPPED";
  // SA-1098 A-3 (D-49..D-51): the server frees a skipped stop's orders when its run ends and refuses to reopen it on a finished run,
  // so the button could only lead to an office sentence. A skipped stop on a run that is not open, or with no orders left, has no Undo.
  const releasedSkip =
    stop?.status === "SKIPPED" && (runStatus !== "IN_PROGRESS" || orders.length === 0);

  return (
    <Modal
      open={!!stop}
      onClose={onClose}
      title={stop?.customer?.businessName ?? "Stop"}
      description={
        stop?.customerAddress
          ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state}`
          : undefined
      }
      scroll
      footer={
        <div className="flex w-full flex-col gap-2">
          {open && runOpen && !refusing && (
            <div className="grid grid-cols-2 gap-2">
              <Button
                className={TAP}
                variant="primary"
                onClick={() => send("deliver")}
                loading={complete.isPending}
                disabled={!canRecord || awaiting.length > 0 || deliveredTotal <= 0}
              >
                Delivered
              </Button>
              <Button
                className={TAP}
                variant="secondary"
                onClick={() => setRefusing(true)}
                disabled={!canRecord}
              >
                Refused
              </Button>
            </div>
          )}
          {open && runOpen && refusing && (
            <div className="grid grid-cols-2 gap-2">
              <Button
                className={TAP}
                variant="secondary"
                onClick={() => setRefusing(false)}
                disabled={busy}
              >
                Back
              </Button>
              <Button
                className={TAP}
                variant="danger"
                onClick={() => send("refuse")}
                loading={complete.isPending}
                disabled={!canRecord || !reason.trim()}
              >
                Confirm refusal
              </Button>
            </div>
          )}
          {done && !releasedSkip && (
            <Button
              className={TAP}
              variant="secondary"
              onClick={handleUndo}
              loading={reopen.isPending}
              disabled={busy || !online}
            >
              Undo
            </Button>
          )}
          {releasedSkip && (
            <p className="text-sm text-navy/70">
              Skipped. Anything not delivered went back to your office.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button
              className={TAP}
              variant="secondary"
              disabled={!mapsUrl}
              onClick={() => mapsUrl && window.open(mapsUrl, "_blank", "noopener,noreferrer")}
            >
              Navigate
            </Button>
            <Button
              className={TAP}
              variant="secondary"
              href={phone ? `tel:${phone}` : undefined}
              disabled={!phone}
            >
              Call
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              className={TAP}
              variant="secondary"
              onClick={handleStart}
              loading={updateStatus.isPending && updateStatus.variables?.status === "IN_PROGRESS"}
              disabled={stop?.status !== "PENDING" || busy || !online}
            >
              Start stop
            </Button>
            <Button
              className={TAP}
              variant="danger-outline"
              onClick={handleSkip}
              loading={updateStatus.isPending && updateStatus.variables?.status === "SKIPPED"}
              disabled={done || busy || !online}
            >
              Skip
            </Button>
          </div>
        </div>
      }
    >
      {orders.length > 0 ? (
        <ul className="divide-y divide-surface-border">
          {plans.map(({ order, lines, names, units }) => (
            <li key={order.id} className="py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-navy">{order.orderNumber}</span>
                {orderStatusBadge(order.status, stop?.status)}
              </div>
              {open && runOpen && !refusing && lines.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {lines.map((li) => (
                    <li key={li.orderItemId} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-navy">{names[li.orderItemId]}</p>
                        <p className="text-xs text-navy/60">
                          Left to deliver: {leftToDeliverText(li, units[li.orderItemId])}
                        </p>
                      </div>
                      <LineQty
                        line={li}
                        name={names[li.orderItemId] ?? "item"}
                        value={shown[li.orderItemId]}
                        disabled={busy}
                        onChange={(q) => setQtyById((m) => ({ ...m, [li.orderItemId]: q }))}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-navy/70">No orders on this stop.</p>
      )}
      {open && runOpen && refusing && (
        <div className="mt-3">
          <Textarea
            label="Why was it refused?"
            placeholder="For example, the store was closed"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
        </div>
      )}
      {open && runStatus === "SCHEDULED" && (
        <p className="mt-3 text-sm text-navy/70">Start the route to record this stop.</p>
      )}
      {open && (runStatus === "COMPLETED" || runStatus === "CANCELLED") && (
        <p className="mt-3 text-sm text-navy/70">This route has ended.</p>
      )}
      {open && runOpen && !online && (
        <p className="mt-3 text-sm text-navy/70">You are offline. Connect to record this stop.</p>
      )}
      {open && runOpen && orders.length > 0 && !linesLoaded && (
        <p className="mt-3 text-sm text-navy/70">The order lines are still loading.</p>
      )}
      {canRecord && !refusing && awaiting.length > 0 && (
        <p className="mt-3 text-sm text-navy/70">Enter a quantity for every line.</p>
      )}
      {canRecord && !refusing && awaiting.length === 0 && deliveredTotal <= 0 && (
        <p className="mt-3 text-sm text-navy/70">
          Enter a quantity above 0 to record a delivery, or tap Refused.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error.text}
        </p>
      )}
    </Modal>
  );
}
