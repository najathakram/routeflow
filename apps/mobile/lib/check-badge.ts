/**
 * P5-16c (P5-12 twin): CHECK payment lifecycle badge — mobile mirror of
 * apps/web/lib/check-badge.ts. Same decision table; variants mapped to the
 * mobile Pill (neutral→gray, info→brand, success→green, danger→red). RN-free.
 */
// "orange" added (post-dated check payments PR-1) as this union's warning-style option —
// mirrors payments-logic.ts's sibling PillVariant, which already uses "orange" the same way.
export type CheckBadgeVariant = "gray" | "brand" | "green" | "red" | "orange";
export interface CheckBadge {
  label: string;
  variant: CheckBadgeVariant;
}

export function checkBadgeFor(p: {
  method?: string | null;
  status?: string;
  checkStatus?: "RECORDED" | "DEPOSITED" | "CLEARED" | "BOUNCED" | null;
}): CheckBadge | null {
  if (p.method !== "CHECK") return null;
  // Post-dated check payments PR-1: a PENDING payment (a post-dated check on file, not yet
  // clearable/bankable) is checked BEFORE the checkStatus switch below — its checkStatus will
  // typically be RECORDED, so without this the switch would mask the PENDING signal.
  if (p.status === "PENDING") return { label: "Post-dated · pending", variant: "orange" };
  if (!p.checkStatus) {
    if (p.status === "VOID") return null;
    return { label: "Recorded", variant: "gray" };
  }
  switch (p.checkStatus) {
    case "RECORDED":
      return { label: "Recorded", variant: "gray" };
    case "DEPOSITED":
      return { label: "Deposited", variant: "brand" };
    case "CLEARED":
      return { label: "Cleared", variant: "green" };
    case "BOUNCED":
      return { label: "Bounced", variant: "red" };
    default:
      return null;
  }
}
