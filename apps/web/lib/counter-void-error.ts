import { genericToastCopy } from "./generic-toast-copy";
import { COUNTER_VOID_ERROR_COPY } from "./counter-void-copy";

/** The `body.code` of a failed void, or "". */
export function voidErrorCode(err: unknown): string {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  return typeof code === "string" ? code : "";
}

/**
 * The fixed sentence for a failed void: the void's own copy by `body.code`, else the app's generic fixed copy (a 400
 * validation, a 403, a timeout's "couldn't confirm"). Never the server message.
 */
export function counterVoidErrorCopy(err: unknown): string {
  const code = voidErrorCode(err);
  if (Object.prototype.hasOwnProperty.call(COUNTER_VOID_ERROR_COPY, code))
    return COUNTER_VOID_ERROR_COPY[code as keyof typeof COUNTER_VOID_ERROR_COPY];
  return genericToastCopy(err);
}
