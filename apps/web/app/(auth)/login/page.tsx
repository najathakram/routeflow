"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { Input, Button, PasswordInput } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useTenant } from "@/components/tenant-provider";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { GoogleIcon, startGoogleSignIn } from "@/lib/google-oauth";

// ─── Schema ───────────────────────────────────────────────────────────────────

// Workspace slug rules: lowercase letters, digits, hyphens; 1–63 chars.
// Matches the API's tenant slug constraints.
const WORKSPACE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const loginSchema = z.object({
  workspace: z
    .string()
    .min(1, "Workspace is required")
    .transform((v) => v.trim().toLowerCase())
    .refine((v) => WORKSPACE_RE.test(v), "Letters, numbers, and hyphens only"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// If the page is loaded on a tenant subdomain (e.g. acme.routeflow.info),
// the workspace is implied by the URL — pre-fill and lock the field.
// On platform hosts (www.routeflow.info, app.routeflow.info, hosting-provider
// domains, localhost) the user must type which workspace they're signing into.
const PLATFORM_SUBDOMAINS = new Set([
  "www",
  "app",
  "api",
  "admin",
  "static",
  "assets",
  "mail",
  "support",
  "platform",
  "billing",
  "localhost",
]);

function getSubdomainWorkspace(): string | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  const parts = host.split(".");
  if (parts.length < 3) return null; // bare domain or localhost
  const sub = parts[0];
  if (!sub || PLATFORM_SUBDOMAINS.has(sub)) return null;
  return sub;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();
  const { login: authLogin } = useAuth();
  const { branding } = useTenant();
  const [isLoading, setIsLoading] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [googleError, setGoogleError] = React.useState<string | null>(null);
  const [throttleSeconds, setThrottleSeconds] = React.useState<number | null>(null);

  const subdomainWorkspace = React.useMemo(getSubdomainWorkspace, []);
  const showWorkspaceField = !subdomainWorkspace;

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { workspace: subdomainWorkspace ?? "" },
  });

  const workspaceValue = watch("workspace");

  // Countdown timer for throttle display
  React.useEffect(() => {
    if (!throttleSeconds || throttleSeconds <= 0) return;
    const timer = setInterval(() => {
      setThrottleSeconds((s) => {
        if (!s || s <= 1) {
          clearInterval(timer);
          return null;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [throttleSeconds]);

  const onSubmit = async (data: LoginFormValues) => {
    setIsLoading(true);
    setApiError(null);
    setThrottleSeconds(null);
    setTenantCookie(data.workspace);
    try {
      const user = await authLogin(data.username, data.password);
      if (user.forcePasswordChange) router.push("/change-password");
      else router.push("/dashboard");
    } catch (err: unknown) {
      const errObj = err as {
        response?: {
          status?: number;
          headers?: Record<string, string>;
          data?: { message?: string };
        };
      };
      if (errObj?.response?.status === 429) {
        const retryAfter = errObj.response.headers?.["retry-after"];
        if (retryAfter) {
          const seconds = Math.ceil(Number(retryAfter));
          if (!isNaN(seconds) && seconds > 0) {
            setThrottleSeconds(seconds);
            setApiError(null);
            setIsLoading(false);
            return;
          }
        }
      }
      const msg = errObj?.response?.data?.message ?? "Invalid username or password.";
      setApiError(typeof msg === "string" ? msg : "Login failed.");
      setIsLoading(false);
    }
  };

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ??
    (typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:3000/api/v1`
      : "http://localhost:3000/api/v1");

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setGoogleError(null);
    const result = await startGoogleSignIn({
      context: "staff",
      tenantSlug: workspaceValue || "",
    });
    if (result.ok) return; // navigating to Google — keep the spinner
    setGoogleError(
      result.reason === "workspace_required"
        ? "Please enter your workspace before signing in with Google."
        : result.reason === "not_configured"
          ? (result.serverMessage ?? "Google sign-in is not configured for this account.")
          : "Google sign-in is unavailable. Try again or use your username and password.",
    );
    setGoogleLoading(false);
  };

  // `apiUrl` already ends with `/api/v1`, so the upload path must NOT include
  // another `/api/v1/` — that would produce a 404 broken-image. Other pages
  // (buyer/invite, buyer/portal) correctly use `${apiUrl}/uploads/<key>`.
  //
  // Tenant branding is ONLY applied on a tenant subdomain (e.g.
  // `acme.routeflow.info/login`). On platform hosts (`www.routeflow.info`,
  // `app.routeflow.info`, localhost) this is the generic RouteFlow entry
  // point — operators here may be signing into any workspace. A stale
  // tenant-slug cookie from a previous session would otherwise leak that
  // tenant's name and logo onto the platform-level login screen.
  const useTenantBranding = !!subdomainWorkspace && !!branding?.logoKey;
  const businessName = useTenantBranding ? (branding?.businessName ?? "RouteFlow") : "RouteFlow";
  // The guarded /uploads route rejects an <img>'s unauthenticated request
  // (RF-075); the public logo endpoint streams the same file with no auth.
  const logoUrl = useTenantBranding
    ? `${apiUrl}/public/tenants/${encodeURIComponent(subdomainWorkspace!)}/logo`
    : null;

  return (
    <div
      className="flex min-h-screen"
      style={{ background: "#FAF6EE" /* cream — matches marketing site */ }}
    >
      {/* Left panel — deep-teal gradient with brand & value-prop. Hidden < lg. */}
      <div
        className="relative hidden lg:flex lg:w-1/2 items-center justify-center overflow-hidden"
        style={{ background: "linear-gradient(155deg, #0E1F36 0%, #073F3D 60%, #0B6E6B 100%)" }}
      >
        {/* Decorative glow */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -160,
            right: -120,
            width: 460,
            height: 460,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(125,220,216,0.45), rgba(20,163,159,0) 65%)",
            filter: "blur(20px)",
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.18,
            backgroundImage:
              "linear-gradient(to right, rgba(125,220,216,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(125,220,216,0.5) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
            maskImage: "radial-gradient(ellipse at top right, black, transparent 65%)",
            WebkitMaskImage: "radial-gradient(ellipse at top right, black, transparent 65%)",
          }}
        />

        <div className="relative z-10 max-w-md px-12">
          <Link
            href="/"
            className="mb-12 inline-flex items-center gap-2 text-sm transition-colors"
            style={{ color: "rgba(250,246,238,0.75)" }}
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to home
          </Link>

          {/* RouteFlow LogoLoop — dark-background variant. The shared
              /logo.svg asset is the light-bg version (ink + teal on transparent),
              which would render with poor contrast against this panel's
              #0E1F36 gradient. Cream arc + teal accent + cream-filled origin +
              teal-ringed ink destination match the design's `dark` tone. */}
          <svg
            width={48}
            height={48}
            viewBox="0 0 64 64"
            fill="none"
            aria-label="RouteFlow"
            role="img"
            className="mb-8"
          >
            <path
              d="M 14 14 C 40 10, 56 24, 50 50"
              stroke="#FAF6EE"
              strokeWidth="3.2"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M 14 14 C 8 40, 24 54, 50 50"
              stroke="#14a39f"
              strokeWidth="3.2"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="14" cy="14" r="5.5" fill="#FAF6EE" />
            <circle cx="50" cy="50" r="5.5" fill="#0E1F36" stroke="#14a39f" strokeWidth="3" />
          </svg>

          <h2
            style={{
              fontFamily: "var(--font-instrument-serif), serif",
              fontSize: 56,
              lineHeight: 1.05,
              letterSpacing: "-0.025em",
              color: "#FAF6EE",
              margin: 0,
            }}
          >
            Welcome back to <em style={{ fontStyle: "italic", color: "#7DDCD8" }}>RouteFlow</em>.
          </h2>
          <p className="mt-6 text-base leading-relaxed" style={{ color: "rgba(250,246,238,0.7)" }}>
            Sign in to your wholesale operations dashboard. Manage orders, routes, drivers, invoices
            and customers — all on one rail.
          </p>

          <ul className="mt-10 space-y-4">
            {[
              "Live driver tracking & route optimisation",
              "Auto-invoicing the moment a delivery is signed off",
              "Real-time P&L by route, van and customer",
            ].map((item) => (
              <li
                key={item}
                className="flex items-start gap-3 text-sm"
                style={{ color: "rgba(250,246,238,0.85)" }}
              >
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" style={{ color: "#7DDCD8" }} />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex flex-1 items-center justify-center p-4 lg:p-8">
        <div className="w-full max-w-sm">
          {/* Mobile-only top bar (left panel is hidden on small screens) */}
          <div className="mb-6 lg:hidden">
            <Link
              href="/"
              className="mb-6 inline-flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to home
            </Link>
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logoUrl ?? "/logo.svg"}
                alt={businessName}
                className="h-10 w-10 object-contain"
              />
              <h1
                style={{
                  fontFamily: "var(--font-instrument-serif), serif",
                  fontSize: 28,
                  letterSpacing: "-0.02em",
                  color: "#0E1F36",
                  margin: 0,
                }}
              >
                {businessName}
              </h1>
            </div>
          </div>

          {/* Desktop heading inside the form column */}
          <div className="hidden lg:block mb-7">
            {logoUrl && (
              <div className="mb-4 flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoUrl}
                  alt={businessName}
                  className="h-9 w-9 rounded-lg object-contain"
                />
                <span className="text-base font-semibold text-navy">{businessName}</span>
              </div>
            )}
            <h1
              style={{
                fontFamily: "var(--font-instrument-serif), serif",
                fontSize: 36,
                letterSpacing: "-0.02em",
                color: "#0E1F36",
                margin: 0,
                lineHeight: 1.1,
              }}
            >
              Sign in
            </h1>
            <p className="mt-2 text-sm text-navy/70">Wholesaler portal — manage your operations.</p>
          </div>

          {/* Form card */}
          <div
            className="rounded-2xl p-6 shadow-card"
            style={{
              background: "#FFFFFF",
              border: "1px solid rgba(14,31,54,0.08)",
              boxShadow: "0 20px 40px -20px rgba(14,31,54,0.18)",
            }}
          >
            <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
              {throttleSeconds && throttleSeconds > 0 ? (
                <p className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
                  Too many login attempts. Try again in {throttleSeconds}{" "}
                  {throttleSeconds === 1 ? "second" : "seconds"}.
                </p>
              ) : apiError ? (
                <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{apiError}</p>
              ) : null}

              {showWorkspaceField && (
                <Input
                  label="Workspace"
                  placeholder="e.g. acme-logistics"
                  autoComplete="organization"
                  autoCapitalize="none"
                  spellCheck={false}
                  register={register("workspace")}
                  error={errors.workspace?.message}
                />
              )}
              <Input
                label="Username or email"
                placeholder="you@company.com"
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
              <PasswordInput
                id="password"
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
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-[#0B6E6B] hover:underline"
                >
                  Forgot password?
                </Link>
              </div>

              <Button
                type="submit"
                loading={isLoading}
                disabled={!!(throttleSeconds && throttleSeconds > 0)}
                className="mt-2 w-full"
              >
                Sign in <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </form>

            {/* Divider */}
            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-surface-border" />
              <span className="text-xs text-navy/70 uppercase tracking-wider">or</span>
              <div className="h-px flex-1 bg-surface-border" />
            </div>

            {googleError && (
              <p className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                {googleError}
              </p>
            )}
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={googleLoading || isLoading}
              className="flex w-full items-center justify-center gap-3 rounded-lg border border-surface-border bg-white px-4 py-2.5 text-sm font-medium text-navy shadow-sm transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
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

            <p className="mt-5 text-center text-xs text-navy/70">
              First sign-in? You&apos;ll be prompted to change your password.
            </p>
          </div>

          {/* Footer links */}
          <div className="mt-6 space-y-2 text-center">
            <p className="text-xs text-navy/70">
              Not a staff member?{" "}
              <a href="/buyer/login" className="text-[#0B6E6B] hover:underline font-medium">
                Sign in to retailer portal
              </a>
            </p>
            <p className="text-xs text-navy/70">
              New to RouteFlow?{" "}
              <a href="/signup" className="text-[#0B6E6B] hover:underline font-medium">
                Start your 14-day free trial
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
