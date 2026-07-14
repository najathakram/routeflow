/**
 * P5-12: lifecycle badge for a CHECK payment row. Only checks get a badge.
 * A manually-voided (never-bounced) check has no checkStatus and status
 * VOID — that's a plain void, not a lifecycle event, so no badge.
 * A missing checkStatus on a non-void check is legacy data recorded before
 * the lifecycle existed — treat it as RECORDED.
 *
 * Extracted (P5-14) so the buyer invoice-detail and payments pages render
 * identical badges from one source instead of two copies drifting apart.
 */
export function checkBadgeFor(p: {
  method: string;
  status?: string;
  checkStatus?: "RECORDED" | "DEPOSITED" | "CLEARED" | "BOUNCED" | null;
}): { label: string; variant: "success" | "warning" | "danger" | "neutral" | "info" } | null {
  if (p.method !== "CHECK") return null;
  if (!p.checkStatus) {
    if (p.status === "VOID") return null;
    return { label: "Recorded", variant: "neutral" };
  }
  switch (p.checkStatus) {
    case "RECORDED":
      return { label: "Recorded", variant: "neutral" };
    case "DEPOSITED":
      return { label: "Deposited", variant: "info" };
    case "CLEARED":
      return { label: "Cleared", variant: "success" };
    case "BOUNCED":
      return { label: "Bounced", variant: "danger" };
    default:
      return null;
  }
}
