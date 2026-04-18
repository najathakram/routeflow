"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, ArrowLeft } from "lucide-react";
import { Input, Button } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useTenant } from "@/components/tenant-provider";

// ─── Schema ───────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// ─── Google Icon ──────────────────────────────────────────────────────────────

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();
  const { login: authLogin } = useAuth();
  const { branding, slug: tenantSlug } = useTenant();
  const [isLoading, setIsLoading] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [googleError, setGoogleError] = React.useState<string | null>(null);

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
      const user = await authLogin(data.username, data.password);
      if (user.forcePasswordChange) {
        router.push("/change-password");
      } else {
        router.push("/dashboard");
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Invalid username or password.";
      setApiError(typeof msg === "string" ? msg : "Login failed.");
      setIsLoading(false);
    }
  };

  // Base URL including /api/v1 prefix — used for constructing OAuth redirect URLs
  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ??
    (typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:3000/api/v1`
      : "http://localhost:3000/api/v1");

  // Fetch the Google OAuth URL from the backend, then redirect the browser to it.
  // Uses the new query-param endpoint (not the legacy path-param variant).
  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setGoogleError(null);
    try {
      const params = new URLSearchParams({ context: "staff" });
      if (tenantSlug) params.set("tenant", tenantSlug);
      const res = await fetch(`${apiUrl}/auth/google?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setGoogleError(
          res.status === 503
            ? (body.message ?? "Google sign-in is not configured for this account.")
            : "Google sign-in is unavailable. Try again or use your username and password.",
        );
        setGoogleLoading(false);
        return;
      }
      const data = await res.json();
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No URL in response");
      }
    } catch {
      setGoogleError("Google sign-in is unavailable. Try again or use your username and password.");
      setGoogleLoading(false);
    }
  };

  // Show the tenant's business name if they have custom branding (logo uploaded),
  // otherwise show the product name "RouteFlow". This prevents migration artifacts
  // like "RouteFlow Legacy" from appearing for tenants without custom branding.
  const hasCustomBranding = branding?.logoKey;
  const businessName = hasCustomBranding ? (branding?.businessName ?? "RouteFlow") : "RouteFlow";
  const logoUrl = branding?.logoKey
    ? `${apiUrl}/api/v1/uploads/${branding.logoKey}`
    : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        {/* Back to home */}
        <a
          href="/"
          className="mb-6 flex items-center gap-1.5 text-sm text-navy/50 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Home
        </a>

        {/* Logo / Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={businessName}
              className="h-12 w-12 rounded-xl object-contain"
            />
          ) : (
            <img
              src="/logo.svg"
              alt={businessName}
              className="h-12 w-12 object-contain"
            />
          )}
          <h1 className="text-2xl font-bold text-navy">{businessName}</h1>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-600">
              Staff Portal
            </span>
          </div>
          <p className="text-sm text-navy/60">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white p-6 shadow-card">
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
            {apiError && (
              <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                {apiError}
              </p>
            )}
            <Input
              label="Username or Email"
              placeholder="Enter your username or email"
              autoComplete="username"
              register={register("username")}
              error={errors.username?.message}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  document.getElementById("password")?.focus();
                }
              }}
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="password" className="text-sm font-medium text-navy">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
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

          {/* Divider */}
          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-surface-border" />
            <span className="text-xs text-navy/40">or</span>
            <div className="h-px flex-1 bg-surface-border" />
          </div>

          {/* Google Sign-In */}
          {googleError && (
            <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {googleError}
            </p>
          )}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={googleLoading || isLoading}
            className="flex w-full items-center justify-center gap-3 rounded border border-surface-border bg-white px-4 py-2.5 text-sm font-medium text-navy shadow-sm transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {googleLoading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-navy/30 border-t-navy/70" />
                <span>Redirecting to Google…</span>
              </>
            ) : (
              <>
                <GoogleIcon className="h-4 w-4" />
                <span>Sign in with Google</span>
              </>
            )}
          </button>

          <p className="mt-4 text-center text-xs text-navy/50">
            First login? You will be prompted to change your password.
          </p>
        </div>

        <div className="mt-6 space-y-2 text-center">
          <p className="text-xs text-navy/50">
            Not a staff member?{" "}
            <a href="/buyer/login" className="text-brand-600 hover:underline">
              Sign in to Buyer Portal
            </a>
          </p>
          <p className="text-xs text-navy/50">
            New to RouteFlow?{" "}
            <a href="/signup" className="text-brand-600 hover:underline font-medium">
              Start your free 14-day trial
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
