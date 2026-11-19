import { emailParagraph } from "../email/email-layout";
import { routeflowFragmentMail, signIn, type BuiltEmail } from "../email/routeflow-mail";
import { JOURNEY_WELCOME_PATH } from "./signup-journey";

/**
 * The welcome, sent once to each account admin of a new trial business. DRAFT words: the owner approves the final
 * copy at switch-on. It promises no later emails and carries no reply line. Body paragraphs hold no business value
 * (the name goes in the subject, which is plain text, and in the footer reason, which the layout escapes: pass it raw).
 * `stopUrl` is REQUIRED: a journey mail with no stop link does not compile (W3).
 */
export function welcomeEmail(p: {
  businessName: string;
  /** The web origin: the sign-in line and the button are built on it. */
  webUrl: string;
  /** The tenant slug, the Workspace ID a person types at sign-in. */
  workspaceId: string;
  stopUrl: string;
}): BuiltEmail {
  const reminder = signIn(p.webUrl, p.workspaceId);
  const base = p.webUrl.replace(/\/$/, "");
  return routeflowFragmentMail({
    subject: `Welcome to RouteFlow, ${p.businessName}`,
    heading: "You're in. Here's how to start.",
    bodyHtml: [
      emailParagraph("Three steps get you from sign-up to your first invoice:"),
      emailParagraph("1. Add your products and customers."),
      emailParagraph("2. Take your first order."),
      emailParagraph("3. Send your first invoice."),
      reminder.html,
      emailParagraph("The RouteFlow team"),
    ].join(""),
    cta: { label: "Add your products and customers", url: `${base}${JOURNEY_WELCOME_PATH}` },
    why: `You're getting this because you started a RouteFlow trial for ${p.businessName}.`,
    footerLink: { label: "Stop these setup emails", url: p.stopUrl },
  });
}
