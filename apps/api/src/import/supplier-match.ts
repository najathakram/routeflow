/**
 * Scored supplier auto-match, shared by the AI batch-import queue and the
 * live invoice-scan path: exact name → unique startsWith → unique substring
 * (either direction). Several equally-plausible candidates or no candidate
 * at all → null, never a silent wrong pick — callers route that case to a
 * human (NEEDS_REVIEW / unresolved supplier) instead of guessing.
 *
 * Pure, no Nest/Prisma imports — the candidate list is passed in, so specs
 * run with zero mocks.
 */
export interface SupplierCandidate {
  id: string;
  name: string;
}

export function matchSupplier(
  detected: string,
  suppliers: SupplierCandidate[],
): SupplierCandidate | null {
  const d = detected.trim().toLowerCase();
  if (!d) return null;
  const exact = suppliers.filter((s) => s.name.trim().toLowerCase() === d);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const starts = suppliers.filter(
    (s) => s.name.trim().toLowerCase().startsWith(d) || d.startsWith(s.name.trim().toLowerCase()),
  );
  if (starts.length === 1) return starts[0];
  if (starts.length > 1) return null;
  const contains = suppliers.filter((s) => {
    const n = s.name.trim().toLowerCase();
    return n.includes(d) || d.includes(n);
  });
  return contains.length === 1 ? contains[0] : null;
}
