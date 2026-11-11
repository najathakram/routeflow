// W-1188: the "Dated Fri" tag on a Today's sales row. The list stays keyed on the entry day; this says the sale counts on
// another day. Amber with a history icon for a past day; indigo, dashed, with an arrow for a future one. The title and the
// accessible name carry the full date and the time it was entered.
import { CalendarArrowUp, History } from "lucide-react";
import type { TodaysSaleRow } from "@routeflow/types";
import { cn } from "@routeflow/ui/web";
import { fullDayName, weekdayShort } from "@/lib/natural-date";

export function CounterDatedTag({
  dated,
  enteredAt,
}: {
  dated: NonNullable<TodaysSaleRow["dated"]>;
  /** the entry time as the row shows it, e.g. "11:15 AM" */
  enteredAt: string;
}) {
  const future = dated.direction === "FORWARD";
  const full = `${future ? "Future-dated" : "Dated"} ${fullDayName(dated.day)}, ${dated.day.slice(0, 4)}. Entered ${enteredAt}`;
  return (
    <span
      data-testid="today-row-dated"
      data-direction={dated.direction}
      title={full.replace(/^Future-dated/, "Dated")}
      aria-label={full}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        future
          ? "border-dashed border-indigo-500 bg-indigo-100 text-indigo-900"
          : "border-amber-400 bg-amber-100 text-amber-900",
      )}
    >
      {future ? (
        <CalendarArrowUp className="h-3 w-3" aria-hidden />
      ) : (
        <History className="h-3 w-3" aria-hidden />
      )}
      {`Dated ${weekdayShort(dated.day)}${future ? " · future" : ""}`}
    </span>
  );
}
