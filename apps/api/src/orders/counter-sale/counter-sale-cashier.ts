/**
 * Row 317: the ONE display name of the staff user who rang a counter sale (`Order.soldBy`). It is the user's `username`, the
 * name every staff list prints; never the email. A username that looks like an email address reads as no cashier (a receipt
 * handed to a customer carries no address), and an old row (soldById not stamped yet) is null. Shared by the Today's-sales
 * row and the emailed receipt so the two can never name the cashier differently.
 */
export function cashierNameOf(
  soldBy: { username?: string | null } | null | undefined,
): string | null {
  const name = (soldBy?.username ?? "").trim();
  if (!name || name.includes("@")) return null;
  return name;
}
