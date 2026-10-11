"use client";

import { useParams } from "next/navigation";
import { BuyerInviteFlow } from "../invite-flow";

/**
 * Legacy invite route (`/buyer/invite/<token>`), kept for links emailed before the fragment
 * format. It does the same job as `/buyer/invite` but reads the token from the path segment, and
 * it too calls the API with the token in a request body. The API stops honouring these links at
 * its legacy cut-off; this route can then be deleted.
 */
export default function LegacyBuyerInvitePage() {
  const params = useParams();
  const token = typeof params.token === "string" ? params.token : undefined;
  return <BuyerInviteFlow legacyToken={token} />;
}
