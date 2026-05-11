import { redirect } from "next/navigation";

// /distributors is the URL the original design used for the wholesaler-side
// page. We picked /wholesalers as the canonical URL to match the user-facing
// nav copy ("I'm a wholesaler"). This redirect keeps any old design links
// working.
export default function DistributorsRedirect() {
  redirect("/wholesalers");
}
