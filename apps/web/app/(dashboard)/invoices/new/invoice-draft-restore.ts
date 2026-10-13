import type { InvoiceDraftSnapshot } from "@/lib/invoice-draft-storage";

/**
 * ROW 447: a stored draft names a customer and products by id. Ids are never trusted: before a restore keeps them the
 * page asks the server whether each one still exists. ONLY a definite 404 / 410 removes something; a network failure
 * keeps the draft as stored (the save path re-validates everything anyway).
 */
export interface RestoreCheck {
  snapshot: InvoiceDraftSnapshot;
  /** Lines left out because their product no longer exists. */
  droppedLines: number;
  /** The customer no longer exists and was cleared. */
  customerCleared: boolean;
}

type Get = (url: string) => Promise<{ data?: unknown }>;

/** 403 counts as gone too: a row this user may no longer see is not one to bill. */
const isGone = (err: unknown): boolean => {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 403 || status === 404 || status === 410;
};

/**
 * A row that still answers 200 but is soft-deleted, archived or inactive is gone as well:
 * `deletedAt` / `archivedAt` set, or `isActive === false` (the Product and Customer flag).
 */
export function isRetiredRow(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return !!d.deletedAt || !!d.archivedAt || d.isActive === false;
}

const settledGone = (r: PromiseSettledResult<{ data?: unknown } | null>): boolean =>
  r.status === "rejected" ? isGone(r.reason) : isRetiredRow(r.value?.data);

export async function checkDraftReferences(
  snapshot: InvoiceDraftSnapshot,
  get: Get,
): Promise<RestoreCheck> {
  const productIds = [
    ...new Set(snapshot.lines.map((l) => l.productId).filter(Boolean)),
  ] as string[];
  const [customerRes, ...productRes] = await Promise.allSettled([
    snapshot.customer
      ? get(`/customers/${encodeURIComponent(snapshot.customer.id)}`)
      : Promise.resolve(null),
    ...productIds.map((id) => get(`/products/${encodeURIComponent(id)}`)),
  ]);
  const gone = new Set(productIds.filter((_, i) => settledGone(productRes[i])));
  const lines = snapshot.lines.filter((l) => !l.productId || !gone.has(l.productId));
  const customerCleared = !!snapshot.customer && settledGone(customerRes);
  let customer = customerCleared ? null : snapshot.customer;
  // A live customer row refreshes the fields the form reads (name, tier, default terms).
  if (customer && customerRes.status === "fulfilled") {
    const d = (customerRes.value as { data?: Record<string, unknown> } | null)?.data;
    if (d && d.id === customer.id && typeof d.businessName === "string") {
      customer = {
        id: customer.id,
        businessName: d.businessName,
        ...(typeof d.pricingTier === "number" ? { pricingTier: d.pricingTier } : {}),
        ...(typeof d.defaultPaymentTerms === "string"
          ? { defaultPaymentTerms: d.defaultPaymentTerms }
          : {}),
      };
    }
  }
  return {
    snapshot: { ...snapshot, customer, lines },
    droppedLines: snapshot.lines.length - lines.length,
    customerCleared,
  };
}
