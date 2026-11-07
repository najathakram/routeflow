import { routeflowNotice, type BuiltEmail } from "../email/routeflow-mail";

/**
 * The buyer-portal invite email (sendPortalInvite). Extracted from customers.service.ts (B809) so
 * escaping every value did not grow that ratcheted file. `sellerName` is the tenant's own business
 * name and `inviteUrl` the server-built accept link; the layout escapes both. It goes out from the
 * platform sender (an account-linking link must never leave a tenant's mailbox), so it wears
 * RouteFlow's look and names the seller in the words.
 */
export function portalInviteEmail(sellerName: string, inviteUrl: string): BuiltEmail {
  return routeflowNotice({
    subject: `${sellerName} invited you to their RouteFlow buyer portal`,
    heading: "You're invited to the buyer portal",
    lines: [
      "Hi,",
      [
        { b: sellerName },
        " has invited you to connect on the RouteFlow buyer portal — track orders, invoices, and statements in one place.",
      ],
      "This link expires in 7 days.",
    ],
    cta: { label: "Accept invite", url: inviteUrl },
    why: `You are getting this because ${sellerName} invited this address to its buyer portal.`,
  });
}
