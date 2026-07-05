"use client";

import * as React from "react";
import { Check, Eye, EyeOff, Lock } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { login as apiLogin } from "@/lib/auth";
import { registerReauthHandler, type ReauthRequest } from "@/lib/session-expiry";
import { useI18n } from "@/lib/i18n";

/**
 * Mounts the session re-auth sheet and wires it to `api-client` via
 * `registerReauthHandler`. When the operator session expires mid-task, the
 * failed request pauses and this sheet lets the user unlock in place — drafts
 * and forms stay exactly where they were. "Switch account" resolves the request
 * as declined, so `api-client` falls back to the normal /login redirect.
 *
 * Copy mirrors unified/ux-standards.html.
 */
export function ReAuthProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [req, setReq] = React.useState<ReauthRequest | null>(null);
  const resolverRef = React.useRef<((ok: boolean) => void) | null>(null);

  const [password, setPassword] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

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
                </div>
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
