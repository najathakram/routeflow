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

const isGone = (err: unknown): boolean => {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 404 || status === 410;
};

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
  const gone = new Set(
    productIds.filter(
      (_, i) =>
        productRes[i].status === "rejected" &&
        isGone((productRes[i] as PromiseRejectedResult).reason),
    ),
  );
  const lines = snapshot.lines.filter((l) => !l.productId || !gone.has(l.productId));
  const customerCleared =
    !!snapshot.customer && customerRes.status === "rejected" && isGone(customerRes.reason);
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
