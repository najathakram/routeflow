import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";

/**
 * K11-21: the one way a money figure prints on the product page. `formatMoney` text (`$1,800.00`,
 * `$0.00` never a dash) in tabular figures, so tier columns line up. Display only; no math.
 */
export function MoneyFigure({
  value,
  className,
}: {
  value: number | string | null | undefined;
  className?: string;
}) {
  return <span className={cn("tabular-nums", className)}>{formatMoney(value)}</span>;
}
