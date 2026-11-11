"use client";

// W-1188: the date chip's picker. Quick picks, a typed date with a live echo, and a month calendar. Days outside the
// till's range are disabled. Apply with Enter or a click; Esc closes and keeps the old value. Pure UI: the chip owns state.
import * as React from "react";
import { addDays, orderDateRange } from "@routeflow/pricing";
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
}

export function CounterDatePicker({ open, today, value, onApply, onClose }: Props) {
  const range = orderDateRange(today, "COUNTER");
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
  const onGridKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === "ArrowLeft") move(-1);
    else if (k === "ArrowRight") move(1);
    else if (k === "ArrowUp") move(-7);
    else if (k === "ArrowDown") move(7);
    else if (k === "t" || k === "T") apply(today);
    else if (k === "y" || k === "Y") apply(addDays(today, -1));
    else if (k === "Enter") apply(cursor);
    else return;
    e.preventDefault();
  };

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
                  ? "That day is outside the dates this till takes."
                  : `${weekdayShort(typed)}, ${longDay(typed)} · ${relativeDaysLabel(typed, today)}${typed > today ? " (future)" : ""}`}
          </p>
        </div>
        <div
          role="group"
          tabIndex={0}
          aria-label="Calendar"
          onKeyDown={onGridKey}
          className="rounded-md border border-navy/15 p-2 outline-none focus-visible:ring-2 focus-visible:ring-navy/40"
        >
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
            <span className="text-sm font-semibold">
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
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-navy/60">
            {HEAD.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {cells.map((day, i) =>
              day === null ? (
                <span key={`b${i}`} />
              ) : (
                <button
                  key={day}
                  type="button"
                  tabIndex={-1}
                  disabled={!inRange(day)}
                  aria-label={dayLabel(day, today)}
                  aria-pressed={day === (value || today)}
                  data-day={day}
                  onClick={() => apply(day)}
                  className={cn(
                    "min-h-[44px] rounded-md text-sm tabular-nums disabled:text-navy/25",
                    day === cursor && "ring-2 ring-navy/50",
                    day === today && "font-bold",
                    day === (value || today) && "bg-navy text-white",
                  )}
                >
                  {Number(day.slice(8))}
                </button>
              ),
            )}
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
