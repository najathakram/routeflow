"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { DayPicker, getDefaultClassNames, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { differenceInCalendarDays, format } from "date-fns";
import { cn } from "@routeflow/ui/web";

export interface DateRangeValue {
  /** Inclusive YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface DateRangePickerProps {
  value: DateRangeValue;
  preset: string; // a ReportRangePreset key, or "custom"
  presets: { value: string; label: string }[];
  /** Resolve a preset key to a range (the caller owns the preset math). */
  resolvePreset: (preset: string) => DateRangeValue;
  onChange: (next: { preset: string; range: DateRangeValue }) => void;
  /** Inclusive-day cap; days beyond it are disabled once one end is picked. */
  maxDays?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Parse an inclusive `YYYY-MM-DD` string as a LOCAL calendar date. Never
 * `new Date(iso)` / `.toISOString()` for this: both parse/serialize in UTC,
 * which silently shifts the visible day for any tenant west of UTC.
 */
function parseLocalDate(iso: string): Date | undefined {
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

/** Inverse of {@link parseLocalDate} — local calendar fields, never UTC. */
function formatLocalIso(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

// `getDefaultClassNames()` returns the `rdp-*` class the imported stylesheet
// keys its rules on — merging it into `classNames` (rather than replacing it)
// keeps the calendar's real layout/sizing while layering our own tokens.
const rdp = getDefaultClassNames();

const dayPickerClassNames = {
  root: cn(rdp.root, "text-navy"),
  months: cn(rdp.months, "gap-6"),
  month_caption: cn(rdp.month_caption, "justify-center"),
  caption_label: cn(rdp.caption_label, "text-sm font-semibold text-navy"),
  nav: cn(rdp.nav),
  button_previous: cn(
    rdp.button_previous,
    "rounded text-navy/60 transition-colors hover:bg-surface-raised hover:text-navy",
  ),
  button_next: cn(
    rdp.button_next,
    "rounded text-navy/60 transition-colors hover:bg-surface-raised hover:text-navy",
  ),
  chevron: cn(rdp.chevron, "fill-navy/60"),
  weekdays: cn(rdp.weekdays),
  weekday: cn(rdp.weekday, "text-xs font-medium text-navy/50"),
  day: cn(rdp.day, "text-sm text-navy"),
  day_button: cn(rdp.day_button, "rounded-full transition-colors hover:bg-surface-raised"),
  today: cn(rdp.today, "font-semibold text-brand-600"),
  outside: cn(rdp.outside, "text-navy/30"),
  disabled: cn(rdp.disabled, "cursor-not-allowed text-navy/20 hover:bg-transparent"),
  selected: cn(rdp.selected, "bg-brand-500 text-white"),
  range_start: cn(rdp.range_start, "rounded-l-full bg-brand-500 text-white"),
  range_middle: cn(rdp.range_middle, "bg-brand-500/15 text-navy"),
  range_end: cn(rdp.range_end, "rounded-r-full bg-brand-500 text-white"),
};

/**
 * Reusable date-range control: a text-input-styled trigger that opens a
 * hand-rolled popover (outside-`mousedown` + `Escape` close, mirroring
 * `SubcategoryCombobox`) with a preset rail on the left and a two-month
 * `react-day-picker` range calendar on the right. Fully controlled — the
 * caller owns both the active preset and the resolved `{from, to}` range;
 * this component only translates between that and `react-day-picker`'s
 * `Date`-based selection model.
 */
export function DateRangePicker({
  value,
  preset,
  presets,
  resolvePreset,
  onChange,
  maxDays = 366,
  disabled,
  className,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  // The in-progress selection's first endpoint. Owned locally so the range cap does
  // not depend on the parent round-tripping a degenerate one-day range, and so the
  // first click does not emit (and refetch) a meaningless single-day window.
  const [pendingAnchor, setPendingAnchor] = React.useState<Date | undefined>(undefined);

  // Close on outside click or Escape; return focus to the trigger on Escape
  // (mirrors SubcategoryCombobox.tsx:73-83 / ReportColumnsPicker.tsx).
  React.useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setPendingAnchor(undefined);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setPendingAnchor(undefined);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selectedRange: DateRange = {
    from: parseLocalDate(value.from),
    to: parseLocalDate(value.to),
  };

  const handlePresetClick = (p: string) => {
    onChange({ preset: p, range: resolvePreset(p) });
    setOpen(false);
    setPendingAnchor(undefined);
    triggerRef.current?.focus();
  };

  // Driven by the CLICKED day (`onSelect`'s second argument), never by the range
  // `react-day-picker` computes: when a complete range is selected its `addToRange`
  // only ever EXTENDS it, so its `from`/`to` are not what the user just clicked.
  // First click anchors a fresh range, second click commits it.
  const handleDaySelect = (_range: DateRange | undefined, day: Date) => {
    if (!pendingAnchor) {
      setPendingAnchor(day);
      return;
    }
    const from = day < pendingAnchor ? day : pendingAnchor;
    const to = day < pendingAnchor ? pendingAnchor : day;
    setPendingAnchor(undefined);
    onChange({
      preset: "custom",
      range: { from: formatLocalIso(from), to: formatLocalIso(to) },
    });
  };

  // While an anchor is pending (exactly one endpoint picked), grey out days more
  // than `maxDays - 1` away from it so the server's cap can never be tripped from
  // this UI. Derived from local state, not from `value`, so it engages on the very
  // first click and never depends on a degenerate one-day range reaching the parent.
  const disabledMatcher = pendingAnchor
    ? (day: Date) => Math.abs(differenceInCalendarDays(day, pendingAnchor)) > maxDays - 1
    : undefined;

  // While an anchor is pending, show it as the in-progress selection so the user
  // sees their first click land instead of the calendar looking unresponsive.
  const calendarSelected: DateRange = pendingAnchor
    ? { from: pendingAnchor, to: undefined }
    : selectedRange;

  // The popover is conditionally rendered, so `DayPicker` remounts on every open —
  // and rdp derives its initial month from `month || defaultMonth || today`, never
  // from `selected`. Without this the calendar reopens on the CURRENT month with the
  // active range off-screen (e.g. a "Last month" report on Jul 31 shows Jul + Aug,
  // nothing highlighted). Anchoring the LEFT pane on the selection's start month is
  // what keeps the range fully visible: with `numberOfMonths={2}` rdp renders that
  // month plus the one after it, which covers every range spanning at most two
  // calendar months — the widest a two-pane calendar can ever show.
  const defaultMonth = pendingAnchor ?? selectedRange.from ?? new Date();

  const activePreset = preset !== "custom" ? presets.find((p) => p.value === preset) : undefined;
  const triggerLabel = activePreset
    ? activePreset.label
    : selectedRange.from
      ? selectedRange.to
        ? `${format(selectedRange.from, "MMM d, yyyy")} – ${format(selectedRange.to, "MMM d, yyyy")}`
        : format(selectedRange.from, "MMM d, yyyy")
      : "Select a date range";

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        onClick={() => {
          // Toggling the panel shut is a close path too — drop any half-finished
          // selection so the next click anchors afresh instead of committing a
          // range from a stale endpoint.
          setPendingAnchor(undefined);
          setOpen((v) => !v);
        }}
        className="flex w-full items-center justify-between gap-2 rounded border border-surface-border bg-white px-3 py-2 text-left text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-navy/50"
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-navy/50 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && !disabled && (
        <div className="absolute left-0 top-full z-50 mt-1 flex overflow-hidden rounded-lg border border-surface-border bg-white shadow-dropdown">
          <ul className="w-36 shrink-0 border-r border-surface-border py-2">
            {presets.map((p) => (
              <li key={p.value}>
                <button
                  type="button"
                  onClick={() => handlePresetClick(p.value)}
                  className={cn(
                    "w-full px-3 py-1.5 text-left text-sm text-navy transition-colors hover:bg-surface-raised",
                    p.value === preset && "bg-brand-500/10 font-medium text-brand-600",
                  )}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="p-3">
            <DayPicker
              mode="range"
              numberOfMonths={2}
              defaultMonth={defaultMonth}
              selected={calendarSelected}
              onSelect={handleDaySelect}
              disabled={disabledMatcher}
              classNames={dayPickerClassNames}
            />
          </div>
        </div>
      )}
    </div>
  );
}
