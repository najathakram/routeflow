import { useRouter } from "expo-router";
import { useInlineReturnsAddon } from "../lib/api/addons";
import { inlineReturnHref, inlineReturnsGate } from "../lib/inline-return-screen";

/**
 * #2420 review (required fold): the "Record return" entry point, mirroring web's
 * RecordReturnAction — it exists only when the tenant has the orders_inline_returns add-on
 * (null while loading or blocked, so the row renders nothing), and is never gated on the order's
 * status. Returns the press handler; each screen renders its own row in its own style.
 */
export function useRecordReturn(args: {
  customerId?: string | null;
  orderId?: string | null;
  customerName?: string | null;
}): (() => void) | null {
  const router = useRouter();
  const gate = inlineReturnsGate(useInlineReturnsAddon());
  if (gate !== "allowed" || !args.customerId) return null;
  const href = inlineReturnHref({
    customerId: args.customerId,
    orderId: args.orderId,
    customerName: args.customerName,
  });
  return () => router.push(href as never);
}
