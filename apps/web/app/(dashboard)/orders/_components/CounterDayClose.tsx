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
  dayCloseZSections,
  roundMoney,
  sumDenominations,
  validOpeningFloat,
} from "@routeflow/pricing";
import type { DayCloseSnapshot, DayCloseState } from "@routeflow/types";
import { Button, Input, Modal, TAP_TARGET, Textarea, cn } from "@routeflow/ui/web";
import {
  Z_REPORT_EMAILED_COPY,
  Z_REPORT_RESEND_FAILED_COPY,
  Z_REPORT_WILL_EMAIL_COPY,
  DAY_OFFLINE_COPY,
  DAY_REOPEN_FAILED_COPY,
  DAY_REOPENED_CLOSE_AGAIN_COPY,
  dayCloseErrorCopy,
  isDayAlreadyClosed,
  useCloseCounterDay,
  useCounterDayClose,
  useReopenCounterDay,
  useResendZReport,
} from "@/lib/api/counter-day-close";
import { useOptionalAuth } from "@/lib/auth-context";
import { useTenant } from "@/components/tenant-provider";
import {
  clearDayCloseDraft,
  dayCloseDraftKey,
  readDayCloseDraft,
  writeDayCloseDraft,
} from "@/lib/counter-day-close-draft";
import { formatReceiptMoney as money } from "@/lib/counter-receipt";
import { ZReportView, verdictText, zHeadlineText, zTime } from "./ZReportView";

const FORM_ID = "counter-day-close-form";
const ROW_KEY = (d: { kind: string; value: number }) => `${d.kind}:${d.value}`;
const STEP =
  "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border text-lg";
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

/** Balanced / Short / Over, in words AND colour (never colour alone); the wording is the Z view's own (`verdictText`). */
function varianceView(variance: number): { text: string; tone: string } {
  if (variance === 0) return { text: verdictText("even", 0), tone: "text-green-700" };
  if (variance > 0) return { text: verdictText("over", variance), tone: "text-amber-700" };
  return { text: verdictText("short", Math.abs(variance)), tone: "text-red-700" };
}

/** The browser's own online flag, kept live: false = the close cannot reach the server and the button says so. */
function useOnline(): boolean {
  const [online, setOnline] = React.useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
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
  editing,
  onClose,
  onViewZ,
}: {
  state: DayCloseState;
  open: boolean;
  /** Edit count: the closed day being corrected (reopen, then close again over the same window). Null = a plain close. */
  editing: DayCloseSnapshot | null;
  onClose: () => void;
  onViewZ: () => Promise<void>;
}) {
  // R7b 2.3: the typed count is a form draft (sessionStorage), keyed tenant + register + tenant day
  const tenant = useTenant().slug;
  const draftKey = dayCloseDraftKey(tenant, state.registerKey, dayIn(new Date(), state.zone));
  // the body reports whether it holds a typed count; a dirty dismissal asks Keep or Discard first
  const dirtyRef = React.useRef(false);
  const [confirming, setConfirming] = React.useState(false);
  const requestClose = () => {
    if (dirtyRef.current) setConfirming(true);
    else onClose();
  };
  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title={editing ? "Edit count" : "Close day"}
        description={
          editing
            ? "Sales times stay the same. A corrected Z report is emailed."
            : "Count the drawer. The totals are checked again when you close."
        }
        scroll
        closeClassName={TAP_TARGET}
        className={cn(
          "left-0 top-0 h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none p-4",
          "sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:p-6",
        )}
      >
        {open ? (
          <DayCloseFormBody
            state={state}
            editing={editing}
            draftKey={draftKey}
            dirtyRef={dirtyRef}
            onClose={onClose}
            onRequestClose={requestClose}
            onViewZ={onViewZ}
          />
        ) : null}
      </Modal>
      <Modal
        open={open && confirming}
        onClose={() => setConfirming(false)}
        title="Keep your count for later?"
        description="Your typed count stays on this device until you close the day."
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-h-[44px]"
              onClick={() => {
                clearDayCloseDraft(draftKey);
                dirtyRef.current = false;
                setConfirming(false);
                onClose();
              }}
            >
              Discard
            </Button>
            <Button
              type="button"
              autoFocus
              className="min-h-[44px]"
              onClick={() => {
                setConfirming(false);
                onClose();
              }}
            >
              Keep
            </Button>
          </div>
        }
      >
        <p className="text-sm">Keep opens it again where you left off. Discard clears it.</p>
      </Modal>
    </>
  );
}

