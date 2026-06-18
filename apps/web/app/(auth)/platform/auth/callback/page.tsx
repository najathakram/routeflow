"use client";

export const dynamic = "force-dynamic";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

// ─── Error messages ───────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  state_invalid: "Sign-in could not be completed. The link may have expired — please try again.",
  unauthorized:
    "Your Google account is not authorized for platform administration. Contact the system owner.",
  tenant_suspended: "This account has been suspended. Contact the system owner.",
  google_already_linked:
    "Your account already has a Google account connected. Remove the existing connection first.",
  google_id_taken: "This Google account is already linked to a different user.",
  oauth_cancelled: "Sign-in was cancelled. Please try again.",
  unknown_error: "An unexpected error occurred. Please try again.",
};

// ─── Inner component ──────────────────────────────────────────────────────────

function PlatformCallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = React.useState<"loading" | "error">("loading");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [isTransient, setIsTransient] = React.useState(false);

  React.useEffect(() => {
    const action = params.get("action"); // "linked" = Google account just linked
    const error = params.get("error");

    // ── Link-account success path ─────────────────────────────────────────────
    if (action === "linked") {
      router.replace("/admin/dashboard?linked=google");
      return;
    }

    if (error) {
      const msg = ERROR_MESSAGES[error] ?? ERROR_MESSAGES.unknown_error;
      setErrorMsg(msg);
      setIsTransient(
        error === "state_invalid" || error === "oauth_cancelled" || error === "unknown_error",
      );
      setStatus("error");
      if (error === "state_invalid" || error === "oauth_cancelled" || error === "unknown_error") {
        setTimeout(() => router.replace("/admin-login?error=google_failed"), 4000);
      }
      return;
    }

    const denied = () => {
      setErrorMsg(ERROR_MESSAGES.unauthorized);
      setIsTransient(false);
      setStatus("error");
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
      const accessToken = params.get("accessToken");
      const refreshToken = params.get("refreshToken");
      if (!accessToken || !refreshToken) return null;
      return { accessToken, refreshToken, role: params.get("role") ?? "" };
    }

    void resolveBundle().then((bundle) => {
      if (!bundle?.accessToken || !bundle?.refreshToken || bundle.role !== "SUPER_ADMIN") {
        denied();
        return;
      }
      // Store platform admin token (same key as regular admin login)
      localStorage.setItem("superAdminToken", bundle.accessToken);
      router.replace("/admin/dashboard");
    });
  }, [params, router]);

  if (status === "loading") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-900">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 shadow-lg">
          <svg className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
            />
          </svg>
        </div>
        <p className="text-sm text-slate-400">Signing you in to Platform Admin…</p>
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-slate-900 p-4">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-600 shadow-lg">
        <svg className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          />
        </svg>
      </div>

      <div className="w-full max-w-sm rounded-xl bg-slate-800 p-6 shadow-xl ring-1 ring-white/10 text-center">
        <h2 className="text-base font-semibold text-white mb-2">Access denied</h2>
        <p className="text-sm text-slate-400 mb-4">{errorMsg}</p>

        {isTransient ? (
          <p className="text-xs text-slate-600">Redirecting back in a moment…</p>
        ) : (
          <a
            href="/admin-login"
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
          >
            Back to admin login
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Page export (with Suspense) ──────────────────────────────────────────────

export default function PlatformAuthCallbackPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-900">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 shadow-lg">
            <svg
              className="h-7 w-7 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
          </div>
          <p className="text-sm text-slate-400">Signing you in to Platform Admin…</p>
        </div>
      }
    >
      <PlatformCallbackInner />
    </React.Suspense>
  );
}
