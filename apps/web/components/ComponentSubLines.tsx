import * as React from "react";
import { componentSubLineText } from "@routeflow/pricing";
import type { LineComponentView } from "@routeflow/types";

/**
 * #2717 M3 (cases 33, L-225): the sub-lines under a composed (mixed-pack) invoice or order line, one
 * per frozen component, "(included)": the box line above stays authoritative and these carry no
 * money. The text is the ONE shared `componentSubLineText`. Renders nothing for a legacy line.
 */
export function ComponentSubLines({
  components,
}: {
  components?: ReadonlyArray<LineComponentView> | null;
}) {
  if (!components || components.length === 0) return null;
  const rows = [...components].sort((a, b) => a.position - b.position);
  return (
    <ul className="mt-1 space-y-0.5 text-xs font-normal text-navy/60" data-testid="line-components">
      {rows.map((c) => (
        <li key={c.componentProductId} data-testid="line-component-sub-line">
          {componentSubLineText({
            name: c.name,
            qty: Number(c.qty),
            unitSku: c.unitSku,
            unitBarcode: c.unitBarcode,
            // Prisma sends a Decimal as a string until the API serializer lands (#2705).
            displayUnitPrice4: c.displayUnitPrice4 == null ? null : Number(c.displayUnitPrice4),
          })}
        </li>
      ))}
    </ul>
  );
}
