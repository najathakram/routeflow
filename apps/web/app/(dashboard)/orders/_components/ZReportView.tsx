"use client";

// SA-750r3 §4: the on-screen Z report. The groups and rows come ONLY from `dayCloseZSections` (the one definition the Z email
// also prints from); this file formats money and writes the date / closer / window lines, and re-derives nothing.
import * as React from "react";
import { dayCloseDateLabel, dayCloseZSections } from "@routeflow/pricing";
import type { ZRow } from "@routeflow/pricing";
import type { DayCloseSnapshot } from "@routeflow/types";
import { Button, Modal, cn } from "@routeflow/ui/web";
import { Z_REPORT_RESEND_FAILED_COPY, useResendZReport } from "@/lib/api/counter-day-close";
import { formatReceiptMoney as money } from "@/lib/counter-receipt";

const NOT_RECORDED = "Not recorded";

/** "9:42 PM" in the tenant zone (no zone name: the Z lines are already in the tenant's own clock). */
export const zTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(iso),
  );
const zWeekday = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date(iso));
const zDate = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(new Date(iso));

/** "8:05 AM – 9:42 PM"; a window that crosses midnight shows the weekday on both ends. */
export function zWindowLine(startIso: string, endIso: string, zone: string): string {
  const crosses = zDate(startIso, zone) !== zDate(endIso, zone);
  const end = (iso: string) =>
    crosses ? `${zWeekday(iso, zone)} ${zTime(iso, zone)}` : zTime(iso, zone);
  return `${end(startIso)} – ${end(endIso)}`;
}

type Verdict = ReturnType<typeof dayCloseZSections>["headline"]["verdict"];
const VERDICT_WORD: Record<Verdict, string> = { short: "Short", over: "Over", even: "Even" };

/** "Short $2.50", "Over $1.00" or "Even $0.00": the ONE variance wording, on the count form, the closed card and the Z view. */
export function verdictText(verdict: Verdict, amount: number): string {
  return `${VERDICT_WORD[verdict]} ${money(amount)}`;
}

/** "Counted $412.50 · Short $2.50", "Even $0.00" or "Over $1.00": the one headline, on the card and in the Z view. */
export function zHeadlineText(h: ReturnType<typeof dayCloseZSections>["headline"]): {
  counted: string;
  verdict: string;
} {
  return { counted: `Counted ${money(h.counted)}`, verdict: verdictText(h.verdict, h.amount) };
}

function rowValue(row: ZRow): string {
  if (row.amount === null) return NOT_RECORDED;
  if (row.signed && row.amount > 0) return `+${money(row.amount)}`;
  return money(row.amount);
}

const plural = (n: number) => (n === 1 ? "1 hand-over" : `${n} hand-overs`);

/** The body class that, under `@media print`, hides every other portal so the page prints only the Z report (app/shell.css). */
const PRINT_BODY_CLASS = "z-report-open";
/** Marks the Z modal's own portal root, the one thing that stays when the body class above is set. */
const PRINT_ROOT_CLASS = "z-report-print-root";

