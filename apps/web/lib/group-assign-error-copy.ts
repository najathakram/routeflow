import { safeTextErrorCopy } from "./safe-text-error-copy";

/**
 * B964-2: the "Group as variants" request is refused as a WHOLE when one variant name is formula-led
 * (a coded 400 that carries the offending row's `index` and `productId`). The sentence names the
 * product so the operator knows which row to fix; the server message is never shown. Any other error is NOT ours: null, so the global toast shows it.
 */
export function groupAssignErrorCopy(
  err: unknown,
  products: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  const refusal = safeTextErrorCopy(err);
  if (!refusal) return null;
  const body = (err as { response?: { data?: { productId?: unknown } } } | null)?.response?.data;
  const bad =
    typeof body?.productId === "string" ? products.find((p) => p.id === body.productId) : undefined;
  return bad ? `${bad.name}: ${refusal} Nothing was grouped.` : `${refusal} Nothing was grouped.`;
}
