import { Redirect } from "expo-router";

/**
 * BUG-B1-7: a buyer who URL-bar deep-links to /orders previously hit
 * "Unmatched Route / Page not found" because the (customer)/orders/
 * directory only had [id].tsx and cart.tsx — no bare-URL match.
 * Redirect to the tabs version so /orders is meaningful for buyers.
 */
export default function CustomerOrdersIndexRedirect() {
  return <Redirect href="/(customer)/(tabs)/orders" />;
}
