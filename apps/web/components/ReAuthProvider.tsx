"use client";

import * as React from "react";
import { Check, Eye, EyeOff, Lock } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { login as apiLogin } from "@/lib/auth";
import { OP_KEYS } from "@/lib/auth-keys";
import { getTenantCookie } from "@/lib/tenant-cookie";
import { GoogleIcon, startGoogleSignIn } from "@/lib/google-oauth";
import { registerReauthHandler, type ReauthRequest } from "@/lib/session-expiry";
import { useI18n } from "@/lib/i18n";

/**
 * Mounts the session re-auth sheet and wires it to `api-client` via
 * `registerReauthHandler`. When the operator session expires mid-task, the
 * failed request pauses and this sheet lets the user unlock in place — drafts
 * and forms stay exactly where they were. "Switch account" resolves the request
 * as declined, so `api-client` falls back to the normal /login redirect.
 *
 * Google-only accounts have no password, so the sheet also offers "Continue
 * with Google" and "Forgot password?" — both are full-page navigations that
 * abandon the paused request queue (the document unloads), which is strictly
 * better than the dead end they replace.
 *
 * Copy mirrors unified/ux-standards.html.
 */

/** Read the tenant slug from the (possibly expired) operator access token.
 *  getStoredUser() rejects expired tokens, so parse the payload directly. */
function tenantSlugFromOpToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(OP_KEYS.accessToken);
  if (!token) return null;
  try {
    const part = token.split(".")[1]!;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return (payload?.tenantSlug as string) ?? null;
  } catch {
    return null;
  }
}

export function ReAuthProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [req, setReq] = React.useState<ReauthRequest | null>(null);
  const resolverRef = React.useRef<((ok: boolean) => void) | null>(null);

  const [password, setPassword] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Resolved once per sheet-opening; the tenant context outlives the session.
  const tenantSlug = React.useMemo(
    () => (req ? (getTenantCookie() ?? tenantSlugFromOpToken()) : null),
    [req],
  );

  const onGoogle = async () => {
    if (!tenantSlug || googleLoading) return;
    setGoogleLoading(true);
    setError(null);
    // IMPORTANT: do NOT resolve the pending re-auth promise (finish(false))
    // before navigating — that makes api-client race us to /login. On success
    // the document unloads mid-redirect and the queue dies with it.
    const result = await startGoogleSignIn({ context: "staff", tenantSlug });
    if (!result.ok) {
      setError(t("reauth.googleUnavailable"));
      setGoogleLoading(false);
    }
  };

  React.useEffect(() => {
    const unregister = registerReauthHandler(
      (next) =>
        new Promise<boolean>((resolve) => {
          resolverRef.current = resolve;
          setPassword("");
          setError(null);
          setReq(next);
        }),
    );
    // On unmount, flush any pending resolver as a decline so api-client falls
    // back to the redirect instead of hanging (isRefreshing stuck true).
    return () => {
      unregister();
      resolverRef.current?.(false);
      resolverRef.current = null;
    };
  }, []);

  // Focus the password field when the sheet opens.
  React.useEffect(() => {
    if (req) setTimeout(() => inputRef.current?.focus(), 20);
  }, [req]);

  const finish = React.useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setReq(null);
    setPassword("");
    setError(null);
    setSubmitting(false);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!req || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiLogin(req.username, password);
      finish(true);
    } catch {
      setError(t("reauth.badPassword"));
      setSubmitting(false);
    }
  };

  return (
    <>
      {children}
      {req && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reauth-title"
        >
          <div className="w-full max-w-[460px] overflow-hidden rounded-[14px] border border-line bg-paper shadow-modal">
            <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
              <span className="flex h-7 w-7 items-center justify-center rounded-ctl bg-accent-soft text-accent-deep">
                <Lock className="h-3.5 w-3.5" />
              </span>
              <h4 id="reauth-title" className="text-[14.5px] font-semibold text-ink-900">
                {t("reauth.title")}
              </h4>
            </div>

            <form onSubmit={submit}>
              <div className="flex flex-col gap-3 px-5 py-4">
                <p className="text-[13px] leading-relaxed text-ink-500">{t("reauth.body")}</p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="reauth-pw" className="text-xs font-semibold text-ink-700">
                    {t("reauth.passwordFor", { username: req.username })}
                  </label>
                  <div className="flex h-[34px] items-center gap-2 rounded-ctl border border-line-strong bg-paper px-2.5 focus-within:border-accent focus-within:outline focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-accent">
                    <input
                      id="reauth-pw"
                      ref={inputRef}
                      type={show ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      className="w-full bg-transparent text-[13px] text-ink-900 outline-none placeholder:text-ink-400"
                      placeholder="Password"
                    />
                    <button
                      type="button"
                      onClick={() => setShow((v) => !v)}
                      className="text-ink-400 hover:text-ink-700"
                      aria-label={show ? "Hide password" : "Show password"}
                    >
                      {show ? (
                        <EyeOff className="h-[15px] w-[15px]" />
                      ) : (
                        <Eye className="h-[15px] w-[15px]" />
                      )}
                    </button>
                  </div>
                  {error && <p className="text-xs text-danger">{error}</p>}
                  <div className="text-right">
                    {/* Full navigation on purpose — leaves the paused queue behind. */}
                    <a
                      href="/forgot-password"
                      className="text-xs font-medium text-accent-deep hover:underline"
                    >
                      {t("reauth.forgot")}
                    </a>
                  </div>
                </div>

                {/* Google escape hatch — Google-only accounts have no password
                    to type here. Shown whenever the tenant context is known;
                    for password accounts the server auto-links by email match,
                    so offering it universally is safe. */}
                {tenantSlug && (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="h-px flex-1 bg-line" />
                      <span className="text-[11px] uppercase tracking-wider text-ink-500">
                        {t("reauth.or")}
                      </span>
                      <div className="h-px flex-1 bg-line" />
                    </div>
                    <button
                      type="button"
                      onClick={onGoogle}
                      disabled={googleLoading || submitting}
                      className="flex w-full items-center justify-center gap-2.5 rounded-ctl border border-line-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink-900 transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {googleLoading ? (
                        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-400/40 border-t-ink-700" />
                      ) : (
                        <GoogleIcon className="h-3.5 w-3.5" />
                      )}
                      <span>{t("reauth.continueGoogle")}</span>
                    </button>
                  </>
                )}
              </div>

              <div className="flex justify-end gap-2.5 border-t border-line bg-surface-raised px-5 py-3.5">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={submitting}
                  onClick={() => finish(false)}
                >
                  {t("reauth.switch")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={submitting}
                  leftIcon={<Check className="h-3.5 w-3.5" />}
                >
                  {t("reauth.unlock")}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
