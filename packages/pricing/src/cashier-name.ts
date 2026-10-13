/**
 * Row 317: the ONE display name of a staff user on a customer-facing receipt (`Cashier:` and `Reprinted by`), shared by the API
 * (Today's-sales row, reprint model, emailed receipt) and the web (live receipt, reprint). It is the user's `username`,
 * trimmed; never an email: a username that looks like an email address reads as no name (a receipt handed to a customer
 * carries no address), and an old row (soldById not stamped yet) is null. NOTE (owner call): `username` is the login id; a
 * dedicated display name or initials field would avoid putting a login id on a receipt.
 */
export function cashierNameOf(
  user: { username?: string | null } | null | undefined,
): string | null {
  const name = (user?.username ?? "").trim();
  if (!name || name.includes("@")) return null;
  return name;
}
