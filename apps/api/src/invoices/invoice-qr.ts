/**
 * #2717 M3 (SA-579 Q3, owner decision): the URL an order-linked invoice's QR opens, the web buyer
 * portal's order page: `<WEB_URL>/buyer/portal/<tenant slug>/orders/<order id>`. ONE builder, so
 * moving the target is a one-line change here.
 *
 * Returns null (no QR) when WEB_URL is unset, blank, not an http(s) URL (a scheme-less value would
 * make a broken link) or when the slug or order id is missing. There is NO localhost fallback. The
 * result never carries a query or a fragment (L-188): the base's own are dropped and the two path
 * segments are percent-encoded. The page itself sits behind the buyer session and ownership checks,
 * so opening the link signed out shows login, never order data.
 */
export function orderQrUrl(
  webUrl: string | undefined,
  tenantSlug: string,
  orderId: string,
): string | null {
  const base = (webUrl ?? "").trim();
  if (!base || !tenantSlug || !orderId) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const prefix = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${prefix}/buyer/portal/${encodeURIComponent(tenantSlug)}/orders/${encodeURIComponent(orderId)}`;
}
