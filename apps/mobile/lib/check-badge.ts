/**
 * P5-16c (P5-12 twin): CHECK payment lifecycle badge — mobile mirror of
 * apps/web/lib/check-badge.ts. Same decision table; variants mapped to the
 * mobile Pill (neutral→gray, info→brand, success→green, danger→red). RN-free.
 */
export type CheckBadgeVariant = "gray" | "brand" | "green" | "red";
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
