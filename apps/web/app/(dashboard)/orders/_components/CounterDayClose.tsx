"use client";

// SA-750: the counter's end-of-day close + Z report, mounted ABOVE the Summary in the "Today's sales" sheet (own file so
// CounterTodaysSales takes one mount line). The server recomputes every figure; the numbers in the form are a PREVIEW only.
// One till: no register picker. Error copy is fixed (the server's own message is never shown).
import * as React from "react";
import {
  DAY_CLOSE_DENOMINATIONS,
  DAY_CLOSE_MAX_COUNT,
  DAY_CLOSE_NOTES_MAX,
  dayCloseWindowIsEmpty,
  roundMoney,
  sumDenominations,
  validOpeningFloat,
  type DayCloseSnapshot,
  type DayCloseState,
} from "@routeflow/pricing";
import { Button, Input, Modal, Textarea, cn } from "@routeflow/ui/web";
import {
  Z_REPORT_RESEND_FAILED_COPY,
  DAY_REOPEN_FAILED_COPY,
  dayCloseErrorCopy,
  useCloseCounterDay,
  useCounterDayClose,
  useReopenCounterDay,
  useResendZReport,
} from "@/lib/api/counter-day-close";
import { useOptionalAuth } from "@/lib/auth-context";
import { formatReceiptMoney as money } from "@/lib/counter-receipt";

const FORM_ID = "counter-day-close-form";
const ROW_KEY = (d: { kind: string; value: number }) => `${d.kind}:${d.value}`;
const STEP = "inline-flex min-h-11 min-w-11 items-center justify-center rounded border text-lg";
const REOPEN_ROLES: ReadonlySet<string> = new Set(["OPERATOR", "TENANT_ADMIN"]);

/** "$20 bill" and "$1.00 coin": the $1 bill and the $1 coin are different rows. */
function denominationLabel(d: { kind: "bill" | "coin"; value: number }): string {
  return d.kind === "bill" ? `$${d.value} bill` : `$${d.value.toFixed(2)} coin`;
}

/** The opening float as typed: whole cents, or null while it is empty / not a valid amount. */
function parseFloatInput(raw: string): number | null {
  const t = raw.trim();
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  const n = Number(t);
  return validOpeningFloat(n) ? n : null;
}

/** Over / Under / Balanced, in words AND colour (never colour alone). */
function varianceView(variance: number): { word: string; text: string; tone: string } {
  if (variance === 0) return { word: "Balanced", text: "Balanced", tone: "text-green-700" };
  if (variance > 0)
    return { word: "Over", text: `Over ${money(variance)}`, tone: "text-amber-700" };
  return { word: "Under", text: `Under ${money(Math.abs(variance))}`, tone: "text-red-700" };
}

const timeIn = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(new Date(iso));
const dayIn = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(d);

