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
  // Post-dated check payments PR-1: a PENDING payment (a post-dated check on file, not yet
  // clearable/bankable — see @routeflow/pricing's HELD_STATUSES doc) is checked BEFORE the
  // checkStatus switch below. Its checkStatus will typically be RECORDED, so without this
  // early check the switch would mask the more important PENDING signal behind a plain
  // "Recorded" badge.
  if (p.status === "PENDING") return { label: "Post-dated · pending", variant: "warning" };
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

/**
 * B1151 (SA-1228): the status cell of a buyer payment row. A check keeps its lifecycle badge; every other
 * row reads its own status so no cell is empty. A credit note or advance is an application, never cash (B421).
 * The five words are the owner's (2026-11-23); renaming one is a one-entry change here.
 */
export function paymentRowBadge(p: {
  method: string;
  status?: string;
  checkStatus?: "RECORDED" | "DEPOSITED" | "CLEARED" | "BOUNCED" | null;
}): ReturnType<typeof checkBadgeFor> {
  const check = checkBadgeFor(p);
  if (check) return check;
  switch (p.status) {
    case "VOID":
      return { label: "Void", variant: "danger" };
    case "DRAFT":
      return { label: "Not confirmed", variant: "neutral" };
    case "PENDING":
      return { label: "Pending", variant: "warning" };
    case "PAID":
      return p.method === "CREDIT_NOTE" || p.method === "ADVANCE"
        ? { label: "Applied", variant: "info" }
        : { label: "Received", variant: "success" };
    default:
      return null;
  }
}
