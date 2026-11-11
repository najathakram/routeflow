import { formatLineCounts, summarizeLineCounts, type CountableLine } from "@routeflow/pricing";
import { cn } from "@routeflow/ui/web";

/**
 * W-1185: the running item count ("12 lines · 30 boxes · 6 pcs") beside the total on the order builder
 * and the counter till, so the person entering lines can check the count against the goods. Counts
 * only; the words come from `@routeflow/pricing`. Shows nothing until a line has a quantity.
 */
export function LineCountChip({
  lines,
  className,
}: {
  lines: ReadonlyArray<CountableLine>;
  className?: string;
}) {
  const counts = summarizeLineCounts(lines);
  if (counts.lines === 0) return null;
  const text = formatLineCounts(counts);
  return (
    <div
      data-testid="line-count-chip"
      className={cn(
        "inline-flex max-w-full items-center rounded-full bg-sunken px-2.5 py-1 text-xs font-medium tabular-nums text-navy/80",
        className,
      )}
    >
      {/* Keyed on the text: a changed count remounts the span, which replays the pulse (globals.css). */}
      <span key={text} className="rf-count-pulse">
        {text}
      </span>
    </div>
  );
}
