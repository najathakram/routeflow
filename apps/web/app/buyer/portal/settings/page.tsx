"use client";

import * as React from "react";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  Merge,
  Loader2,
  CheckCircle,
  AlertCircle,
  Monitor,
  Smartphone,
  Laptop,
  Globe,
  Clock,
  AlertTriangle,
  LogOut as LogOutIcon,
} from "lucide-react";
import { buyerApiClient } from "@/lib/buyer-api-client";

// ─── Session types & helpers ──────────────────────────────────────────────────

interface SessionItem {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  deviceName: string;
}

function DeviceIcon({ ua }: { ua: string | null }) {
  if (!ua) return <Monitor className="h-5 w-5" />;
  if (/iPhone|iPad|iOS/i.test(ua)) return <Smartphone className="h-5 w-5" />;
  if (/Android/i.test(ua)) return <Smartphone className="h-5 w-5" />;
  if (/Macintosh|Mac OS/i.test(ua)) return <Laptop className="h-5 w-5" />;
  if (/Windows/i.test(ua)) return <Monitor className="h-5 w-5" />;
  return <Globe className="h-5 w-5" />;
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function parseBrowser(ua: string | null): string {
  if (!ua) return "Unknown browser";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Chrome/i.test(ua) && !/Chromium/i.test(ua)) return "Chrome";
  if (/Firefox/i.test(ua)) return "Firefox";
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return "Safari";
  if (/Opera|OPR/i.test(ua)) return "Opera";
  return "Browser";
}

// ─── Sessions Section ─────────────────────────────────────────────────────────

function SessionsSection() {
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [revokingAll, setRevokingAll] = React.useState(false);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await buyerApiClient.get<SessionItem[]>("/buyer/auth/sessions");
      setSessions(res.data);
    } catch {
      setError("Failed to load sessions.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const handleRevoke = async (sessionId: string) => {
    setRevoking(sessionId);
    try {
      await buyerApiClient.delete(`/buyer/auth/sessions/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch {
      setError("Failed to revoke session.");
    } finally {
      setRevoking(null);
    }
  };

  const handleRevokeAll = async () => {
    setRevokingAll(true);
    setConfirmRevokeAll(false);
    try {
      await Promise.all(
        sessions.map((s) => buyerApiClient.delete(`/buyer/auth/sessions/${s.id}`).catch(() => null)),
      );
      setSessions([]);
    } catch {
      setError("Failed to sign out all sessions.");
    } finally {
      setRevokingAll(false);
    }
  };

  return (
    <div className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-navy">Active Sessions</h2>
          <p className="text-xs text-navy/50">Devices currently signed into your account</p>
        </div>
        {sessions.length > 1 && !confirmRevokeAll && (
          <button
            onClick={() => setConfirmRevokeAll(true)}
            disabled={revokingAll}
            className="flex items-center gap-1.5 rounded-lg border border-danger/30 bg-danger-bg px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:border-danger/60 disabled:opacity-50"
          >
            <LogOutIcon className="h-3.5 w-3.5" />
            Sign out all
          </button>
        )}
      </div>

      {confirmRevokeAll && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-warning bg-warning-bg p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="flex-1">
            <p className="text-sm font-medium text-navy">Sign out all sessions?</p>
            <p className="mt-0.5 text-xs text-navy/60">You&apos;ll be signed out on all other devices.</p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={handleRevokeAll}
                className="rounded bg-danger px-3 py-1 text-xs font-semibold text-white hover:opacity-90"
              >
                Yes, sign out all
              </button>
              <button
                onClick={() => setConfirmRevokeAll(false)}
                className="text-xs text-navy/60 underline"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-danger-bg p-3 text-danger">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-brand-500" />
        </div>
      )}

      {!loading && !error && sessions.length === 0 && (
        <p className="text-sm text-navy/50">No active sessions found.</p>
      )}

      {!loading && sessions.length > 0 && (
        <ul className="divide-y divide-surface-border">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-start justify-between gap-3 py-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-navy/50">
                  <DeviceIcon ua={session.userAgent} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-navy">
                    {session.deviceName}
                    {" · "}
                    <span className="font-normal text-navy/60">{parseBrowser(session.userAgent)}</span>
                  </p>
                  {session.ipAddress && (
                    <p className="mt-0.5 text-xs text-navy/40">{session.ipAddress}</p>
                  )}
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-navy/40">
                    <span>
                      <Clock className="mr-0.5 inline-block h-3 w-3" />
                      Signed in {formatRelativeTime(session.createdAt)}
                    </span>
                    {session.lastUsedAt && (
                      <span>Active {formatRelativeTime(session.lastUsedAt)}</span>
                    )}
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleRevoke(session.id)}
                disabled={revoking === session.id}
                className="mt-1 shrink-0 rounded border border-surface-border px-2 py-1 text-xs font-medium text-navy/60 transition-colors hover:border-danger hover:bg-danger-bg hover:text-danger disabled:opacity-50"
              >
                {revoking === session.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Revoke"
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Merge Accounts Section ───────────────────────────────────────────────────

function MergeAccountsSection({ buyerEmail }: { buyerEmail?: string }) {
  const [email, setEmail] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setSuccess(null);
    setError(null);

    try {
      const res = await buyerApiClient.post("/buyer/auth/merge-request", {
        secondaryEmail: email,
        notes: notes || undefined,
      });
      setSuccess((res.data as { message?: string }).message ?? `Verification email sent to ${email}.`);
      setEmail("");
      setNotes("");
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(msg ?? "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50">
          <Merge className="h-5 w-5 text-brand-600" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-navy">Merge Accounts</h2>
          <p className="text-xs text-navy/50">Combine two accounts into one</p>
        </div>
      </div>

      <p className="mb-5 text-sm text-navy/70">
        If you have two separate RouteFlow accounts (e.g. two different email addresses), you can
        request to merge them. Your current account ({buyerEmail && <strong>{buyerEmail}</strong>}) will be kept,
        and the other account will be absorbed into this one. All seller connections from the other
        account will transfer over.
      </p>

      {success ? (
        <div className="flex items-start gap-3 rounded-lg bg-success-bg p-4 text-success">
          <CheckCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium">{success}</p>
            <button
              type="button"
              onClick={() => setSuccess(null)}
              className="mt-1 text-xs underline opacity-70 hover:opacity-100"
            >
              Submit another request
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy">
              Email address of the other account
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="other@example.com"
              className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm text-navy placeholder-navy/40 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
            <p className="mt-1 text-xs text-navy/50">
              We&apos;ll send a verification email to this address to confirm you own it.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy">
              Notes <span className="font-normal text-navy/40">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Any context that might help the platform admin..."
              className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm text-navy placeholder-navy/40 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-danger-bg p-3 text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email}
            className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {loading ? "Sending..." : "Send Verification Email"}
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerSettingsPage() {
  const { buyer } = useBuyerAuth();

  return (
    <div className="mx-auto max-w-2xl p-6 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-navy">Account Settings</h1>
      <p className="mb-8 text-sm text-navy/60">Manage your buyer portal preferences</p>

      <div className="space-y-6">
        <SessionsSection />
        <MergeAccountsSection buyerEmail={buyer?.email} />
      </div>
    </div>
  );
}
