"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Building2, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { getInviteDetails, acceptInvite } from "@/lib/buyer-auth";

interface InviteDetails {
  name: string;
  slug: string;
  logoKey: string | null;
}

export default function BuyerInvitePage() {
  const params = useParams();
  const router = useRouter();
  const { buyer, isLoading: authLoading, isAuthenticated } = useBuyerAuth();
  const token = params.token as string;

  const [invite, setInvite] = React.useState<InviteDetails | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoadingInvite, setIsLoadingInvite] = React.useState(true);
  const [isAccepting, setIsAccepting] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  const [acceptError, setAcceptError] = React.useState<string | null>(null);

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
    const accessToken = typeof window !== "undefined" ? localStorage.getItem("buyerAccessToken") : null;
    if (!accessToken) return;

    setIsAccepting(true);
    setAcceptError(null);
    try {
      await acceptInvite(token, accessToken);
      setAccepted(true);
      // Redirect to portal after short delay
      setTimeout(() => {
        router.push("/buyer/portal");
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

  if (isLoadingInvite || authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-raised">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
        <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-card text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" />
          <h1 className="text-xl font-bold text-navy mb-2">Invalid Invite</h1>
          <p className="text-sm text-navy/60 mb-6">{loadError}</p>
          <a href="/buyer/portal" className="text-brand-600 hover:underline text-sm">
            Go to Buyer Portal
          </a>
        </div>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
        <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-card text-center">
          <CheckCircle className="mx-auto mb-4 h-12 w-12 text-success" />
          <h1 className="text-xl font-bold text-navy mb-2">Invite Accepted!</h1>
          <p className="text-sm text-navy/60">
            You are now connected to <strong>{invite?.name}</strong>. Redirecting to your portal...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white"
            style={{ backgroundColor: "#3B82F6" }}
          >
            RF
          </div>
          <h1 className="text-2xl font-bold text-navy">RouteFlow</h1>
          <p className="text-sm text-navy/60">Buyer Portal Invite</p>
        </div>

        {/* Invite Card */}
        <div className="rounded-xl bg-white p-6 shadow-card">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            {invite?.logoKey ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`${apiUrl}/uploads/${invite.logoKey}`}
                alt={invite.name}
                className="h-16 w-16 rounded-xl object-contain border border-surface-border"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-surface-raised border border-surface-border">
                <Building2 className="h-8 w-8 text-navy/40" />
              </div>
            )}
            <div>
              <p className="text-xs text-navy/50 uppercase tracking-wide mb-1">You have been invited by</p>
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
              <p className="text-sm text-navy/60 text-center">
                Signed in as <strong>{buyer.email}</strong>
              </p>
              <Button
                onClick={handleAccept}
                loading={isAccepting}
                className="w-full"
              >
                Accept Invite &amp; Connect
              </Button>
              <button
                type="button"
                onClick={() => router.push("/buyer/portal")}
                className="text-sm text-navy/50 hover:text-navy text-center"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-navy/60 text-center mb-2">
                Sign in or create an account to accept this invite.
              </p>
              <a
                href={`/buyer/login?redirect=/buyer/invite/${token}`}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
              >
                Sign in to accept
              </a>
              <a
                href={`/buyer/register?redirect=/buyer/invite/${token}`}
                className="flex w-full items-center justify-center gap-2 rounded border border-surface-border bg-white px-4 py-2.5 text-sm font-medium text-navy hover:bg-surface-raised transition-colors"
              >
                Create account to accept
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
