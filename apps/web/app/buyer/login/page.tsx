"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { Input, Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";

// ─── Schema ───────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// ─── Inline Google icon (no external requests) ────────────────────────────────
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

// ─── Inner page (uses useSearchParams — must be wrapped in Suspense) ──────────

function BuyerLoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { login, isAuthenticated } = useBuyerAuth();
  const [isLoading, setIsLoading] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [googleError, setGoogleError] = React.useState<string | null>(null);

  // Validate redirect — only allow paths within /buyer/ to prevent open-redirect
  const rawRedirect = params.get("redirect");
  const redirect = rawRedirect?.startsWith("/buyer/") ? rawRedirect : null;

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

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
    try {
      const res = await fetch(`${apiUrl}/auth/google?context=buyer-standalone`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setGoogleError(
          res.status === 503
            ? ((body as { message?: string }).message ?? "Google sign-in is not available right now.")
            : "Google sign-in is unavailable. Please use email and password instead.",
        );
        setGoogleLoading(false);
        return;
      }
      const data = await res.json();
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No URL returned");
      }
    } catch {
      setGoogleError("Google sign-in is unavailable. Please use email and password instead.");
      setGoogleLoading(false);
    }
  };

  const registerHref = redirect
    ? `/buyer/register?redirect=${encodeURIComponent(redirect)}`
    : "/buyer/register";

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white"
            style={{ backgroundColor: "#3B82F6" }}
          >
            RF
          </div>
          <h1 className="text-2xl font-bold text-navy">RouteFlow</h1>
          <p className="text-sm text-navy/60">Sign in to Buyer Portal</p>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white p-6 shadow-card">
          {/* Google sign-in button */}
          {googleError && (
            <p className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {googleError}
            </p>
          )}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={googleLoading}
            className="mb-4 flex w-full items-center justify-center gap-3 rounded border border-surface-border bg-white px-4 py-2.5 text-sm font-medium text-navy shadow-sm transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {googleLoading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-navy/30 border-t-navy/70" />
                <span>Redirecting to Google…</span>
              </>
            ) : (
              <>
                <GoogleIcon className="h-4 w-4" />
                <span>Continue with Google</span>
              </>
            )}
          </button>

          {/* Divider */}
          <div className="mb-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-surface-border" />
            <span className="text-xs text-navy/40">or</span>
            <div className="h-px flex-1 bg-surface-border" />
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
            {apiError && (
              <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                {apiError}
              </p>
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
            <div className="flex flex-col gap-1">
              <label htmlFor="buyer-password" className="text-sm font-medium text-navy">
                Password
              </label>
              <div className="relative">
                <input
                  id="buyer-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/40 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSubmit(onSubmit)();
                    }
                  }}
                  {...register("password")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-navy/40 hover:text-navy transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.password && (
                <p className="text-xs text-danger">{errors.password.message}</p>
              )}
            </div>
            <Button type="submit" loading={isLoading} className="mt-2 w-full">
              Sign in
            </Button>
          </form>

          <div className="mt-4 text-center">
            <p className="text-sm text-navy/60">
              Don&apos;t have an account?{" "}
              <a href={registerHref} className="text-brand-600 hover:underline font-medium">
                Create account
              </a>
            </p>
          </div>
        </div>

        <div className="mt-6 text-center">
          <p className="text-xs text-navy/50">
            Staff member?{" "}
            <a href="/login" className="text-brand-600 hover:underline">
              Sign in to Staff Portal
            </a>
          </p>
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
