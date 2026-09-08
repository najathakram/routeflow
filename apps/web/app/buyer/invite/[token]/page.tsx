"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Building2, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { AuthShell } from "@/components/auth";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { getInviteDetails, acceptInvite, getBuyerAccessToken } from "@/lib/buyer-auth";

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

interface InviteDetails {
  name: string;
  slug: string;
  logoKey: string | null;
}

export default function BuyerInvitePage() {
  const params = useParams();
  const router = useRouter();
  const { buyer, isLoading: authLoading, isAuthenticated, refreshSellers } = useBuyerAuth();
  const token = params.token as string;

  const [invite, setInvite] = React.useState<InviteDetails | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoadingInvite, setIsLoadingInvite] = React.useState(true);
  const [isAccepting, setIsAccepting] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  const [acceptError, setAcceptError] = React.useState<string | null>(null);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [googleError, setGoogleError] = React.useState<string | null>(null);

  // Load invite details (public endpoint)
  React.useEffect(() => {
    if (!token) return;
    setIsLoadingInvite(true);
    getInviteDetails(token)
      .then((data) => {
        setInvite(data);
      })
      .catch((err) => {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "This invite link is invalid or has expired.";
        setLoadError(typeof msg === "string" ? msg : "Invalid invite link.");
      })
      .finally(() => setIsLoadingInvite(false));
  }, [token]);

  const handleAccept = async () => {
    if (!isAuthenticated) return;
    // A5: read through the canonical accessor — this used to read the legacy
    // "buyerAccessToken" literal, which password logins never write, so the
    // Accept button silently did nothing for email/password buyers.
    const accessToken = getBuyerAccessToken();
    if (!accessToken) {
      setAcceptError("Your session has expired — please sign in again.");
      return;
    }

    setIsAccepting(true);
    setAcceptError(null);
    try {
      await acceptInvite(token, accessToken);
      // Re-pull the roster into the shared context BEFORE landing on the
      // portal: register→accept→portal is all soft navigation under one
      // BuyerAuthProvider, whose sellers list was seeded [] at registration —
      // without this the freshly-linked buyer lands on "No sellers connected
      // yet" until a hard reload (e2e BSD-01 caught it).
      await refreshSellers().catch(() => {});
      setAccepted(true);
      // Redirect to portal with linked=true so the banner fires
      setTimeout(() => {
        router.push("/buyer/portal?linked=true");
      }, 1500);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to accept invite. Please try again.";
      setAcceptError(typeof msg === "string" ? msg : "Failed to accept invite.");
    } finally {
      setIsAccepting(false);
    }
  };

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  // Google Sign-In with invite token embedded in OAuth state.
  // The backend reads invite_token from state, accepts the CustomerLink, and
  // redirects to /auth/google/callback?linked=true on success.
  const handleGoogleSignIn = async () => {
    if (!invite?.slug) return;
    setGoogleLoading(true);
    setGoogleError(null);
    try {
      const qs = new URLSearchParams({
        tenant: invite.slug,
        context: "portal",
        invite_token: token,
      });
      const res = await fetch(`${apiUrl}/auth/google?${qs}`);
      if (!res.ok) throw new Error("Request failed");
      const data = await res.json();
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No URL returned");
      }
    } catch {
      setGoogleError("Google sign-in is unavailable. Please use email/password instead.");
      setGoogleLoading(false);
    }
  };

  // The shell owns the page heading: it announces the state the card is showing,
  // exactly as the old page's own per-state heading did (MED-1); the branch order mirrors the
  // `content` chain below so the heading can never describe a different state.
  const title =
    isLoadingInvite || authLoading
      ? "You're invited."
      : loadError
        ? "Invalid Invite"
        : accepted
          ? "Invite Accepted!"
          : "You're invited.";

  let content: React.ReactNode;
  if (isLoadingInvite || authLoading) {
    content = (
      <div className="flex justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  } else if (loadError) {
    content = (
      <div className="text-center">
        <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" />
        <p className="text-sm text-navy/70 mb-6">{loadError}</p>
        <a href="/buyer/portal" className="text-[#0B6E6B] hover:underline text-sm">
          Go to Buyer Portal
        </a>
      </div>
    );
  } else if (accepted) {
    content = (
      <div className="rf-auth-success text-center">
        <CheckCircle className="mx-auto mb-4 h-12 w-12 text-success" />
        <p className="text-sm text-navy/70">
          You are now connected to <strong>{invite?.name}</strong>. Redirecting to your portal...
        </p>
      </div>
    );
  } else {
    content = (
      <>
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {invite?.logoKey ? (
            /* Guarded /uploads needs auth an <img> can't send — use the
               public streaming endpoint (same fix as the portal SellerCard). */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${apiUrl}/public/tenants/${encodeURIComponent(invite.slug)}/logo`}
              alt={invite.name}
              className="h-16 w-16 rounded-xl object-contain border border-surface-border"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-surface-raised border border-surface-border">
              <Building2 className="h-8 w-8 text-navy/70" />
            </div>
          )}
          <div>
            <p className="text-xs text-navy/70 uppercase tracking-wide mb-1">
              You have been invited by
            </p>
            <h2 className="text-xl font-bold text-navy">{invite?.name}</h2>
          </div>
        </div>

        {acceptError && (
          <p className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
            {acceptError}
          </p>
        )}

        {isAuthenticated && buyer ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-navy/70 text-center">
              Signed in as <strong>{buyer.email}</strong>
            </p>
            <Button onClick={handleAccept} loading={isAccepting} className="rf-btn w-full">
              Accept Invite &amp; Connect
            </Button>
            <button
              type="button"
              onClick={() => router.push("/buyer/portal")}
              className="text-sm text-navy/70 hover:text-navy text-center"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-navy/70 text-center mb-2">
              Sign in or create an account to accept this invite.
            </p>

            {/* Google Sign-In — embeds invite_token in OAuth state for seamless linking */}
            {invite?.slug && (
              <>
                {googleError && (
                  <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                    {googleError}
                  </p>
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
                      <span>Redirecting to Google…</span>
                    </>
                  ) : (
                    <>
                      <GoogleIcon className="h-4 w-4" />
                      <span>Continue with Google to accept</span>
                    </>
                  )}
                </button>

                {/* Divider */}
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-surface-border" />
                  <span className="text-xs text-navy/70">or</span>
                  <div className="h-px flex-1 bg-surface-border" />
                </div>
              </>
            )}

            <a
              href={`/buyer/login?redirect=/buyer/invite/${token}`}
              className="rf-btn flex w-full items-center justify-center gap-2"
            >
              Sign in to accept
            </a>
            <a
              href={`/buyer/register?redirect=/buyer/invite/${token}`}
              className="rf-btn secondary flex w-full items-center justify-center gap-2"
            >
              Create account to accept
            </a>
          </div>
        )}
      </>
    );
  }

  return (
    <AuthShell audience="retailer" kicker="Retailer account" title={title}>
      {content}
    </AuthShell>
  );
}
