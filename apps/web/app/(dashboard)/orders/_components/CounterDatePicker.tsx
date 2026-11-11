"use client";

// W-1188: the date chip's picker. Quick picks, a typed date with a live echo, and a month calendar. Days outside the
// till's range are disabled. Apply with Enter or a click; Esc closes and keeps the old value. Pure UI: the chip owns state.
import * as React from "react";
import { addDays, orderDateRange, type OrderDatePolicy } from "@routeflow/pricing";
import { Button, Modal, cn } from "@routeflow/ui/web";
import {
  dayLabel,
  longDay,
  parseNaturalDate,
  relativeDaysLabel,
  weekdayShort,
} from "@/lib/natural-date";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]; // prettier-ignore
const HEAD = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const ym = (day: string) => day.slice(0, 7);
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

interface Props {
  open: boolean;
  today: string;
  /** "" = Today */
  value: string;
  onApply: (day: string) => void;
  onClose: () => void;
  /** COUNTER takes future days; OFFICE (the regular order) is past-only: a future day is the delivery date. */
  policy?: OrderDatePolicy;
}

export const OFFICE_FUTURE_HINT = "A future day? Set the delivery date instead.";

export function CounterDatePicker({
  open,
  today,
  value,
  onApply,
  onClose,
  policy = "COUNTER",
}: Props) {
  const range = orderDateRange(today, policy);
  const [text, setText] = React.useState("");
  const [cursor, setCursor] = React.useState(value || today);
  React.useEffect(() => {
    if (open) {
      setText("");
      setCursor(value || today);
    }
  }, [open, value, today]);

  const inRange = (d: string) => d >= range.min && d <= range.max;
  const typed = text.trim() ? parseNaturalDate(text, today, { allowFuture: true }) : null;
  const typedOk = typed !== null && inRange(typed);
  const apply = (day: string) => {
    if (inRange(day)) onApply(day);
  };

  const month = ym(cursor);
  const first = `${month}-01`;
  const lead = new Date(`${first}T00:00:00Z`).getUTCDay();
  const cells: Array<string | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  const [cy, cm] = month.split("-").map(Number);
  const length = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
  for (let d = 1; d <= length; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);

  const move = (by: number) => {
    const next = addDays(cursor, by);
    if (inRange(next)) setCursor(next);
  };
  const moveMonth = (by: number) => {
    const target = shiftMonth(month, by);
    const [ty, tm] = target.split("-").map(Number);
    const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    const next = `${target}-${String(Math.min(Number(cursor.slice(8)), last)).padStart(2, "0")}`;
    if (inRange(next)) setCursor(next);
  };
  const weekdayOfCursor = new Date(`${cursor}T00:00:00Z`).getUTCDay();
  // Only keys typed ON the grid act here: Enter on a month button pages, and letters never set a date (a barcode
  // scanner types letters then Enter; the quick picks and the typed field are the ways to say "today" or "yesterday").
  const onGridKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === "ArrowLeft") move(-1);
    else if (k === "ArrowRight") move(1);
    else if (k === "ArrowUp") move(-7);
    else if (k === "ArrowDown") move(7);
    else if (k === "PageUp") moveMonth(-1);
    else if (k === "PageDown") moveMonth(1);
    else if (k === "Home") move(-weekdayOfCursor);
    else if (k === "End") move(6 - weekdayOfCursor);
    else if (k === "Enter") apply(cursor);
    else return;
    e.preventDefault();
  };
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) {
    const row = cells.slice(i, i + 7);
    while (row.length < 7) row.push(null);
    weeks.push(row);
  }
  const cellId = (day: string) => `counter-date-${day}`;

  const quick = [today, addDays(today, -1), ...[2, 3, 4, 5, 6].map((n) => addDays(today, -n))];
  const quickLabel = (d: string) =>
    d === today
      ? "Today"
      : d === addDays(today, -1)
        ? "Yesterday"
        : `${weekdayShort(d)} ${Number(d.slice(8))}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Order date"
      className="max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none"
    >
      <div className="flex flex-col gap-3" data-testid="counter-date-picker">
        <div className="flex flex-wrap gap-2">
          {quick.map((d) => (
            <Button
              key={d}
              type="button"
              variant="secondary"
              className="min-h-[44px]"
              onClick={() => apply(d)}
            >
              {quickLabel(d)}
            </Button>
          ))}
        </div>
        <div className="space-y-1">
          <input
            autoFocus
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (typedOk && typed) apply(typed);
              }
            }}
            placeholder='Type "yesterday", "fri" or "11/02"'
            aria-label="Type a date"
            className="min-h-[44px] w-full rounded-md border border-navy/20 px-3 text-sm"
            data-testid="counter-date-input"
          />
          <p
            className="min-h-5 text-xs text-navy/70"
            aria-live="polite"
            data-testid="counter-date-echo"
          >
            {!text.trim()
              ? ""
              : typed === null
                ? 'Try "yesterday", "fri" or "11/02"'
                : !typedOk
                  ? policy === "OFFICE" && typed > today
                    ? OFFICE_FUTURE_HINT
                    : "That day is outside the dates this till takes."
                  : `${weekdayShort(typed)}, ${longDay(typed)} · ${relativeDaysLabel(typed, today)}${typed > today ? " (future)" : ""}`}
          </p>
        </div>
        {policy === "OFFICE" ? (
          <p className="text-xs text-navy/70" data-testid="counter-date-office-hint">
            {OFFICE_FUTURE_HINT}
          </p>
        ) : null}
        <div className="rounded-md border border-navy/15 p-2">
          <div className="mb-1 flex items-center justify-between">
            <Button
              type="button"
              variant="secondary"
              aria-label="Previous month"
              className="min-h-[44px]"
              disabled={shiftMonth(month, -1) < ym(range.min)}
              onClick={() => setCursor(`${shiftMonth(month, -1)}-01`)}
            >
              ‹
            </Button>
            <span className="text-sm font-semibold" aria-live="polite">
              {MONTHS[Number(month.slice(5)) - 1]} {month.slice(0, 4)}
            </span>
            <Button
              type="button"
              variant="secondary"
              aria-label="Next month"
              className="min-h-[44px]"
              disabled={shiftMonth(month, 1) > ym(range.max)}
              onClick={() => setCursor(`${shiftMonth(month, 1)}-01`)}
            >
              ›
            </Button>
          </div>
          <div
            role="grid"
            tabIndex={0}
            aria-label="Calendar"
            aria-activedescendant={cellId(cursor)}
            onKeyDown={onGridKey}
            className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-navy/40"
          >
            <div role="row" className="grid grid-cols-7 gap-1 text-center text-xs text-navy/60">
              {HEAD.map((h) => (
                <span key={h} role="columnheader">
                  {h}
                </span>
              ))}
            </div>
            {weeks.map((week, w) => (
              <div key={w} role="row" className="mt-1 grid grid-cols-7 gap-1">
                {week.map((day, i) =>
                  day === null ? (
                    <span key={`b${i}`} role="gridcell" aria-hidden />
                  ) : (
                    <div
                      key={day}
                      role="gridcell"
                      aria-selected={day === (value || today)}
                      aria-disabled={!inRange(day) || undefined}
                    >
                      <button
                        id={cellId(day)}
                        type="button"
                        tabIndex={-1}
                        disabled={!inRange(day)}
                        aria-label={dayLabel(day, today)}
                        aria-current={day === today ? "date" : undefined}
                        data-day={day}
                        onClick={() => apply(day)}
                        className={cn(
                          "min-h-[44px] w-full rounded-md text-sm tabular-nums disabled:text-navy/25",
                          day === cursor && "ring-2 ring-navy/50",
                          day === today && "font-bold",
                          day === (value || today) && "bg-navy text-white",
                        )}
                      >
                        {Number(day.slice(8))}
                      </button>
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" className="min-h-[44px]" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-[44px]"
            disabled={text.trim() ? !typedOk : false}
            onClick={() => apply(text.trim() && typed ? typed : cursor)}
          >
            Apply
          </Button>
        </div>
      </div>
    </Modal>
  );
}