/** The Z report body. `snapshot` is the stored close: nothing here is recomputed from sales. */
export function ZReportBody({ snapshot }: { snapshot: DayCloseSnapshot }) {
  const z = dayCloseZSections(snapshot);
  const head = zHeadlineText(z.headline);
  const note = snapshot.notes?.trim();
  return (
    <div className="space-y-4 text-sm text-navy print:text-black" data-testid="z-report">
      <div className="space-y-0.5" data-testid="z-report-meta">
        <p data-testid="z-closed-line">
          Closed {zTime(snapshot.closedAt, snapshot.zone)}
          {snapshot.closedByName ? ` by ${snapshot.closedByName}` : ""}
        </p>
        <p className="text-navy/70 print:text-black" data-testid="z-window-line">
          {zWindowLine(snapshot.windowStart, snapshot.windowEnd, snapshot.zone)}
        </p>
      </div>

      <p className="text-base font-bold" data-testid="z-headline">
        {head.counted} · {head.verdict}
      </p>

      {z.groups.map((g) => (
        <section key={g.heading} aria-label={g.heading} data-testid={`z-group-${g.heading}`}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-navy/70 print:text-black">
            {g.heading}
          </h3>
          <dl className="space-y-1">
            {g.rows.map((r) => (
              <div
                key={r.label}
                className={cn("flex justify-between gap-2", r.bold && "font-bold")}
                data-testid={`z-row-${r.label}`}
              >
                <dt>{r.label}</dt>
                <dd className="text-right tabular-nums">
                  {r.count !== undefined && r.amount !== null ? (
                    <>
                      <span className="text-xs font-normal text-navy/70 print:text-black">
                        {plural(r.count)} ·
                      </span>{" "}
                    </>
                  ) : null}
                  {rowValue(r)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <div className="space-y-1">
        <p data-testid="z-not-at-till">Not taken at the till: {money(z.notTakenAtTill)}</p>
        {z.refundsTenderKnown ? null : (
          <p className="text-amber-700" data-testid="z-tender-warning">
            Some refunds have no method. Cash in drawer may be high.
          </p>
        )}
      </div>

      {note ? (
        <p className="whitespace-pre-wrap" data-testid="z-note">
          <span className="font-semibold">Note: </span>
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Back to sales, Resend, Print (primary, trailing): the Z view's own actions (SA-750r3 §3), pinned at the top of the sheet so a phone never scrolls
 * to reach them. Resend is always offered (it re-sends the stored report); its outcome is a fixed line, never the server's text.
 */
function ZReportContent({
  snapshot,
  onClose,
}: {
  snapshot: DayCloseSnapshot;
  onClose: () => void;
}) {
  const resend = useResendZReport();
  const [outcome, setOutcome] = React.useState<"sent" | "failed" | null>(null);
  // While the report is on screen the page prints ONLY it: app/shell.css hides every other portal under `@media print`.
  React.useEffect(() => {
    document.body.classList.add(PRINT_BODY_CLASS);
    return () => document.body.classList.remove(PRINT_BODY_CLASS);
  }, []);
  const onResend = () => {
    setOutcome(null);
    resend.mutate(snapshot.id, {
      onSuccess: (data) => {
        const sent = (data as { reportSent?: unknown } | null | undefined)?.reportSent;
        setOutcome(sent === true ? "sent" : sent === false ? "failed" : null);
      },
      onError: () => setOutcome("failed"),
    });
  };
  return (
    <div className="space-y-4">
      <div
        className="sticky top-0 z-10 -mx-1 flex flex-wrap justify-end gap-2 bg-white px-1 pb-2 print:hidden"
        data-testid="z-actions"
      >
        {/* The primary action trails, like every other dialog's footer: quiet actions first, Print last. */}
        <Button type="button" variant="secondary" className="min-h-11" onClick={onClose}>
          Back to sales
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="min-h-11"
          loading={resend.isPending}
          onClick={onResend}
        >
          Resend
        </Button>
        <Button type="button" className="min-h-11" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      {outcome === "sent" ? (
        <p
          role="status"
          className="text-sm text-navy/70 print:hidden"
          data-testid="z-resend-status"
        >
          Z report emailed to admins
        </p>
      ) : null}
      {outcome === "failed" ? (
        <p role="alert" className="text-sm text-red-700 print:hidden">
          {Z_REPORT_RESEND_FAILED_COPY}
        </p>
      ) : null}
      <ZReportBody snapshot={snapshot} />
    </div>
  );
}

/**
 * The Z report as a full-screen sheet on a phone and a centred dialog from `sm` up. It is a Modal over the Today's-sales sheet:
 * Radix keeps one dismissable-layer stack, so Escape closes this view first and the sheet behind it only on the next press.
 */
export function ZReportView({
  snapshot,
  open,
  onClose,
}: {
  snapshot: DayCloseSnapshot;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Z report · ${dayCloseDateLabel(snapshot.day)}`}
      scroll
      closeClassName="min-h-11 min-w-11 flex items-center justify-center"
      className={cn(
        PRINT_ROOT_CLASS,
        "left-0 top-0 h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none p-4",
        "sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:p-6",
        // printing: a plain flowing page, not a fixed full-height sheet; the title stays, the X goes
        "print:static print:left-auto print:top-auto print:h-auto print:max-h-none print:w-full print:max-w-none print:translate-x-0 print:translate-y-0 print:overflow-visible print:rounded-none print:p-0 print:shadow-none print:[&_[aria-label=Close]]:hidden",
      )}
    >
      {open ? <ZReportContent snapshot={snapshot} onClose={onClose} /> : null}
    </Modal>
  );
}
