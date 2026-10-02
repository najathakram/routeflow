import { codedToastCopy, genericToastCopy } from "./generic-toast-copy";

/**
 * The text an order delete refusal shows (B986-7). A recognised body code is fixed copy; an UNCODED refusal keeps the
 * server's own sentence, because it names what to fix ("void the invoice first") and no fixed sentence is as specific
 * until the endpoint sends a code (B991 / B987-E). Never axios's "Request failed with status code …": with no usable
 * server sentence it falls to the fixed generic copy. The sentence passes through ONLY for 400 / 404 / 409 / 422: a 5xx or a
 * 403 carries a framework string ("Internal server error", "Forbidden resource") that must never reach the user.
 */
const SENTENCE_STATUSES = new Set([400, 404, 409, 422]);

export function orderErrorText(err: unknown): string {
  const coded = codedToastCopy(err);
  if (coded) return coded;
  const response = (err as { response?: { status?: number; data?: { message?: unknown } } } | null)
    ?.response;
  const message = response?.data?.message;
  if (SENTENCE_STATUSES.has(response?.status ?? 0) && typeof message === "string" && message.trim())
    return message;
  return genericToastCopy(err);
}
