"use client";

// W-1188: the counter's order date chip, in the till header beside "Parked". "Today" until the clerk picks another day;
// then amber (past) or indigo with a dashed border (future), with a clear (x) that returns to Today in one tap. Colour is
// never the only signal: the text says "Dated" and "future", the icon differs. Alt+D opens the picker from anywhere on
// the till. The chip never sends Today: an empty value means "no orderDate in the sale".
import * as React from "react";
import { CalendarArrowUp, Calendar as CalendarIcon, History, X } from "lucide-react";
import type { OrderDatePolicy } from "@routeflow/pricing";
import { cn } from "@routeflow/ui/web";
import { dayLabel, fullDayName } from "@/lib/natural-date";
import { CounterDatePicker } from "./CounterDatePicker";

interface Props {
  /** the chosen day (YYYY-MM-DD) or "" for Today */
  value: string;
  /** the business's today; undefined while its zone loads (the chip then stays on Today and does not open) */
  today: string | undefined;
  onChange: (day: string) => void;
  disabled?: boolean;
  /** the last Complete was refused for the date */
  refused?: boolean;
  /** called after apply, cancel or clear: the till puts the cursor back in the scan box */
  onDone?: () => void;
  /** default COUNTER; the regular order passes OFFICE (past-only) */
  policy?: OrderDatePolicy;
  /** the till's scan entry: a scan made while the picker is open is handed here, never lost */
  onScan?: (code: string) => void;
}

export function CounterDateChip({
  value,
  today,
  onChange,
  disabled,
  refused,
  onDone,
  policy = "COUNTER",
  onScan,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const mainRef = React.useRef<HTMLButtonElement>(null);
  const canOpen = !disabled && !!today;
  // What is seen must be what is sent: a set day is NEVER labelled Today. While the business's day is unknown the day shows
  // as dated with no past/future word (UNKNOWN), and it can still be cleared.
  const direction: "BACK" | "FORWARD" | "UNKNOWN" | null = !value
    ? null
    : !today
      ? "UNKNOWN"
      : value < today
        ? "BACK"
        : value > today
          ? "FORWARD"
          : null;

  React.useEffect(() => {
    if (!canOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // matched on the physical key: Option+D on a Mac types a symbol, not "d"
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyD") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [canOpen]);

  // After apply, cancel or clear: the till puts the cursor back in its scan box (onDone); anywhere else focus returns to the
  // chip itself so it never drops to the page behind a dialog.
  const done = () => {
    if (onDone) onDone();
    else setTimeout(() => (mainRef.current?.disabled ? undefined : mainRef.current?.focus()), 0);
  };
  const close = () => {
    setOpen(false);
    done();
  };
  const clear = () => {
    onChange("");
    done();
  };
  // A form around the chip may swallow Enter (default-prevented) before a button's own click: Enter acts here, once.
  const onEnter = (act: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  };
  const apply = (day: string) => {
    onChange(day === today ? "" : day);
    close();
  };

  const text =
    direction && value
      ? `Dated ${dayLabel(value, today ?? value)}${direction === "FORWARD" ? " · future" : ""}`
      : "Today";
  const name =
    direction && value
      ? `${direction === "BACK" ? "Backdated to" : direction === "FORWARD" ? "Future-dated to" : "Dated"} ${fullDayName(value)}. Change or clear`
      : "Order date: today. Change";

  return (
    <>
      <span
        data-testid="counter-date-chip"
        data-direction={direction ?? "TODAY"}
        className={cn(
          "inline-flex min-h-[44px] items-center gap-1 rounded-full border px-3 text-sm font-medium",
          !direction && "border-navy/25 text-navy",
          (direction === "BACK" || direction === "UNKNOWN") &&
            "border-amber-400 bg-amber-100 text-amber-900",
          direction === "FORWARD" &&
            "border-dashed border-indigo-500 bg-indigo-100 text-indigo-900",
          refused && "ring-2 ring-red-500",
          disabled && "opacity-60",
        )}
      >
        <button
          ref={mainRef}
          type="button"
          className="inline-flex min-h-[44px] items-center gap-1.5 bg-transparent"
          onKeyDown={onEnter(() => {
            if (canOpen) setOpen(true);
          })}
          aria-label={name}
          aria-haspopup="dialog"
          disabled={!canOpen}
          onClick={() => setOpen(true)}
        >
          {direction === "BACK" ? (
            <History className="h-4 w-4" aria-hidden />
          ) : direction === "FORWARD" ? (
            <CalendarArrowUp className="h-4 w-4" aria-hidden />
          ) : (
            <CalendarIcon className="h-4 w-4" aria-hidden />
          )}
          {text}
        </button>
        {direction ? (
          <button
            type="button"
            className="inline-flex min-h-[44px] w-8 items-center justify-center bg-transparent"
            aria-label="Clear the order date, back to today"
            disabled={disabled}
            onKeyDown={onEnter(clear)}
            onClick={clear}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </span>
      {today ? (
        <CounterDatePicker
          open={open}
          today={today}
          value={value}
          onApply={apply}
          onClose={close}
          policy={policy}
          onScan={onScan}
        />
      ) : null}
    </>
  );
}

/** One muted line above Complete while the sale is dated: a reminder, not a step. */
export function CounterDateReminder({
  value,
  today,
}: {
  value: string;
  today: string | undefined;
}) {
  if (!value || value === today) return null;
  return (
    <p className="text-xs text-navy/70" data-testid="counter-date-reminder">
      This sale will be dated {dayLabel(value, today ?? value)}
      {today && value > today ? " (future)" : ""}
    </p>
  );
}
