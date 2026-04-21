import { Stack } from "expo-router";

// Sections (customers, orders, products, etc.) live here as proper Stack screens.
// The 5 visible tabs (home, dispatch, invoices, warehouse, more) live in (tabs)/.
// This means router.back() from any section correctly returns to the tab you came
// from — not to the home tab (the old bug caused by sections being hidden Tabs screens).
export default function OperatorLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
