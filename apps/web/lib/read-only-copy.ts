import type { SubscriptionView } from "@routeflow/types";
import {
  readOnlyCopy as composeReadOnlyCopy,
  type ReadOnlyCopy,
  type ReadOnlyCopyInput,
} from "@routeflow/types/read-only-copy";
import { formatMoney } from "./format";

/**
 * SA-776 (row 382): the web's ONE read-only copy helper. The strings live in `@routeflow/types/read-only-copy`
 * (shared with mobile); this binds the shared money formatter and adds the subscription-view adapter. Every surface
 * (the read-only banner, the shell strip, `readOnlyLine`, the 403 toast) composes the sentence + reason + contact
 * HERE and never from a 403's server text.
 *
 *   const copy = readOnlyCopyForView(view, role === "TENANT_ADMIN");
 *   <p>{copy.sentence}</p>
 *   {copy.reasonLine && <p>{copy.reasonLine}</p>}{copy.contactLine && <p>{copy.contactLine}</p>}
 */
export {
  READ_ONLY_SENTENCE,
  readOnlyContactLine,
  readOnlyReasonLine,
} from "@routeflow/types/read-only-copy";
export type { ReadOnlyCopy, ReadOnlyCopyInput } from "@routeflow/types/read-only-copy";

export function readOnlyCopy(input: ReadOnlyCopyInput = {}): ReadOnlyCopy {
  return composeReadOnlyCopy({ formatMoney, ...input });
}

/** The joined text (sentence + reason + contact), e.g. for a toast title or a `title` attribute. */
export function readOnlyCopyText(input: ReadOnlyCopyInput = {}): string {
  return readOnlyCopy(input).text;
}

/** The same composition from the subscription view (the shell already holds one read). */
export function readOnlyCopyForView(
  view: SubscriptionView | null | undefined,
  isAdmin: boolean,
): ReadOnlyCopy {
  return readOnlyCopy({
    reason: view?.readOnlyReason ?? null,
    overdueAmount: view?.openInvoiceAmount ?? null,
    billingContactEmail: view?.billingContactEmail ?? null,
    isAdmin,
  });
}
