export interface SiblingCandidate {
  id: string;
  invoiceGroupId?: string | null;
}

/**
 * Filter an already-loaded invoice list down to siblings of `current` — other
 * invoices sharing the same `invoiceGroupId` (set only when both were created
 * together by a regulated sale split,
 * apps/api/src/invoices/invoices.service.ts#createSplitInvoices). Returns []
 * when `current` has no group (the common case: most invoices aren't split) or
 * no candidate shares it. Pure so the ordering/exclusion rule is locked by Jest
 * independent of the screen's data-fetching.
 */
export function siblingInvoicesOf<T extends SiblingCandidate>(
  candidates: T[],
  current: SiblingCandidate | undefined,
): T[] {
  if (!current?.invoiceGroupId) return [];
  return candidates.filter(
    (c) => c.invoiceGroupId === current.invoiceGroupId && c.id !== current.id,
  );
}
