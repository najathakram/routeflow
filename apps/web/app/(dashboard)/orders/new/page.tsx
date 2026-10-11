import { redirect } from "next/navigation";

// What a link into the builder may carry through: a scan to add on open, and the ship preselect.
const PASS_THROUGH = ["scan", "preselect"] as const;

/**
 * /orders/new used to have no route of its own, so it fell into orders/[id] and read "Order not found." for every
 * tenant (row 331). It now goes to the Orders page's builder intent: `?builder=1` opens the order builder even where
 * the counter is the default, and a store-only business's builder runs in POS mode (invoice at Confirm).
 */
export default async function OrdersNewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const params = new URLSearchParams({ action: "new", builder: "1" });
  for (const key of PASS_THROUGH) {
    const raw = resolved[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) params.set(key, value);
  }
  redirect(`/orders?${params.toString()}`);
}
