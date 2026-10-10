import { loadMsrpMap } from "../common/msrp";

/**
 * Extracted verbatim from `InvoicesService.applyMsrpSnapshots` (size ratchet, #2717 M3).
 *
 * Stamp each line's MSRP at creation time. Snapshot, not a live read: an issued invoice
 * must never change because someone later edited the product's MSRP. No-ops (leaving
 * msrp null) when the tenant does not have flag.msrp, so a tenant that turns the feature
 * off simply stops emitting MSRP on NEW invoices while old ones keep what they printed.
 */
export async function stampMsrpSnapshots<
  T extends { productId?: string | null; msrp?: number | null; unitLabel?: string | null },
>(
  prisma: { getTenantId(): string | null },
  authority: { can(tenantId: string, flag: string): Promise<boolean> },
  db: any,
  customerId: string,
  itemsData: T[],
): Promise<void> {
  const tenantId = prisma.getTenantId();
  if (!tenantId || !(await authority.can(tenantId, "flag.msrp"))) return;
  const ids = [...new Set(itemsData.map((i) => i.productId).filter(Boolean))] as string[];
  if (ids.length === 0) return;
  const map = await loadMsrpMap(db, customerId, ids);
  for (const it of itemsData) {
    // units_v1: the MSRP map is per PACK, a unit line is priced per UNIT — never stamp it
    if (it.productId && !it.unitLabel) it.msrp = map.get(it.productId) ?? null;
  }
}
