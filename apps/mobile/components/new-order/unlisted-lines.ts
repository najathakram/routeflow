import type { UnlistedLine } from "./types";

/**
 * New order's ad-hoc (non-catalog) line edits, as pure transforms of the list (the screen wraps each in `setUnlisted`,
 * importing this module as `ul`). A quantity of 0 or less removes the line; a missing or negative price reads as $0
 * (a comped line is still sent).
 */
export const qty = (u: UnlistedLine[], id: string, next: number): UnlistedLine[] =>
  next <= 0 ? u.filter((x) => x.id !== id) : u.map((x) => (x.id === id ? { ...x, qty: next } : x));

export const price = (u: UnlistedLine[], id: string, value: number | null): UnlistedLine[] => {
  const unitPrice = value == null || value < 0 ? 0 : value;
  return u.map((x) => (x.id === id ? { ...x, unitPrice } : x));
};

export const note = (u: UnlistedLine[], id: string, text: string): UnlistedLine[] =>
  u.map((x) => (x.id === id ? { ...x, note: text } : x));

export const toggleNote = (u: UnlistedLine[], id: string): UnlistedLine[] =>
  u.map((x) => (x.id === id ? { ...x, noteOpen: !x.noteOpen } : x));
