"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter, useSearchParams } from "next/navigation";
import { Input, Button, PasswordInput } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { GoogleIcon, startGoogleSignIn } from "@/lib/google-oauth";
import { usePortalPresence } from "@/lib/hooks/usePortalPresence";
import { AuthShell } from "@/components/auth";

// ─── Schema ───────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// ─── Inner page (uses useSearchParams — must be wrapped in Suspense) ──────────

function BuyerLoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { login, isAuthenticated } = useBuyerAuth();
  const presence = usePortalPresence();
  const [isLoading, setIsLoading] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [googleError, setGoogleError] = React.useState<string | null>(null);

  // Validate redirect: must be a relative path within /buyer/ and cannot contain
  // protocol markers, double-dots, or double-slashes that could escape the path.
  const rawRedirect = params.get("redirect");
  const redirect = (() => {
    if (!rawRedirect) return null;
    if (!rawRedirect.startsWith("/buyer/")) return null;
    // Block path traversal (/../), protocol injection (://), and double-slash (//)
    if (/\.\.|:\/\/|\/\//.test(rawRedirect)) return null;
    return rawRedirect;
  })();

  // If already authenticated, redirect to portal or the requested page
  React.useEffect(() => {
    if (isAuthenticated) {
      router.push(redirect ?? "/buyer/portal");
    }
  }, [isAuthenticated, router, redirect]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormValues) => {
    setIsLoading(true);
    setApiError(null);
    try {
      await login(data.email, data.password);
      router.push(redirect ?? "/buyer/portal");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Invalid email or password.";
      setApiError(typeof msg === "string" ? msg : "Login failed.");
      setIsLoading(false);
    }
  };

  // Standalone Google sign-in — no seller context required
  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setGoogleError(null);
    const result = await startGoogleSignIn({ context: "buyer-standalone" });
    if (result.ok) return; // navigating to Google — keep the spinner
    setGoogleError(
      result.reason === "not_configured"
        ? (result.serverMessage ?? "Google sign-in is not available right now.")
        : "Google sign-in is unavailable. Please use email and password instead.",
    );
    setGoogleLoading(false);
  };

  const registerHref = redirect
    ? `/buyer/register?redirect=${encodeURIComponent(redirect)}`
    : "/buyer/register";

  return (
    <AuthShell
      audience="retailer"
      kicker="Retailer account"
      title="Welcome back."
      lead="Sign in to order from your suppliers."
      footer={
        <p className="text-xs text-navy/70">
          Selling on RouteFlow?{" "}
          <a href="/login" className="text-[#0B6E6B] hover:underline">
            Sign in to the seller dashboard
          </a>
        </p>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {presence.op && (
          <p
            role="status"
            className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy"
          >
            You&apos;re signed in to a seller dashboard.{" "}
            <a href="/dashboard" className="text-[#0B6E6B] hover:underline font-medium">
              Go to seller dashboard
            </a>
          </p>
        )}

        {apiError && (
          <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{apiError}</p>
        )}
        <Input
          label="Email"
          type="email"
          placeholder="Enter your email"
          autoComplete="email"
          register={register("email")}
          error={errors.email?.message}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              document.getElementById("buyer-password")?.focus();
            }
          }}
        />
        <PasswordInput
          id="buyer-password"
          label="Password"
          placeholder="Enter your password"
          autoComplete="current-password"
          className="rounded-lg"
          register={register("password")}
          error={errors.password?.message}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit(onSubmit)();
            }
          }}
        />
        <div className="-mt-2 text-right">
          <a
            href="/buyer/forgot-password"
            className="text-xs font-medium text-[#0B6E6B] hover:underline"
          >
            Forgot password?
          </a>
        </div>
        <Button type="submit" loading={isLoading} className="rf-btn mt-2 w-full">
          Sign in
        </Button>
      </form>

      {/* Divider */}
      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-surface-border" />
        <span className="text-xs text-navy/70">or</span>
        <div className="h-px flex-1 bg-surface-border" />
      </div>

      {/* Google sign-in button */}
      {googleError && (
        <p className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{googleError}</p>
      )}
      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={googleLoading}
        className="rf-btn secondary flex w-full items-center justify-center gap-3"
      >
        {googleLoading ? (
          <>
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-navy/30 border-t-navy/70" />
            <span>Redirecting to Google...</span>
          </>
        ) : (
          <>
            <GoogleIcon className="h-4 w-4" />
            <span>Continue with Google</span>
          </>
        )}
      </button>

      <div className="mt-4 text-center">
        <p className="text-sm text-navy/70">
          Don&apos;t have an account?{" "}
          <a href={registerHref} className="text-[#0B6E6B] hover:underline font-medium">
            Create account
          </a>
        </p>
      </div>
    </AuthShell>
  );
}

// ─── Page (Suspense required for useSearchParams) ─────────────────────────────

export default function BuyerLoginPage() {
  return (
    <React.Suspense fallback={null}>
      <BuyerLoginInner />
    </React.Suspense>
  );
}
