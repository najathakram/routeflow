import { emailParagraph, type EmailLayoutSpec } from "../email/email-layout";
import { escapeHtml } from "../common/html-escape";

/**
 * The buyer-portal invite email (sendPortalInvite). Extracted from customers.service.ts (B809) so
 * escaping every value did not grow that ratcheted file. `sellerName` is the tenant's own business
 * name and `inviteUrl` the server-built accept link; every value is escaped here.
 *
 * It is TENANT mail: a business inviting its own buyer. It goes out through the tenant send path
 * (`send()` without a sender class) and `layout` makes `composeLayout` dress it in the tenant's
 * look with "Sent with RouteFlow", never RouteFlow's mark. The platform sender would drop `layout`.
 */
export interface PortalInviteEmail {
  subject: string;
  html: string;
  text: string;
  layout: EmailLayoutSpec;
}

export function portalInviteEmail(sellerName: string, inviteUrl: string): PortalInviteEmail {
  const invited =
    " has invited you to connect on the RouteFlow buyer portal — track orders, invoices, and statements in one place.";
  const expiry = "This link expires in 7 days.";
  return {
    subject: `${sellerName} invited you to their RouteFlow buyer portal`,
    html:
      emailParagraph("Hi,") +
      emailParagraph(`<strong>${escapeHtml(sellerName)}</strong>${escapeHtml(invited)}`) +
      emailParagraph(expiry),
    text: `Hi,\n\n${sellerName}${invited}\n\n${expiry}`,
    layout: {
      heading: "You're invited to the buyer portal",
      cta: { label: "Accept invite", url: inviteUrl },
      footerNote: `You are getting this because ${sellerName} invited this address to its buyer portal.`,
    },
  };
}
