"use client";

// SA-750r3 §4: the on-screen Z report. The groups and rows come ONLY from `dayCloseZSections` (the one definition the Z email
// also prints from); this file formats money and writes the date / closer / window lines, and re-derives nothing.
import * as React from "react";
import { dayCloseZSections } from "@routeflow/pricing";
import type { ZRow } from "@routeflow/pricing";
import type { DayCloseSnapshot } from "@routeflow/types";
import { Modal, cn } from "@routeflow/ui/web";
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

/** "Thu, Oct 9" from the close's own date label ("YYYY-MM-DD"), read as a calendar date so no zone can shift it. */
function zTitleDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** "8:05 AM – 9:42 PM"; a window that crosses midnight shows the weekday on both ends. */
export function zWindowLine(startIso: string, endIso: string, zone: string): string {
  const crosses = zDate(startIso, zone) !== zDate(endIso, zone);
  const end = (iso: string) =>
    crosses ? `${zWeekday(iso, zone)} ${zTime(iso, zone)}` : zTime(iso, zone);
  return `${end(startIso)} – ${end(endIso)}`;
}

/** "Counted $412.50 · Short $2.50", "Even $0.00" or "Over $1.00": the one headline, on the card and in the Z view. */
export function zHeadlineText(h: ReturnType<typeof dayCloseZSections>["headline"]): {
  counted: string;
  verdict: string;
} {
  const word = h.verdict === "short" ? "Short" : h.verdict === "over" ? "Over" : "Even";
  return { counted: `Counted ${money(h.counted)}`, verdict: `${word} ${money(h.amount)}` };
}

function rowValue(row: ZRow): string {
  if (row.amount === null) return NOT_RECORDED;
  if (row.signed && row.amount > 0) return `+${money(row.amount)}`;
  return money(row.amount);
}

const plural = (n: number) => (n === 1 ? "1 hand-over" : `${n} hand-overs`);

/** The Z report body. `snapshot` is the stored close: nothing here is recomputed from sales. */
export function ZReportBody({ snapshot }: { snapshot: DayCloseSnapshot }) {
  const z = dayCloseZSections(snapshot);
  const head = zHeadlineText(z.headline);
  const note = snapshot.notes?.trim();
  return (
    <div className="space-y-4 text-sm text-navy" data-testid="z-report">
      <div className="space-y-0.5" data-testid="z-report-meta">
        <p data-testid="z-closed-line">
          Closed {zTime(snapshot.closedAt, snapshot.zone)}
          {snapshot.closedByName ? ` by ${snapshot.closedByName}` : ""}
        </p>
        <p className="text-navy/70" data-testid="z-window-line">
          {zWindowLine(snapshot.windowStart, snapshot.windowEnd, snapshot.zone)}
        </p>
      </div>

      <p className="text-base font-bold" data-testid="z-headline">
        {head.counted} · {head.verdict}
      </p>

      {z.groups.map((g) => (
        <section key={g.heading} aria-label={g.heading} data-testid={`z-group-${g.heading}`}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-navy/70">
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
                  {rowValue(r)}
                  {r.count !== undefined ? (
                    <span className="ml-1 text-xs font-normal text-navy/70">
                      · {plural(r.count)}
                    </span>
                  ) : null}
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

/** The Z report as a full-screen sheet on a phone and a centred dialog from `sm` up. */
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
      title={`Z report · ${zTitleDate(snapshot.day)}`}
      scroll
      closeClassName="min-h-11 min-w-11 flex items-center justify-center"
      className={cn(
        "left-0 top-0 h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none p-4",
        "sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:p-6",
      )}
    >
      {open ? <ZReportBody snapshot={snapshot} /> : null}
    </Modal>
  );
}
