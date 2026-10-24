import { z } from "zod";

/**
 * The server's password policy (ChangePasswordDto / SetPasswordDto / BuyerChangePasswordDto): min 8,
 * an uppercase letter, a lowercase letter, and a digit or symbol, where an underscore counts as a
 * symbol (`[\d\W_]`, the same on the server). Every password form shows these rules as a live
 * checklist and names exactly what is missing — never a bare "Failed".
 */
export interface PasswordRule {
  id: "length" | "upper" | "lower" | "digitOrSymbol";
  /** The checklist line. */
  label: string;
  /** The words used in "Add …" when this rule is missing. */
  missing: string;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: "length",
    label: "At least 8 characters",
    missing: "at least 8 characters",
    test: (p) => p.length >= 8,
  },
  {
    id: "upper",
    label: "An uppercase letter",
    missing: "an uppercase letter",
    test: (p) => /[A-Z]/.test(p),
  },
  {
    id: "lower",
    label: "A lowercase letter",
    missing: "a lowercase letter",
    test: (p) => /[a-z]/.test(p),
  },
  {
    id: "digitOrSymbol",
    label: "A number or symbol",
    missing: "a number or symbol",
    test: (p) => /[\d\W_]/.test(p),
  },
];

export const missingRules = (password: string): PasswordRule[] =>
  PASSWORD_RULES.filter((r) => !r.test(password));

/** "a", "a and b", "a, b and c". */
const joinList = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * Exactly what is missing, as one sentence: "Add a lowercase letter.", "Add an uppercase letter and
 * a number or symbol.", "Use at least 8 characters and add an uppercase letter." `null` = all met.
 */
export function missingMessage(missing: readonly PasswordRule[]): string | null {
  if (missing.length === 0) return null;
  const tooShort = missing.some((r) => r.id === "length");
  const adds = missing.filter((r) => r.id !== "length").map((r) => r.missing);
  if (!tooShort) return `Add ${joinList(adds)}.`;
  return adds.length === 0
    ? "Use at least 8 characters."
    : `Use at least 8 characters and add ${joinList(adds)}.`;
}

/** The new-password field: one issue naming every missing rule. */
export const newPasswordSchema = z.string().superRefine((value, ctx) => {
  const message = missingMessage(missingRules(value));
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

export const PASSWORD_ERROR_FALLBACK = "Your password couldn't be changed. Try again.";

/** The full rule, for a policy refusal the client cannot narrow down. */
const ALL_RULES = "Add an uppercase letter, a lowercase letter and a number or symbol.";

// The server's messages (class-validator and the auth services), in the same per-rule words.
const FRIENDLY: [RegExp, (newPassword?: string) => string][] = [
  [
    /must contain at least one uppercase letter, one lowercase letter/i,
    (pw) => (pw !== undefined ? missingMessage(missingRules(pw)) : null) ?? ALL_RULES,
  ],
  [/must be longer than or equal to 8/i, () => "Use at least 8 characters."],
  [/^Current password is incorrect/i, () => "Current password is incorrect."],
  [
    /^New password must differ from current password/i,
    () => "Your new password must be different from your current one.",
  ],
  [
    /uses Google sign-in and has no password/i,
    () => "This account signs in with Google and has no password to change yet.",
  ],
  [
    /already has a password/i,
    () => "This account already has a password. Use Change password instead.",
  ],
];

/**
 * The API's error for a password change, in plain words. A 400 from class-validator carries
 * `message` as an ARRAY (a string-only check dropped it to "Failed"). The policy message does not
 * say which rule failed, so it is narrowed with the password that was sent. B986: the server's text
 * is only LOOKED UP here, never rendered; a message this table does not know falls back, and the
 * fallback says to try again.
 */
export function passwordErrorMessage(
  err: unknown,
  newPassword?: string,
  fallback: string = PASSWORD_ERROR_FALLBACK,
): string {
  const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  const parts = (Array.isArray(msg) ? msg : [msg])
    .filter((m): m is string => typeof m === "string" && m.trim() !== "")
    .map((m) => FRIENDLY.find(([re]) => re.test(m))?.[1](newPassword))
    .filter((m): m is string => m !== undefined);
  if (parts.length === 0) return fallback;
  const unique = [...new Set(parts)];
  const end = /[.!?]$/.test(unique[unique.length - 1]) ? "." : "";
  return unique.map((p) => p.replace(/[.!?]$/, "")).join(". ") + end;
}
