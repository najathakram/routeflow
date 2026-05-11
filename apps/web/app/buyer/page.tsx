import { redirect } from "next/navigation";

// /buyer was the old buyer-marketing landing. The new marketing site uses
// /retailers as the canonical retailer-facing route. Keep this redirect so
// existing bookmarks and inbound links don't 404.
//
// Note: /buyer/login, /buyer/register, /buyer/portal/* are unaffected — they
// live in their own files and continue to work exactly as before.
export default function BuyerLandingRedirect() {
  redirect("/retailers");
}
