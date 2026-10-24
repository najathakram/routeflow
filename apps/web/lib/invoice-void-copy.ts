import { codedToastCopy } from "./generic-toast-copy";

export const VOID_FALLBACK_COPY = "Please try again, or check this invoice's payments.";

/**
 * The toast body when voiding an invoice fails: the fixed copy for a refusal the client recognises, else the server's own
 * sentence (it says exactly what is in the way, e.g. payments to reverse first), else a generic line.
 */
export function voidFailureDescription(err: unknown): string {
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data
    ?.message;
  return (
    codedToastCopy(err) ?? (typeof message === "string" && message ? message : VOID_FALLBACK_COPY)
  );
}
