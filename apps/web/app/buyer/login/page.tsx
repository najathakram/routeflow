"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter, useSearchParams } from "next/navigation";
import { Input, Button, PasswordInput } from "@routeflow/ui/web";
import { BrandMark } from "@/components/brand";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { GoogleIcon, startGoogleSignIn } from "@/lib/google-oauth";
import { usePortalPresence } from "@/lib/hooks/usePortalPresence";

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
    <div className="flex min-h-screen">
      {/* Left panel — emerald gradient with branding */}
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center bg-gradient-to-br from-buyer-900 via-buyer-800 to-buyer-700 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute -top-24 -left-24 h-96 w-96 rounded-full bg-buyer-600/20" />
        <div className="absolute -bottom-16 -right-16 h-72 w-72 rounded-full bg-buyer-500/10" />
        <div className="absolute top-1/3 right-1/4 h-48 w-48 rounded-full bg-buyer-400/10" />

        <div className="relative z-10 max-w-md px-12 text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 backdrop-blur-sm p-2">
            {/* Dark surface: `bg-gradient-to-br from-buyer-900 … to-buyer-700` (B2). */}
            <BrandMark size={48} className="h-full w-full object-contain" tone="light" />
          </div>
          <h2
            style={{
              fontFamily: "var(--font-instrument-serif), serif",
              fontSize: 44,
              lineHeight: 1.08,
              letterSpacing: "-0.025em",
              color: "#fff",
              margin: 0,
              marginBottom: 16,
            }}
          >
            Order smarter with <em style={{ fontStyle: "italic", color: "#6ee7b7" }}>RouteFlow</em>.
          </h2>
          <p className="text-buyer-200 text-base leading-relaxed">
            Browse catalogs, track deliveries, and manage invoices. Your one-stop B2B ordering
            platform.
          </p>
          <div className="mt-8 flex justify-center gap-6 text-buyer-300 text-sm">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-buyer-400" />
              Easy ordering
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-buyer-400" />
              Real-time tracking
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-buyer-400" />
              Invoice management
            </div>
          </div>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex flex-1 items-center justify-center bg-surface-raised p-4 lg:p-8">
        <div className="w-full max-w-sm">
          {/* Mobile logo (hidden on large screens where left panel shows) */}
          <div className="mb-8 flex flex-col items-center gap-3 lg:hidden">
            <BrandMark size={48} />
            <h1 className="text-2xl font-bold text-navy">RouteFlow</h1>
          </div>

          {/* Desktop heading */}
          <div className="mb-6 hidden lg:block">
            <h1
              style={{
                fontFamily: "var(--font-instrument-serif), serif",
                fontSize: 34,
                letterSpacing: "-0.02em",
                color: "#0E1F36",
                margin: 0,
                lineHeight: 1.1,
              }}
            >
              Welcome back
            </h1>
            <p className="text-sm text-navy/70 mt-1">Sign in to your buyer account</p>
          </div>

          {/* Card */}
          <div className="rounded-xl bg-white p-6 shadow-card">
            <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
              {presence.op && (
                <p
                  role="status"
                  className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy"
                >
                  You&apos;re signed in to a seller dashboard.{" "}
                  <a href="/dashboard" className="text-buyer-600 hover:underline font-medium">
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
                  className="text-xs font-medium text-buyer-600 hover:underline"
                >
                  Forgot password?
                </a>
              </div>
              <Button type="submit" loading={isLoading} className="mt-2 w-full">
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
              <p className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                {googleError}
              </p>
            )}
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={googleLoading}
              className="flex w-full items-center justify-center gap-3 rounded-lg border border-surface-border bg-white px-4 py-2.5 text-sm font-medium text-navy shadow-sm transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
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
                <a
                  href={registerHref}
                  className="text-buyer-600 hover:text-buyer-700 hover:underline font-medium"
                >
                  Create account
                </a>
              </p>
            </div>
          </div>

          <div className="mt-6 text-center">
            <p className="text-xs text-navy/70">
              Selling on RouteFlow?{" "}
              <a href="/login" className="text-buyer-600 hover:underline">
                Sign in to the seller dashboard
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
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