// The fields and the pinned submit row share one form state, so they are one component; the Modal only frames them.
function DayCloseFormBody({
  state,
  editing,
  draftKey,
  dirtyRef,
  onClose,
  onRequestClose,
  onViewZ,
}: {
  state: DayCloseState;
  editing: DayCloseSnapshot | null;
  draftKey: string;
  /** set here each render: true while a typed count would be lost by closing */
  dirtyRef: React.MutableRefObject<boolean>;
  /** leaves the form now (a successful close) */
  onClose: () => void;
  /** a dismissal (Cancel): the parent asks Keep or Discard first when the form is dirty */
  onRequestClose: () => void;
  onViewZ: () => Promise<void>;
}) {
  const { preview, lastClose } = state;
  // A reopened (or being-edited) close is re-closed over its STORED window: start from what was stored. Taken once, at open:
  // the Edit count reopen refetches the state under this form, and the counts typed so far must survive that.
  const [seed] = React.useState<DayCloseSnapshot | null>(
    () => editing ?? (lastClose?.reopenedAt ? lastClose : null),
  );
  // R7b 2.3: a kept draft of this tenant + register + day is the starting state when there is no stored close to continue
  const [draft] = React.useState(() => (seed ? null : readDayCloseDraft(draftKey)));
  const suggestedFloat = preview.suggestedOpeningFloat.toFixed(2);
  const [floatText, setFloatText] = React.useState(() =>
    seed ? seed.openingFloat.toFixed(2) : (draft?.floatText ?? suggestedFloat),
  );
  const [counts, setCounts] = React.useState<Record<string, number>>(() => {
    const init: Record<string, number> = { ...(draft?.counts ?? {}) };
    for (const d of seed?.denominations ?? []) init[ROW_KEY(d)] = d.count;
    return init;
  });
  const [notes, setNotes] = React.useState(seed?.notes ?? draft?.notes ?? "");
  const closeMutation = useCloseCounterDay();
  const reopenMutation = useReopenCounterDay();
  const [pending, setPending] = React.useState(false);
  const didReopen = React.useRef(false);
  const inFlight = React.useRef(false);
  const online = useOnline();
  const [error, setError] = React.useState<{ text: string; elsewhere: boolean } | null>(null);
  const [viewing, setViewing] = React.useState(false);

  const rows = DAY_CLOSE_DENOMINATIONS.map((d) => ({ ...d, count: counts[ROW_KEY(d)] ?? 0 }));
  const openingFloat = parseFloatInput(floatText);
  const counted = sumDenominations(rows);
  // Edit count: the preview describes the window AFTER this close, so the stored close's own figures stand in until the reopen
  // moves the preview onto the stored window. The float is locked, so the stored expected cash stays right.
  const expected = editing
    ? editing.expectedCash
    : openingFloat === null
      ? null
      : roundMoney(openingFloat + preview.tillCash - preview.cashRefunds);
  const variance = expected === null ? null : roundMoney(counted - expected);
  const view = variance === null ? null : varianceView(variance);
  const shownTotals = editing ? editing.totals : preview.totals;
  const refunds = shownTotals.refunds;
  const setCount = (key: string, n: number) =>
    setCounts((c) => ({ ...c, [key]: Math.min(DAY_CLOSE_MAX_COUNT, Math.max(0, n)) }));
  const canSubmit = openingFloat !== null && !pending && online;

  // R7b 2.3: the draft follows the typed state (debounced 300 ms) and is flushed when the form unmounts (Today's sales
  // closing included). A seeded form (a reopened or edited close) keeps no draft.
  const dirty =
    !seed &&
    (floatText !== suggestedFloat ||
      Object.values(counts).some((n) => n > 0) ||
      notes.trim() !== "");
  dirtyRef.current = dirty;
  const latest = React.useRef({ floatText, counts, notes });
  latest.current = { floatText, counts, notes };
  const persist = React.useCallback(() => {
    if (dirtyRef.current) writeDayCloseDraft(draftKey, latest.current);
    else clearDayCloseDraft(draftKey);
  }, [dirtyRef, draftKey]);
  React.useEffect(() => {
    const t = window.setTimeout(persist, 300);
    return () => window.clearTimeout(t);
  }, [floatText, counts, notes, persist]);
  // unmount: keep what is typed (Discard and a successful close set dirtyRef false first, so they write nothing)
  React.useEffect(
    () => () => {
      if (dirtyRef.current) writeDayCloseDraft(draftKey, latest.current);
    },
    [dirtyRef, draftKey],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (openingFloat === null || inFlight.current || !online) return;
    inFlight.current = true;
    setError(null);
    setPending(true);
    const trimmed = notes.trim();
    // Edit count = reopen, then close again over the stored window. A retry after a half-done save skips the reopen.
    const mustReopen = editing != null && !didReopen.current && !lastClose?.reopenedAt;
    if (mustReopen && editing) {
      try {
        await reopenMutation.mutateAsync(editing.id);
        didReopen.current = true;
      } catch {
        setError({ text: DAY_REOPEN_FAILED_COPY, elsewhere: false });
        inFlight.current = false;
        setPending(false);
        return;
      }
    }
    try {
      await closeMutation.mutateAsync({
        openingFloat,
        denominations: rows
          .filter((r) => r.count > 0)
          .map((r) => ({ kind: r.kind, value: r.value, count: r.count })),
        ...(trimmed ? { notes: trimmed } : {}),
      });
      inFlight.current = false;
      setPending(false);
      // the server has the count now: the draft is spent
      clearDayCloseDraft(draftKey);
      dirtyRef.current = false;
      onClose();
    } catch (err) {
      inFlight.current = false;
      setPending(false);
      // the reopen already went through: say so, keep the counts, and leave the form open to close again
      setError(
        didReopen.current
          ? { text: DAY_REOPENED_CLOSE_AGAIN_COPY, elsewhere: false }
          : { text: dayCloseErrorCopy(err), elsewhere: isDayAlreadyClosed(err) },
      );
    }
  };

  return (
    <form
      id={FORM_ID}
      onSubmit={(e) => void submit(e)}
      className="space-y-4"
      data-testid="day-close-form"
    >
      {seed && !editing ? (
        <p role="status" className="rounded border bg-navy/5 p-2 text-sm">
          This day was reopened. Count the drawer again to close it.
        </p>
      ) : null}
      {/* the Variance is the hero: sticky under the title so a phone keeps it in view while the counts scroll; neutral until
          the first count entry (a drawer with nothing counted yet is not "short") */}
      <div
        className="sticky top-0 z-10 -mx-1 border-b bg-white px-1 pb-2"
        data-testid="day-close-variance-hero"
      >
        <p className="text-xs text-navy/70">Variance</p>
        <p
          className={cn(
            "text-2xl font-semibold tabular-nums",
            counted > 0 ? view?.tone : "text-navy",
          )}
          data-testid="close-variance"
        >
          {/* nothing counted yet: a plain prompt, never "Short $130.00" for a drawer nobody has counted */}
          {counted > 0 ? (view ? view.text : "—") : "Not counted yet"}
        </p>
      </div>
      <dl
        className="space-y-1 rounded border bg-navy/5 p-3 text-sm"
        aria-label="Drawer figures"
        data-testid="day-close-figures"
      >
        <Figure label="Counted" value={money(counted)} testId="close-counted" />
        <Figure
          label="Expected cash"
          value={expected === null ? "—" : money(expected)}
          testId="close-expected"
        />
        <p className="pt-1 text-xs text-navy/70" data-testid="close-not-at-till">
          Unpaid pickups: {money(shownTotals.notAtTill)}
        </p>
        {refunds.tenderKnown === false ? (
          <p className="text-xs text-navy/70" data-testid="close-tender-note">
            Some refunds have no recorded tender and are not subtracted
          </p>
        ) : null}
      </dl>

      <Input
        label={seed ? "Opening float (kept from the first close)" : "Opening float"}
        inputMode="decimal"
        autoComplete="off"
        className="h-11"
        value={floatText}
        readOnly={seed != null}
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
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-700">
            <p>{error.text}</p>
            {error.elsewhere ? (
              <Button
                type="button"
                variant="secondary"
                className="min-h-[44px]"
                loading={viewing}
                onClick={() => {
                  setViewing(true);
                  void onViewZ().finally(() => setViewing(false));
                }}
              >
                View Z report
              </Button>
            ) : null}
          </div>
        ) : null}
        {online ? null : (
          <p role="status" className="text-sm text-amber-700" data-testid="day-close-offline">
            {DAY_OFFLINE_COPY}
          </p>
        )}
        {editing ? null : (
          <p className="text-xs text-navy/70" data-testid="day-close-email-note">
            {Z_REPORT_WILL_EMAIL_COPY}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            className="min-h-[44px]"
            onClick={onRequestClose}
          >
            Cancel
          </Button>
          <Button type="submit" className="min-h-[44px]" disabled={!canSubmit} loading={pending}>
            {editing ? "Save count" : "Close day"}
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
  canEdit,
  onViewZ,
  onEdit,
}: {
  close: DayCloseSnapshot;
  zone: string;
  salesSince: number;
  canEdit: boolean;
  onViewZ: () => void;
  onEdit: () => void;
}) {
  const resend = useResendZReport();
  const [failure, setFailure] = React.useState<string | null>(null);
  const v = varianceView(close.variance);
  const head = zHeadlineText(dayCloseZSections(close).headline);
  return (
    <div className="space-y-2 rounded border bg-navy/5 p-3 text-sm" data-testid="day-close-closed">
      <p className="font-semibold" data-testid="closed-headline">
        Closed {zTime(close.closedAt, zone)}
        {close.closedByName ? ` by ${close.closedByName}` : ""} · {head.verdict}
      </p>
      <p className="text-xs text-navy/70" data-testid="closed-sales-since">
        {salesSince === 1 ? "1 sale since" : `${salesSince} sales since`}
      </p>
      <dl className="space-y-1">
        <Figure label="Opening float" value={money(close.openingFloat)} testId="closed-float" />
        <Figure label="Expected cash" value={money(close.expectedCash)} testId="closed-expected" />
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
          <span aria-hidden="true">·</span>
          <Button
            type="button"
            variant="secondary"
            className="min-h-[44px]"
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
        <p className="text-xs text-navy/70">{Z_REPORT_EMAILED_COPY}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" className="min-h-[44px]" onClick={onViewZ}>
          View Z report
        </Button>
        {canEdit ? (
          <Button type="button" variant="secondary" className="min-h-[44px]" onClick={onEdit}>
            Edit count
          </Button>
        ) : null}
      </div>
      {failure ? (
        <p role="alert" className="text-sm text-red-700">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

export function CounterDayClose() {
  const q = useCounterDayClose(true);
  const role = useOptionalAuth()?.user?.role;
  const [formOpen, setFormOpen] = React.useState(false);
  // the closed day being corrected (Edit count), or null for a plain close / re-close
  const [editing, setEditing] = React.useState<DayCloseSnapshot | null>(null);
  const [zOpen, setZOpen] = React.useState(false);
  const openerRef = React.useRef<HTMLButtonElement>(null);
  const { refetch } = q;
  const openForm = React.useCallback(() => {
    // a fresh preview for the figures: the window ends "now"
    void refetch();
    setEditing(null);
    setFormOpen(true);
  }, [refetch]);
  // Closed on another device: load that close through the state refetch, then show its Z report.
  const viewZAfterRefetch = React.useCallback(async () => {
    const r = await refetch();
    const lc = r.data?.lastClose;
    if (lc && !lc.reopenedAt) {
      setFormOpen(false);
      setZOpen(true);
    }
  }, [refetch]);

  if (q.isError && !q.data) {
    return (
      <div role="alert" className="space-y-2 text-sm" data-testid="day-close-error">
        <p>Could not load the day close.</p>
        <Button className="min-h-[44px]" variant="secondary" onClick={() => void refetch()}>
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
          canEdit={role !== undefined && REOPEN_ROLES.has(role)}
          onViewZ={() => setZOpen(true)}
          onEdit={() => {
            setEditing(closed);
            setFormOpen(true);
          }}
        />
      ) : null}
      {reopened ? (
        <p role="status" className="rounded border bg-navy/5 p-2 text-sm">
          This day was reopened. Close it again to finish.
        </p>
      ) : null}
      {closed && !offerClose ? (
        <p className="text-sm text-navy/70" data-testid="day-close-nothing-new">
          Already closed. Nothing new since {zTime(closed.closedAt, state.zone)}.
        </p>
      ) : null}
      {offerClose ? (
        <Button
          ref={openerRef}
          variant="secondary"
          className="min-h-[44px] w-full sm:w-auto"
          onClick={openForm}
        >
          {closed ? "Close again" : "Close day"}
        </Button>
      ) : null}
      <DayCloseForm
        state={state}
        open={formOpen}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onViewZ={viewZAfterRefetch}
      />
      {closed ? (
        <ZReportView snapshot={closed} open={zOpen} onClose={() => setZOpen(false)} />
      ) : null}
    </section>
  );
}
