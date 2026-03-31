import { redirect } from "next/navigation";

/**
 * Vendor bills are managed from the Purchases page (Finance → Purchases → Vendor Bills tab).
 * This route redirects there to avoid a duplicate UI.
 */
export default function VendorBillsPage() {
  redirect("/purchases");
}
