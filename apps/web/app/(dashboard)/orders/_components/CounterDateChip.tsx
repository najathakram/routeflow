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
import { dateIfNotToday } from "@/lib/counter-order-date";
import { COUNTER_ORDER_DATE_ZONE_FAILED_COPY } from "@/lib/counter-sale";
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
  /** the till: a scan's first key was pressed in the picker; it closes with no date change and the till takes the rest */
  onScanKey?: (key: string) => void;
  /** the business's day could not be read (not just slow): the chip says so instead of "checking" for ever */
  todayFailed?: boolean;
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
  onScanKey,
  todayFailed,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const mainRef = React.useRef<HTMLButtonElement>(null);
  const canOpen = !disabled && !!today;
  // A scan's keys can land on the chip after the picker closes (Escape, Cancel): its Enter must not open the picker. Same idea
  // as the picker's inert run, by key order and no clock: a printable key typed with no text field focused starts a run, the
  // run's Enter (and a CR+LF second Enter) is swallowed when it falls on the chip, and any other key or a pointer ends it.
  const scanRun = React.useRef<"none" | "run" | "ended">("none");
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
    const person = () => {
      scanRun.current = "none";
    };
    const onRun = (e: KeyboardEvent) => {
      if (["Shift", "CapsLock", "Alt", "Control", "Meta", "AltGraph"].includes(e.key)) return;
      const t = e.target;
      const typing =
        t instanceof HTMLElement &&
        (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
      const altGr = e.getModifierState?.("AltGraph") === true;
      const combo = !altGr && (e.ctrlKey || e.altKey || e.metaKey);
      if (typing || combo) {
        scanRun.current = "none";
      } else if (e.key.length === 1 && e.key !== " ") {
        scanRun.current = "run";
      } else if (e.key === "Enter") {
        const wasScan = scanRun.current !== "none";
        scanRun.current = scanRun.current === "run" ? "ended" : "none";
        if (wasScan && t === mainRef.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      } else {
        scanRun.current = "none";
      }
    };
    window.addEventListener("keydown", onRun, true);
    window.addEventListener("pointerdown", person, true);
    return () => {
      window.removeEventListener("keydown", onRun, true);
      window.removeEventListener("pointerdown", person, true);
    };
  }, []);

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
    onChange(dateIfNotToday(day, today));
    close();
  };

  // R8: while the business's day is unknown the day is shown as a day being checked: not Today, not Dated, no colour claim.
  const text =
    direction === "UNKNOWN"
      ? `${dayLabel(value, value)} · ${todayFailed ? "couldn't check" : "checking"}`
      : direction && value
        ? `Dated ${dayLabel(value, today ?? value)}${direction === "FORWARD" ? " · future" : ""}`
        : "Today";
  const name =
    direction === "UNKNOWN"
      ? `Order date ${fullDayName(value)}, ${todayFailed ? "could not check the business's day" : "checking the business's day"}. Clear`
      : direction && value
        ? `${direction === "BACK" ? "Backdated to" : "Future-dated to"} ${fullDayName(value)}. Change or clear`
        : "Order date: today. Change";

  return (
    <>
      <span
        data-testid="counter-date-chip"
        data-direction={direction ?? "TODAY"}
        className={cn(
          "inline-flex min-h-[44px] items-center gap-1 rounded-full border px-3 text-sm font-medium",
          (!direction || direction === "UNKNOWN") && "border-navy/25 text-navy",
          direction === "BACK" && "border-amber-400 bg-amber-100 text-amber-900",
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
          onScanKey={onScanKey}
          ownsFocus={!!onDone}
        />
      ) : null}
    </>
  );
}

/** One muted line above Complete while the sale is dated: a reminder, not a step. */
export function CounterDateReminder({
  value,
  today,
  todayFailed,
  onRetry,
}: {
  value: string;
  today: string | undefined;
  todayFailed?: boolean;
  /** re-runs the read of the business's day; shown beside the failed copy */
  onRetry?: () => void;
}) {
  if (!dateIfNotToday(value, today)) return null;
  // While the business's day is unknown the chip says "checking": the reminder must not claim the sale is dated yet
  if (!today)
    return (
      <p className="text-xs text-navy/70" data-testid="counter-date-reminder">
        {todayFailed
          ? COUNTER_ORDER_DATE_ZONE_FAILED_COPY
          : "Checking today's date. Complete waits for it."}
        {todayFailed && onRetry ? (
          <>
            {" "}
            <button type="button" className="min-h-[44px] px-2 underline" onClick={onRetry}>
              Try again
            </button>
          </>
        ) : null}
      </p>
    );
  return (
    <p className="text-xs text-navy/70" data-testid="counter-date-reminder">
      This sale will be dated {dayLabel(value, today ?? value)}
      {today && value > today ? " (future)" : ""}
    </p>
  );
}
