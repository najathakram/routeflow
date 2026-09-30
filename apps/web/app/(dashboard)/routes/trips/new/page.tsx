import { redirect } from "next/navigation";

// Moved to /deliveries/new — order delivery is its own addon-gated surface now,
// separate from recurring routes. Kept as a redirect so bookmarks, the command
// palette, and e2e specs targeting the old URL keep working.
export default function LegacyTripBuilderRedirect() {
  redirect("/deliveries/new");
}
