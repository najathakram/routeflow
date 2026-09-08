"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Input, Button, PasswordInput } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useTenant } from "@/components/tenant-provider";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { GoogleIcon, startGoogleSignIn } from "@/lib/google-oauth";
import { tenantSlugFromHostname } from "@/lib/tenant-host";
import { safeOperatorRedirect } from "@/lib/portal-routing";
import { usePortalPresence } from "@/lib/hooks/usePortalPresence";
import { AuthShell } from "@/components/auth";

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
// Delegates to `@/lib/tenant-host`, which the middleware uses too. This function
// used to carry its OWN copy of the host rules and that copy had drifted: it was
// missing the hosting-provider guard, so on `*.up.railway.app` it returned the
// SERVICE name ("routeflowweb-production") as a tenant slug. That hid the
// Workspace field and made the submit handler below write a nonexistent slug into
// the tenant-slug cookie — form login was impossible on the Railway fallback URL.
// Keep both callers on the shared helper; never re-inline these rules.
function getSubdomainWorkspace(): string | null {
  if (typeof window === "undefined") return null;
  return tenantSlugFromHostname(window.location.hostname);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();
  const { login: authLogin } = useAuth();
  const presence = usePortalPresence();
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
      // Read at submit time (not via useSearchParams) so /login keeps prerendering its form — a Suspense boundary here would blank the whole page until hydration.
      const redirectTarget = safeOperatorRedirect(
        new URLSearchParams(window.location.search).get("redirect"),
      );
      if (user.forcePasswordChange) router.push("/change-password");
      else router.push(redirectTarget);
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
    <AuthShell
      audience="distributor"
      kicker="Distributor workspace"
      title="Welcome back."
      lead="Sign in to your distributor workspace."
      logoUrl={logoUrl}
      logoAlt={businessName}
      footer={
        <>
          <p className="text-xs text-navy/70">
            Buying from a seller?{" "}
            <a href="/buyer/login" className="text-[#0B6E6B] hover:underline font-medium">
              Sign in to the buyer portal
            </a>
          </p>
          <p className="text-xs text-navy/70">
            New to RouteFlow?{" "}
            <a href="/signup" className="text-[#0B6E6B] hover:underline font-medium">
              Start your 14-day free trial
            </a>
          </p>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {presence.buyer && (
          <p
            role="status"
            className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy"
          >
            You&apos;re signed in to the buyer portal.{" "}
            <a href="/buyer/portal" className="text-[#0B6E6B] hover:underline font-medium">
              Go to buyer portal
            </a>
          </p>
        )}

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
          className="rf-btn mt-2 w-full"
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
        <p className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{googleError}</p>
      )}
      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={googleLoading || isLoading}
        className="rf-btn secondary flex w-full items-center justify-center gap-3"
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
    </AuthShell>
  );
}
