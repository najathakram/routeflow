/**
 * A quote that did not come back (a server error, a timeout, no answer) is a FAILURE: the lines are fine, ask again. A quote
 * the server answered with a refusal (a 4xx with its own sentence: over the sold quantity, read-only, no add-on) is a REFUSAL:
 * the dialog shows the sentence. The first gets one fixed sentence and a Try again; the second gets the server's sentence.
 */
export const QUOTE_FAILED_COPY = "Couldn't get the quote. Try again.";

export function isQuoteFailure(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
  return status === undefined || status >= 500 || status === 408 || status === 429;
}
