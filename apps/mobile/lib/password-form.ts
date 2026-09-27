import { z } from "zod";
// #2429: the SUBPATH, so Jest can map it to source (the root @routeflow/types is a hand stub in
// tests; see jest.config.js).
import { passwordPolicyErrors } from "@routeflow/types/api/password-policy";

/**
 * Shared password-form logic for the set/change password screens and the
 * forgot/reset flows. Pure — no React/native imports — so it is Jest-testable.
 *
 * "set" mode is the first-password setup for Google-only accounts: the server
 * only accepts it while the account has no usable password, so the form has no
 * currentPassword field. "change" mode always demands the current password.
 */

export type PasswordMode = "set" | "change";
export type PasswordAudience = "staff" | "buyer";

export function buildPasswordSchema(mode: PasswordMode) {
  return z
    .object({
      currentPassword:
        mode === "change" ? z.string().min(1, "Current password is required") : z.string(),
      // #2429: THE server policy (@routeflow/types) — a number OR a special character, and a
      // lowercase letter; mobile used to demand a number and skip the lowercase rule.
      newPassword: z.string().superRefine((pw, ctx) => {
        for (const message of passwordPolicyErrors(pw)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        }
      }),
      confirmPassword: z.string().min(1, "Please confirm your new password"),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
      message: "Passwords do not match",
      path: ["confirmPassword"],
    });
}

export type PasswordFormValues = z.infer<ReturnType<typeof buildPasswordSchema>>;

export function passwordEndpoint(audience: PasswordAudience, mode: PasswordMode): string {
  const base = audience === "buyer" ? "/buyer/auth" : "/auth";
  return `${base}/${mode === "set" ? "set-password" : "change-password"}`;
}

export function forgotPasswordEndpoint(audience: PasswordAudience): string {
  return audience === "buyer"
    ? "/buyer/auth/request-password-reset"
    : "/auth/request-password-reset";
}

export function resetPasswordEndpoint(audience: PasswordAudience): string {
  return audience === "buyer" ? "/buyer/auth/reset-password" : "/auth/reset-password";
}

/** Route-param → audience: the forgot/reset screens serve both staff and buyers. */
export function audienceFromParam(param: string | undefined): PasswordAudience {
  return param === "buyer" ? "buyer" : "staff";
}

/** Where the post-reset "Go to sign in" button should land per audience. */
export function signInRouteFor(audience: PasswordAudience): string {
  return audience === "buyer" ? "/(auth)/customer-login" : "/(auth)/login";
}
