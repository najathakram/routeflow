import { Badge } from "@routeflow/ui/web";
import type { ToCollectState } from "@routeflow/types";

/**
 * SA-1026 A: the "To collect" chip: a named customer's sale saved On account with a check not received yet. The server
 * derives the state and sends it to STAFF only (clients never compute it, and a buyer read has no field). TO_COLLECT and
 * UNKNOWN both show (fail closed: shown, never hidden); NONE and an absent field render nothing.
 */
export function ToCollectChip({ state }: { state?: ToCollectState | null }) {
  if (state !== "TO_COLLECT" && state !== "UNKNOWN") return null;
  return <Badge variant="warning" label="To collect" data-testid="to-collect-chip" />;
}
