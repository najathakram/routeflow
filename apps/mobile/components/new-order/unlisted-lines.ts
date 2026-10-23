import type { UnlistedLine } from "./types";

/**
 * New order's ad-hoc (non-catalog) line edits, as pure transforms of the list (the screen wraps each in `setUnlisted`).
 * A quantity of 0 or less removes the line; a missing or negative price reads as $0 (a comped line is still sent).
 */
export const unlistedWithQty = (u: UnlistedLine[], id: string, qty: number): UnlistedLine[] =>
  qty <= 0 ? u.filter((x) => x.id !== id) : u.map((x) => (x.id === id ? { ...x, qty } : x));

export const unlistedWithPrice = (
  u: UnlistedLine[],
  id: string,
  value: number | null,
): UnlistedLine[] => {
  const price = value == null || value < 0 ? 0 : value;
  return u.map((x) => (x.id === id ? { ...x, unitPrice: price } : x));
};

export const unlistedPatched = (
  u: UnlistedLine[],
  id: string,
  patch: (x: UnlistedLine) => Partial<UnlistedLine>,
): UnlistedLine[] => u.map((x) => (x.id === id ? { ...x, ...patch(x) } : x));
