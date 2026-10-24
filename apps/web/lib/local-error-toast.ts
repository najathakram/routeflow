import { safeTextErrorCopy } from "./safe-text-error-copy";

/**
 * `meta.localErrorToast` option for a mutation hook: `true` = the caller renders every error itself;
 * a predicate = it renders only the errors it matches (the rest reach the global toast, in fixed copy).
 */
export type LocalErrorToastOption = {
  localErrorToast?: boolean | ((error: unknown) => boolean);
};

/**
 * `meta.localErrorToast` value for a mutation whose surface renders ONLY the formula-led refusal itself: the global
 * toast is skipped for that refusal and shown, in fixed copy, for every other error (never a raw message, never twice).
 */
export const localToastForSafeTextRefusal = (err: unknown): boolean =>
  safeTextErrorCopy(err) !== null;