function Figure({
  label,
  value,
  testId,
  className,
}: {
  label: string;
  value: string;
  testId: string;
  className?: string;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className={cn("tabular-nums", className)} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function DayCloseForm({
  state,
  open,
  onClose,
}: {
  state: DayCloseState;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Close day"
      description="Count the drawer. The totals are checked again when you close."
      scroll
      closeClassName="min-h-11 min-w-11 flex items-center justify-center"
      className={cn(
        "left-0 top-0 h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none p-4",
        "sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:p-6",
      )}
    >
      {open ? <DayCloseFormBody state={state} onClose={onClose} /> : null}
    </Modal>
  );
}

// The fields and the pinned submit row share one form state, so they are one component; the Modal only frames them.
function DayCloseFormBody({ state, onClose }: { state: DayCloseState; onClose: () => void }) {
  const { preview, lastClose } = state;
  // A reopened close is re-closed over its STORED window: start from what was stored.
  const reopened = lastClose?.reopenedAt ? lastClose : null;
  const [floatText, setFloatText] = React.useState(() =>
    (reopened ? reopened.openingFloat : preview.suggestedOpeningFloat).toFixed(2),
  );
  const [counts, setCounts] = React.useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const d of reopened?.denominations ?? []) init[ROW_KEY(d)] = d.count;
    return init;
  });
  const [notes, setNotes] = React.useState(reopened?.notes ?? "");
  const mutation = useCloseCounterDay();
  const [error, setError] = React.useState<string | null>(null);

  const rows = DAY_CLOSE_DENOMINATIONS.map((d) => ({ ...d, count: counts[ROW_KEY(d)] ?? 0 }));
  const openingFloat = parseFloatInput(floatText);
  const counted = sumDenominations(rows);
  const expected =
    openingFloat === null
      ? null
      : roundMoney(openingFloat + preview.tillCash - preview.cashRefunds);
  const variance = expected === null ? null : roundMoney(counted - expected);
  const view = variance === null ? null : varianceView(variance);
  const refunds = preview.totals.refunds;
  const setCount = (key: string, n: number) =>
    setCounts((c) => ({ ...c, [key]: Math.min(DAY_CLOSE_MAX_COUNT, Math.max(0, n)) }));
  const canSubmit = openingFloat !== null && !mutation.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (openingFloat === null || mutation.isPending) return;
    setError(null);
    const trimmed = notes.trim();
    mutation.mutate(
      {
        openingFloat,
        denominations: rows
          .filter((r) => r.count > 0)
          .map((r) => ({ kind: r.kind, value: r.value, count: r.count })),
        ...(trimmed ? { notes: trimmed } : {}),
      },
      { onSuccess: onClose, onError: (err) => setError(dayCloseErrorCopy(err)) },
    );
  };

  return (
    <form id={FORM_ID} onSubmit={submit} className="space-y-4" data-testid="day-close-form">
      {reopened ? (
        <p role="status" className="rounded border bg-navy/5 p-2 text-sm">
          This day was reopened. Count the drawer again to close it.
        </p>
      ) : null}
      <dl
        className="space-y-1 rounded border bg-navy/5 p-3 text-sm"
        aria-label="Drawer figures"
        data-testid="day-close-figures"
      >
        <Figure label="Counted" value={money(counted)} testId="close-counted" />
        <Figure
          label="Expected"
          value={expected === null ? "—" : money(expected)}
          testId="close-expected"
        />
        <Figure
          label="Variance"
          value={view ? view.text : "—"}
          testId="close-variance"
          className={cn("font-semibold", view?.tone)}
        />
        <p className="pt-1 text-xs text-navy/70" data-testid="close-not-at-till">
          Not taken at the till: {money(preview.totals.notAtTill)}
        </p>
        {refunds.tenderKnown === false ? (
          <p className="text-xs text-navy/70" data-testid="close-tender-note">
            Some refunds have no recorded tender and are not subtracted
          </p>
        ) : null}
      </dl>

      <Input
        label={reopened ? "Opening float (kept from the first close)" : "Opening float"}
        inputMode="decimal"
        autoComplete="off"
        className="h-11"
        value={floatText}
        readOnly={reopened != null}
        onChange={(e) => setFloatText(e.target.value)}
        error={
          openingFloat === null ? "Enter an amount in dollars and cents, 0.00 or more." : undefined
        }
      />

      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium text-navy">Cash counted</legend>
        {rows.map((r) => {
          const label = denominationLabel(r);
          const key = ROW_KEY(r);
          return (
            <div key={key} className="flex items-center gap-2" data-testid={`close-row-${key}`}>
              <span className="min-w-0 flex-1 text-sm">{label}</span>
              <button
                type="button"
                className={STEP}
                aria-label={`Fewer ${label}`}
                disabled={r.count <= 0}
                onClick={() => setCount(key, r.count - 1)}
              >
                −
              </button>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                aria-label={`${label} count`}
                className="h-11 w-16 rounded border border-surface-border bg-white px-2 text-center text-sm tabular-nums"
                value={String(r.count)}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, "");
                  setCount(key, digits === "" ? 0 : Number(digits));
                }}
              />
              <button
                type="button"
                className={STEP}
                aria-label={`More ${label}`}
                disabled={r.count >= DAY_CLOSE_MAX_COUNT}
                onClick={() => setCount(key, r.count + 1)}
              >
                +
              </button>
              <span className="w-20 text-right text-sm tabular-nums text-navy/70">
                {money(roundMoney(r.value * r.count))}
              </span>
            </div>
          );
        })}
      </fieldset>

      <div>
        <Textarea
          label="Notes"
          maxLength={DAY_CLOSE_NOTES_MAX}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <p className="mt-1 text-right text-xs text-navy/70">
          {notes.length}/{DAY_CLOSE_NOTES_MAX}
        </p>
      </div>

      <div className="sticky bottom-0 -mx-1 space-y-2 border-t bg-white px-1 pb-1 pt-3">
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" className="min-h-11" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="min-h-11"
            disabled={!canSubmit}
            loading={mutation.isPending}
          >
            Close day
          </Button>
        </div>
      </div>
    </form>
  );
}

