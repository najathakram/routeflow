"use client";

export const dynamic = "force-dynamic";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { OP_KEYS, BUYER_KEYS } from "@/lib/auth-keys";
import { setOpPresenceCookie, setBuyerPresenceCookie } from "@/lib/presence-cookies";

// ─── Error messages shown to the user ────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  state_invalid: "Sign-in could not be completed. The link may have expired — please try again.",
  unauthorized:
    "Your Google account is not authorized for this system. Contact your administrator.",
  tenant_suspended: "This account is currently suspended. Please contact support.",
  google_email_is_staff:
    "This email is registered as a staff account. Please sign in from the staff login page instead.",
  google_already_linked:
    "Your account already has a Google account connected. Remove the existing connection first.",
  google_id_taken:
    "This Google account is already linked to a different user. Sign in with that account or use a different Google account.",
  oauth_cancelled: "Sign-in was cancelled. Please try again.",
  unknown_error: "An unexpected error occurred. Please try again.",
};

// ─── Inner component (requires Suspense for useSearchParams) ─────────────────

function GoogleCallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = React.useState<"loading" | "error">("loading");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);

  React.useEffect(() => {
    const action = params.get("action"); // "linked" = Google account just linked
    const error = params.get("error");

    // ── Link-account success path ─────────────────────────────────────────────
    // User was already signed in; they just linked their Google account.
    // No tokens to store — just redirect back to settings with a success flag.
    if (action === "linked") {
      router.replace("/settings?linked=google");
      return;
    }

    // ── Error path ──────────────────────────────────────────────────────────
    if (error) {
      const msg = ERROR_MESSAGES[error] ?? ERROR_MESSAGES.unknown_error;
      setErrorMsg(msg);
      setErrorCode(error);
      setStatus("error");

      // Auto-redirect for transient errors
      if (error === "state_invalid" || error === "oauth_cancelled" || error === "unknown_error") {
        setTimeout(() => router.replace("/login?error=google_failed"), 4000);
      }
      return;
    }

    const failUnknown = () => {
      setErrorMsg(ERROR_MESSAGES.unknown_error);
      setErrorCode("unknown_error");
      setStatus("error");
      setTimeout(() => router.replace("/login?error=google_failed"), 4000);
    };

    // ── Resolve tokens: one-time code (F8-001) or legacy direct params ─────────
    async function resolveBundle(): Promise<Record<string, string> | null> {
      const code = params.get("code");
      if (code) {
        const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1").replace(
          /\/$/,
          "",
        );
        try {
          const res = await fetch(`${apiBase}/auth/google/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });
          if (!res.ok) return null;
          return (await res.json()) as Record<string, string>;
        } catch {
          return null;
        }
      }
      // Backward-compat: tokens delivered directly in the URL (deploy skew / legacy)
      const accessToken = params.get("accessToken");
      const refreshToken = params.get("refreshToken");
      if (!accessToken || !refreshToken) return null;
      return {
        accessToken,
        refreshToken,
        type: params.get("type") ?? "",
        role: params.get("role") ?? "",
        tenantSlug: params.get("tenantSlug") ?? "",
        sellerCount: params.get("sellerCount") ?? "",
        linked: params.get("linked") ?? "",
      };
    }

    void resolveBundle().then((bundle) => {
      if (!bundle?.accessToken || !bundle?.refreshToken) {
        failUnknown();
        return;
      }
      const { accessToken, refreshToken } = bundle;
      const type = bundle.type || null; // "BUYER" or absent (staff)
      const role = bundle.role || null; // OPERATOR, DRIVER, CUSTOMER, TENANT_ADMIN
      const tenantSlug = bundle.tenantSlug || null;
      const linked = bundle.linked || null;

      handleTokens(accessToken, refreshToken, type, role, tenantSlug, linked);
    });

    function handleTokens(
      accessToken: string,
      refreshToken: string,
      type: string | null,
      role: string | null,
      tenantSlug: string | null,
      linked: string | null,
    ) {
      if (type === "BUYER") {
        // Store buyer tokens under the namespaced keys that `BuyerAuthProvider`
        // and `getStoredBuyer()` actually read. Also keep the legacy keys
        // populated for any code path that hasn't been migrated yet
        // (e.g. /buyer/portal/page.tsx, /buyer/invite, buyer change-password).
        localStorage.setItem(BUYER_KEYS.accessToken, accessToken);
        localStorage.setItem(BUYER_KEYS.refreshToken, refreshToken);
        localStorage.setItem("buyerAccessToken", accessToken);
        localStorage.setItem("buyerRefreshToken", refreshToken);
        // Set the buyer presence cookie that the dashboard middleware checks
        // (without this the middleware can't tell a buyer apart from a
        // logged-out user and may misroute them).
        setBuyerPresenceCookie();
        // Redirect to buyer portal — show linked banner if just accepted an invite.
        // Use a full document navigation (NOT router.replace): the auth providers
        // live at the app root and only read localStorage on mount. A client-side
        // navigation would not re-read the tokens we just wrote, so the portal
        // guard would bounce the user back to login on the first attempt and they'd
        // have to click "Sign in with Google" twice. A hard load remounts the
        // providers so the new session is picked up immediately.
        const destination = linked === "true" ? "/buyer/portal?linked=true" : "/buyer/portal";
        window.location.replace(destination);
      } else {
        // Store staff tokens under both the namespaced keys (read by
        // `AuthProvider` / `getStoredUser`) and the legacy keys (read by
        // any unmigrated code path).
        localStorage.setItem(OP_KEYS.accessToken, accessToken);
        localStorage.setItem(OP_KEYS.refreshToken, refreshToken);
        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", refreshToken);
        // Set the operator presence cookie so middleware path guards work.
        setOpPresenceCookie();

        // Restore tenant cookie so API calls include X-Tenant-Slug header
        if (tenantSlug) {
          setTenantCookie(tenantSlug);
        }

        // Full document navigation so the root AuthProvider remounts and reads
        // the tokens we just stored (see the buyer branch above) — otherwise the
        // dashboard guard bounces the user back to login on the first attempt.
        // All staff roles (operator / customer / driver / admin) land on the
        // dashboard, which renders a role-appropriate view.
        window.location.replace("/dashboard");
      }
    }
  }, [params, router]);

  // ── Loading spinner ────────────────────────────────────────────────────────
  if (status === "loading") {
    return (
      <div
        className="flex h-screen flex-col items-center justify-center gap-4"
        style={{ background: "linear-gradient(155deg, #10264d, #16375f 60%, #0c1f3d)" }}
      >
        <div
          className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white backdrop-blur"
          style={{
            background: "linear-gradient(140deg, #234a74f5, #10264ded)",
            boxShadow: "inset 0 1px 0 #ffffff33, 0 7px 15px #10264d18",
          }}
        >
          RF
        </div>
        <p className="text-sm text-[#c2d0e5]">Signing you in…</p>
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-transparent"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  // ── Error display ──────────────────────────────────────────────────────────
  return (
    <div
      className="flex h-screen flex-col items-center justify-center gap-6 p-4"
      style={{ background: "linear-gradient(155deg, #10264d, #16375f 60%, #0c1f3d)" }}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white backdrop-blur"
        style={{
          background: "linear-gradient(140deg, #234a74f5, #10264ded)",
          boxShadow: "inset 0 1px 0 #ffffff33, 0 7px 15px #10264d18",
        }}
      >
        RF
      </div>

      <div
        className="w-full max-w-sm rounded-xl p-6 text-center shadow-xl backdrop-blur-xl"
        style={{
          background: "linear-gradient(130deg, #ffffffc2, #ffffff61 48%, #f5faff85)",
          border: "1px solid #ffffffdb",
          boxShadow: "inset 0 1px 1px #fff, inset 0 -1px 1px #54718e17, 0 14px 45px #284a7210",
        }}
      >
        <div className="mb-3 mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-red-50">
          <svg
            className="h-5 w-5 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
            />
          </svg>
        </div>

        <h2 className="text-base font-semibold text-[#152d51] mb-2">Sign-in failed</h2>
        <p className="text-sm text-[#4c607a] mb-4">{errorMsg}</p>

        {/* Contextual actions per error type */}
        {errorCode === "google_email_is_staff" ? (
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-lg border border-[#ffffffed] bg-[#ffffffad] px-4 py-2 text-sm font-medium text-[#152d51] shadow-sm backdrop-blur transition-colors hover:bg-white"
          >
            Go to staff login
          </a>
        ) : errorCode === "unauthorized" || errorCode === "tenant_suspended" ? (
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110"
            style={{
              background: "linear-gradient(140deg, #234a74f5, #10264ded)",
              boxShadow: "inset 0 1px 0 #ffffff33, 0 7px 15px #10264d18",
            }}
          >
            Back to login
          </a>
        ) : (
          <p className="text-xs text-[#4c607a]">Redirecting you back in a moment…</p>
        )}
      </div>
    </div>
  );
}

// ─── Page export (with Suspense for useSearchParams) ─────────────────────────

export default function GoogleCallbackPage() {
  return (
    <React.Suspense
      fallback={
        <div
          className="flex h-screen flex-col items-center justify-center gap-4"
          style={{ background: "linear-gradient(155deg, #10264d, #16375f 60%, #0c1f3d)" }}
        >
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white backdrop-blur"
            style={{
              background: "linear-gradient(140deg, #234a74f5, #10264ded)",
              boxShadow: "inset 0 1px 0 #ffffff33, 0 7px 15px #10264d18",
            }}
          >
            RF
          </div>
          <p className="text-sm text-[#c2d0e5]">Signing you in…</p>
        </div>
      }
    >
      <GoogleCallbackInner />
    </React.Suspense>
  );
}
