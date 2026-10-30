import { API_ERROR_CODES } from "@routeflow/types";
import { RETURN_MIXED_UNIT_PRODUCT_COPY } from "./credit-note-error-copy";

const CAP_REFUSAL = /^Return qty exceeds what is left on this line: /;
const RETRY = "Please try again.";

/**
 * The toast text when a new return is refused. The form only knows what was ordered, so the server's cap refusal is the
 * one place that says what earlier returns left, and a retry can never pass it: its sentence is shown as sent, as is the
 * count-shape sentence. A mixed-unit refusal gets fixed copy, coded or plain, because the plain 409 carries a raw product
 * id. Anything else keeps the retry line.
 */
export function createReturnErrorText(err: unknown): string {
  const response = (
    err as { response?: { status?: number; data?: { code?: unknown; message?: unknown } } } | null
  )?.response;
  const code = response?.data?.code;
  if (
    code === API_ERROR_CODES.RETURN_MIXED_UNIT_PRODUCT ||
    (response?.status === 409 && code == null)
  )
    return RETURN_MIXED_UNIT_PRODUCT_COPY;
  const sentence = response?.data?.message;
  if (
    response?.status === 400 &&
    typeof sentence === "string" &&
    (code === API_ERROR_CODES.RETURN_LINE_COUNT_SHAPE || CAP_REFUSAL.test(sentence))
  )
    return sentence;
  return RETRY;
}

/** A refusal the form explains itself, so the global mutation toast stands down and does not cover the sentence. */
export const isCreateReturnRefusal = (err: unknown): boolean =>
  createReturnErrorText(err) !== RETRY;
