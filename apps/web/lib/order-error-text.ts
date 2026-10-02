import { codedToastCopy, genericToastCopy } from "./generic-toast-copy";

/**
 * The text an order delete refusal shows (B986-7). A recognised body code is fixed copy; an UNCODED refusal keeps the
 * server's own sentence, because it names what to fix ("void the invoice first") and no fixed sentence is as specific
 * until the endpoint sends a code (B991 / B987-E). Never axios's "Request failed with status code …": with no usable
 * server sentence it falls to the fixed generic copy.
 */
export function orderErrorText(err: unknown): string {
  const coded = codedToastCopy(err);
  if (coded) return coded;
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data
    ?.message;
  if (typeof message === "string" && message.trim()) return message;
  return genericToastCopy(err);
}
