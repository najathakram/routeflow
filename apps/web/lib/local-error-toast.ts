/**
 * `meta.localErrorToast` option for a mutation hook: `true` = the caller renders every error itself;
 * a predicate = it renders only the errors it matches (the rest reach the global toast, in fixed copy).
 */
export type LocalErrorToastOption = {
  localErrorToast?: boolean | ((error: unknown) => boolean);
};
