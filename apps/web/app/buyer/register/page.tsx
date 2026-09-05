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

const registerSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters"),
    email: z.string().email("Please enter a valid email address"),
    // Mirrors the server policy (BuyerRegisterDto): upper + lower + digit-or-special.
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[\d\W]/, "Password must contain at least one number or special character"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type RegisterFormValues = z.infer<typeof registerSchema>;

// ─── Inline Google icon (no external requests) ────────────────────────────────
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

// ─── Inner page (uses useSearchParams — must be wrapped in Suspense) ──────────

function BuyerRegisterInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { register: registerBuyer, isAuthenticated } = useBuyerAuth();
  const [isLoading, setIsLoading] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [googleError, setGoogleError] = React.useState<string | null>(null);

  // Validate redirect: must be a relative path within /buyer/ and cannot contain
  // protocol markers, double-dots, or double-slashes that could escape the path.
  const rawRedirect = params.get("redirect");
  const redirect = (() => {
    if (!rawRedirect) return null;
    if (!rawRedirect.startsWith("/buyer/")) return null;
    if (/\.\.|:\/\/|\/\//.test(rawRedirect)) return null;
    return rawRedirect;
  })();

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
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = async (data: RegisterFormValues) => {
    setIsLoading(true);
    setApiError(null);
    try {
      await registerBuyer(data.email, data.password, data.name);
      router.push(redirect ?? "/buyer/portal");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Registration failed. Please try again.";
      setApiError(typeof msg === "string" ? msg : "Registration failed.");
      setIsLoading(false);
    }
  };

  // Standalone Google sign-up — no seller context required
  const handleGoogleSignUp = async () => {
    setGoogleLoading(true);
    setGoogleError(null);
    try {
      const res = await fetch(`${apiUrl}/auth/google?context=buyer-standalone`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setGoogleError(
          res.status === 503
            ? ((body as { message?: string }).message ??
                "Google sign-in is not available right now.")
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

  const loginHref = redirect
    ? `/buyer/login?redirect=${encodeURIComponent(redirect)}`
    : "/buyer/login";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-buyer-50 to-white p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <img src="/logo-buyer.svg" alt="RouteFlow" className="h-12 w-12 object-contain" />
          <h1 className="text-2xl font-bold text-navy">Create Account</h1>
          <p className="text-sm text-navy/70">Join RouteFlow Buyer Portal</p>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white p-6 shadow-card">
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
            {apiError && (
              <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{apiError}</p>
            )}

            <Input
              label="Full Name"
              type="text"
              placeholder="Enter your full name"
              autoComplete="name"
              register={register("name")}
              error={errors.name?.message}
            />

            <Input
              label="Email"
              type="email"
              placeholder="Enter your email"
              autoComplete="email"
              register={register("email")}
              error={errors.email?.message}
            />

            <div className="flex flex-col gap-1">
              <label htmlFor="buyer-password" className="text-sm font-medium text-navy">
                Password
              </label>
              <div className="relative">
                <input
                  id="buyer-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="8+ chars, upper & lower case, number or symbol"
                  autoComplete="new-password"
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/70 transition-colors focus:outline-none focus:ring-2 focus:ring-buyer-500 focus:border-transparent"
                  {...register("password")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-navy/70 hover:text-navy transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.password && <p className="text-xs text-danger">{errors.password.message}</p>}
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="buyer-confirm-password" className="text-sm font-medium text-navy">
                Confirm Password
              </label>
              <div className="relative">
                <input
                  id="buyer-confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  placeholder="Re-enter your password"
                  autoComplete="new-password"
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/70 transition-colors focus:outline-none focus:ring-2 focus:ring-buyer-500 focus:border-transparent"
                  {...register("confirmPassword")}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-navy/70 hover:text-navy transition-colors"
                  tabIndex={-1}
                  aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {errors.confirmPassword && (
                <p className="text-xs text-danger">{errors.confirmPassword.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="mt-2 flex h-10 w-full items-center justify-center rounded-lg bg-buyer-600 text-sm font-semibold text-white transition-colors hover:bg-buyer-700 focus:outline-none focus:ring-2 focus:ring-buyer-500 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                "Create Account"
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-surface-border" />
            <span className="text-xs text-navy/70">or</span>
            <div className="h-px flex-1 bg-surface-border" />
          </div>

          {/* Google sign-up button */}
          {googleError && (
            <p className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {googleError}
            </p>
          )}
          <button
            type="button"
            onClick={handleGoogleSignUp}
            disabled={googleLoading}
            className="flex w-full items-center justify-center gap-3 rounded border border-surface-border bg-white px-4 py-2.5 text-sm font-medium text-navy shadow-sm transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-buyer-500 disabled:cursor-not-allowed disabled:opacity-60"
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
              Already have an account?{" "}
              <a href={loginHref} className="text-buyer-600 hover:underline font-medium">
                Sign in
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
  );
}

// ─── Page (Suspense required for useSearchParams) ─────────────────────────────

export default function BuyerRegisterPage() {
  return (
    <React.Suspense fallback={null}>
      <BuyerRegisterInner />
    </React.Suspense>
  );
}