function ClosedCard({
  close,
  zone,
  salesSince,
  canReopen,
}: {
  close: DayCloseSnapshot;
  zone: string;
  salesSince: number;
  canReopen: boolean;
}) {
  const resend = useResendZReport();
  const reopen = useReopenCounterDay();
  const [confirming, setConfirming] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const v = varianceView(close.variance);
  return (
    <div className="space-y-2 rounded border bg-navy/5 p-3 text-sm" data-testid="day-close-closed">
      <p className="font-semibold">
        Closed at {timeIn(close.closedAt, zone)} ·{" "}
        {salesSince === 1 ? "1 sale since" : `${salesSince} sales since`}
      </p>
      <dl className="space-y-1">
        <Figure label="Opening float" value={money(close.openingFloat)} testId="closed-float" />
        <Figure label="Expected" value={money(close.expectedCash)} testId="closed-expected" />
        <Figure label="Counted" value={money(close.countedCash)} testId="closed-counted" />
        <Figure
          label="Variance"
          value={varianceView(close.variance).text}
          testId="closed-variance"
          className={cn("font-semibold", v.tone)}
        />
      </dl>
      {close.reportSent === false ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-amber-700" data-testid="closed-report-not-sent">
            Report not sent
          </span>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            loading={resend.isPending}
            onClick={() => {
              setFailure(null);
              resend.mutate(close.id, { onError: () => setFailure(Z_REPORT_RESEND_FAILED_COPY) });
            }}
          >
            Resend
          </Button>
        </div>
      ) : close.reportSent === true ? (
        <p className="text-xs text-navy/70">Report sent to the admins</p>
      ) : null}
      {canReopen ? (
        <Button
          type="button"
          variant="secondary"
          className="min-h-11"
          onClick={() => {
            setFailure(null);
            setConfirming(true);
          }}
        >
          Reopen day
        </Button>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-red-700">
          {failure}
        </p>
      ) : null}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Reopen this day?"
        description="The counted figures stay stored until you close the day again."
        closeClassName="min-h-11 min-w-11 flex items-center justify-center"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11"
              loading={reopen.isPending}
              onClick={() =>
                reopen.mutate(close.id, {
                  onSuccess: () => setConfirming(false),
                  onError: () => {
                    setConfirming(false);
                    setFailure(DAY_REOPEN_FAILED_COPY);
                  },
                })
              }
            >
              Reopen day
            </Button>
          </>
        }
      >
        <p>Sales and refunds dated in this window can change again until it is closed.</p>
      </Modal>
    </div>
  );
}

export function CounterDayClose() {
  const q = useCounterDayClose(true);
  const role = useOptionalAuth()?.user?.role;
  const [formOpen, setFormOpen] = React.useState(false);
  const openerRef = React.useRef<HTMLButtonElement>(null);
  const { refetch } = q;
  const openForm = React.useCallback(() => {
    // a fresh preview for the figures: the window ends "now"
    void refetch();
    setFormOpen(true);
  }, [refetch]);

  if (q.isError && !q.data) {
    return (
      <div role="alert" className="space-y-2 text-sm" data-testid="day-close-error">
        <p>Could not load the day close.</p>
        <Button className="min-h-11" variant="secondary" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const state = q.data;
  // a malformed or partial answer proves nothing: show nothing rather than guess
  if (!state?.preview) return null;

  const last = state.lastClose;
  const closed = last && !last.reopenedAt ? last : null;
  const reopened = last?.reopenedAt ? last : null;
  // After a close the window is spent: offer the next close only once something happened since, or a new day began.
  const offerClose =
    !closed ||
    !dayCloseWindowIsEmpty(state.preview.totals) ||
    closed.day !== dayIn(new Date(), state.zone);

  return (
    <section aria-label="Day close" className="space-y-2" data-testid="day-close">
      {closed ? (
        <ClosedCard
          close={closed}
          zone={state.zone}
          salesSince={state.salesSince}
          canReopen={role !== undefined && REOPEN_ROLES.has(role)}
        />
      ) : null}
      {reopened ? (
        <p role="status" className="rounded border bg-navy/5 p-2 text-sm">
          This day was reopened. Close it again to finish.
        </p>
      ) : null}
      {offerClose ? (
        <Button ref={openerRef} className="min-h-11 w-full sm:w-auto" onClick={openForm}>
          Close day
        </Button>
      ) : null}
      <DayCloseForm state={state} open={formOpen} onClose={() => setFormOpen(false)} />
    </section>
  );
}
