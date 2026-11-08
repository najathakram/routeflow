/**
 * Body of a messaging-engine EMAIL send (N1). The send dresses it in the tenant's look
 * (`EmailSendParams.layout`, W-1163), so this file builds only the body fragment.
 * `messaging.helpers.ts`'s `renderTemplate()` has ALREADY substituted `{{vars}}` into `bodyText` by
 * the time this runs, so the WHOLE string is escaped uniformly here — there is no way to tell
 * substituted content from static template text at this point, and escaping everything is a
 * strict superset of "every interpolated value escaped".
 */
import { escapeHtml } from "../../common/html-escape";
import { emailParagraph } from "../../email/email-layout";

/** Re-exported for tests (the one shared escaper, B809). */
export { escapeHtml };

/** The html body fragment: the whole text escaped, line breaks kept. */
export function buildNotificationEmailBody(bodyText: string): string {
  return emailParagraph(escapeHtml(bodyText).replace(/\n/g, "<br/>"));
}
