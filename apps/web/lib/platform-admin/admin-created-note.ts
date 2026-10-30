/**
 * The line under a freshly created tenant admin's temporary password (row 551). "Also emailed" is only said when the API
 * reports a delivered send (`emailSent`): the mail is best-effort, so a failed or missing send must never read as sent.
 */
export function adminCreatedNote(emailSent: boolean | null | undefined): string {
  return emailSent === true
    ? "It was also emailed to the admin. They must change it the first time they sign in."
    : "It could not be emailed, so pass it to the admin yourself. They must change it the first time they sign in.";
}
