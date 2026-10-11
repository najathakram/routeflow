"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { PasswordInput, Button } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { AuthShell } from "@/components/auth";
import { useAccountLinkToken } from "@/lib/account-link-token";

// ─── Schema (matches the API's complexity policy) ─────────────────────────────

const schema = z
  .object({
    newPassword: z
      .string()
      .min(8, "At least 8 characters")
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/,
        "Must include an uppercase letter, a lowercase letter, and a number or symbol",
      ),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof schema>;

// Fixed copy only: a failed reset never shows server text.
const RESET_FAILED_COPY = "Could not reset your password. The link may have expired.";

function ResetPasswordInner() {
  // The single-use token arrives in the URL fragment (`#t=`; legacy `?token=` for links emailed
  // before the change). It is read once, scrubbed from the address bar, kept in memory and
  // POSTed in the body — never re-read from the URL, never logged.
  const { token, ready } = useAccountLinkToken("staffReset");
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    setApiError(null);
    try {
      await apiClient.post("/auth/reset-password", { token, newPassword: data.newPassword });
      setDone(true);
    } catch {
      setApiError(RESET_FAILED_COPY);
    }
  };

  if (!ready) return null;

  return (
    <AuthShell audience="distributor" kicker="Distributor workspace" title="Choose a new password">
      {!token ? (
        <div className="flex flex-col gap-3 text-center">
          <p className="text-sm text-navy">
            This reset link is invalid or incomplete. Request a new one to continue.
          </p>
          <Link
            href="/forgot-password"
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            Request a new reset link
          </Link>
        </div>
      ) : done ? (
        <div className="rf-auth-success flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="h-8 w-8 text-brand-500" />
          <p className="text-sm font-medium text-navy">Password updated</p>
          <p className="text-sm text-navy/70">
            All previous sessions have been signed out. Sign in with your new password.
          </p>
          <Link href="/login" className="mt-1 text-sm font-medium text-brand-600 hover:underline">
            Go to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
          {apiError && (
            <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {apiError}{" "}
              <Link href="/forgot-password" className="font-medium underline">
                Request a new link
              </Link>
            </p>
          )}
          <PasswordInput
            label="New password"
            autoComplete="new-password"
            register={register("newPassword")}
            error={errors.newPassword?.message}
          />
          <PasswordInput
            label="Confirm new password"
            autoComplete="new-password"
            register={register("confirmPassword")}
            error={errors.confirmPassword?.message}
          />
          <Button type="submit" loading={isSubmitting} className="rf-btn mt-2 w-full">
            Set new password
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ResetPasswordPage() {
  return <ResetPasswordInner />;
}
