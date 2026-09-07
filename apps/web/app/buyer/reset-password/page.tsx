"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { PasswordInput, Button } from "@routeflow/ui/web";
import { BrandMark } from "@/components/brand";
import { buyerResetPassword } from "@/lib/buyer-auth";

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

// ─── Inner (useSearchParams requires a Suspense boundary) ─────────────────────

function BuyerResetPasswordInner() {
  const searchParams = useSearchParams();
  // F3-004: capture the single-use token once, then strip it from the visible URL
  // (history / back button / copy-paste / same-origin Referer) — it's kept in state
  // for the submit and POSTed in the body, never re-read from the URL.
  const [token] = React.useState(() => searchParams.get("token") ?? "");
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
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
      await buyerResetPassword(token, data.newPassword);
      setDone(true);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Could not reset your password. The link may have expired.";
      setApiError(typeof msg === "string" ? msg : "Could not reset your password.");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <BrandMark size={48} />
          <h1 className="text-2xl font-bold text-navy">Choose a new password</h1>
        </div>

        <div className="rounded-xl bg-white p-6 shadow-card">
          {!token ? (
            <div className="flex flex-col gap-3 text-center">
              <p className="text-sm text-navy">
                This reset link is invalid or incomplete. Request a new one to continue.
              </p>
              <Link
                href="/buyer/forgot-password"
                className="text-sm font-medium text-buyer-600 hover:underline"
              >
                Request a new reset link
              </Link>
            </div>
          ) : done ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckCircle2 className="h-8 w-8 text-buyer-600" />
              <p className="text-sm font-medium text-navy">Password updated</p>
              <p className="text-sm text-navy/70">
                All previous sessions have been signed out. Sign in with your new password.
              </p>
              <Link
                href="/buyer/login"
                className="mt-1 text-sm font-medium text-buyer-600 hover:underline"
              >
                Go to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
              {apiError && (
                <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                  {apiError}{" "}
                  <Link href="/buyer/forgot-password" className="font-medium underline">
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
              <Button type="submit" loading={isSubmitting} className="mt-2 w-full">
                Set new password
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerResetPasswordPage() {
  return (
    <React.Suspense fallback={null}>
      <BuyerResetPasswordInner />
    </React.Suspense>
  );
}
