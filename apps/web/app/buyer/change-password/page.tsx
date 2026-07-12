"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, KeyRound } from "lucide-react";
import { PasswordInput, Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  buyerChangePassword,
  buyerSetPassword,
  getBuyerProfile,
  type BuyerProfile,
} from "@/lib/buyer-auth";
import { BUYER_KEYS } from "@/lib/auth-keys";

// ─── Schema ───────────────────────────────────────────────────────────────────

// currentPassword is validated conditionally in onSubmit — set mode (Google
// accounts with no password yet) hides the field entirely.
const schema = z
  .object({
    currentPassword: z.string(),
    // Mirrors the server policy (BuyerChangePasswordDto): upper + lower + digit-or-special.
    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain at least one uppercase letter")
      .regex(/[a-z]/, "Must contain at least one lowercase letter")
      .regex(/[\d\W]/, "Must contain at least one number or special character"),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof schema>;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerChangePasswordPage() {
  const router = useRouter();
  const { buyer, isLoading, isAuthenticated } = useBuyerAuth();
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [profile, setProfile] = React.useState<BuyerProfile | null>(null);

  const accessToken =
    typeof window !== "undefined" ? localStorage.getItem(BUYER_KEYS.accessToken) : null;

  // Redirect if not authenticated
  React.useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/buyer/login");
    }
  }, [isLoading, isAuthenticated, router]);

  // Authoritative hasPassword read — the JWT copy goes stale after a set/reset.
  React.useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    getBuyerProfile(accessToken)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        // Older API or transient failure → keep change mode (safe default).
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  // false ONLY when the server confirms this is a Google-created account with
  // no usable password — then we offer "set a password" without a current one.
  const hasPassword = profile?.hasPassword ?? true;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const onSubmit = async (data: FormValues) => {
    setApiError(null);
    if (!accessToken) {
      setApiError("You are not logged in. Please sign in again.");
      return;
    }
    if (hasPassword && !data.currentPassword) {
      setApiError("Current password is required.");
      return;
    }
    try {
      if (hasPassword) {
        await buyerChangePassword(data.currentPassword, data.newPassword, accessToken);
      } else {
        await buyerSetPassword(data.newPassword, accessToken);
      }
      setSuccess(true);
      reset();
      // Return to portal after a short delay
      setTimeout(() => router.push("/buyer/portal"), 2000);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to change password. Please check your current password and try again.";
      setApiError(typeof msg === "string" ? msg : "Failed to change password.");
    }
  };

  if (isLoading || !isAuthenticated) return null;

  const isGoogleOnlyHint =
    hasPassword &&
    (apiError?.toLowerCase().includes("current password") ||
      apiError?.toLowerCase().includes("incorrect"));

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-buyer.svg" alt="RouteFlow" className="h-12 w-12 object-contain" />
          <h1 className="text-2xl font-bold text-navy">
            {hasPassword ? "Change Password" : "Set a Password"}
          </h1>
          <p className="text-center text-sm text-navy/70">
            {!hasPassword
              ? "You sign in with Google. Add a password to also sign in with your email."
              : buyer?.email
                ? `Updating password for ${buyer.email}`
                : "Update your buyer portal password"}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white p-6 shadow-card">
          {/* Success state */}
          {success ? (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                <KeyRound className="h-6 w-6 text-success" />
              </div>
              <div>
                <p className="font-semibold text-navy">
                  {hasPassword ? "Password changed successfully!" : "Password set successfully!"}
                </p>
                <p className="mt-1 text-sm text-navy/70">Redirecting you to the portal…</p>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
              {apiError && (
                <div className="rounded-lg bg-danger-bg px-3 py-2">
                  <p className="text-sm text-danger">{apiError}</p>
                  {isGoogleOnlyHint && (
                    <p className="mt-1 text-xs text-danger/80">
                      If you signed up with Google and never set a password, use{" "}
                      <Link href="/buyer/forgot-password" className="underline">
                        forgot password
                      </Link>{" "}
                      to create one.
                    </p>
                  )}
                </div>
              )}
              {hasPassword && (
                <PasswordInput
                  label="Current password"
                  autoComplete="current-password"
                  register={register("currentPassword")}
                  error={errors.currentPassword?.message}
                />
              )}
              <PasswordInput
                label="New password"
                autoComplete="new-password"
                register={register("newPassword")}
                error={errors.newPassword?.message}
              />
              <p className="text-xs text-navy/70">
                At least 8 characters, with upper and lower case and a number or symbol.
              </p>
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

        {/* Back link */}
        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center gap-1.5 text-xs text-navy/70 hover:text-navy transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}
