"use client";

import { BuyerInviteFlow } from "./invite-flow";

/**
 * The buyer invite page. The emailed link is `/buyer/invite#t=<token>`: the token sits in the URL
 * fragment (never sent to a server, a log or a Referer), is read here on the client, scrubbed from
 * the address bar and POSTed in a request body.
 */
export default function BuyerInvitePage() {
  return <BuyerInviteFlow />;
}
