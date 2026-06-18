"use client";

import * as React from "react";
import { superAdminClient } from "@/lib/admin-api";
import {
  Monitor,
  Smartphone,
  Laptop,
  Globe,
  Loader2,
  LogOut,
  Shield,
  AlertTriangle,
  Clock,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  deviceName: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function DeviceIcon({ ua }: { ua: string | null }) {
  if (!ua) return <Monitor className="h-5 w-5" />;
  if (/iPhone|iPad|iOS/i.test(ua)) return <Smartphone className="h-5 w-5" />;
  if (/Android/i.test(ua)) return <Smartphone className="h-5 w-5" />;
  if (/Macintosh|Mac OS/i.test(ua)) return <Laptop className="h-5 w-5" />;
  if (/Windows/i.test(ua)) return <Monitor className="h-5 w-5" />;
  return <Globe className="h-5 w-5" />;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseBrowserName(ua: string | null): string {
  if (!ua) return "Unknown browser";
  if (/Edg\//i.test(ua)) return "Microsoft Edge";
  if (/Chrome/i.test(ua) && !/Chromium/i.test(ua)) return "Chrome";
  if (/Firefox/i.test(ua)) return "Firefox";
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return "Safari";
  if (/Opera|OPR/i.test(ua)) return "Opera";
  return "Browser";
}

// ─── Sessions Panel ───────────────────────────────────────────────────────────

function SessionsPanel() {
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [revokeAll, setRevokeAll] = React.useState(false);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await superAdminClient.get<Session[]>("/auth/sessions");
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
      await superAdminClient.delete(`/auth/sessions/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch {
      setError("Failed to revoke session.");
    } finally {
      setRevoking(null);
    }
  };

  const handleRevokeAll = async () => {
    setRevokeAll(true);
    setConfirmRevokeAll(false);
    try {
      // Revoke all sessions except the current one by revoking them all
      // The server /auth/logout deletes all — but we want to stay logged in.
      // Instead, revoke each session individually.
      await Promise.all(
        sessions.map((s) => superAdminClient.delete(`/auth/sessions/${s.id}`).catch(() => null)),
      );
      setSessions([]);
    } catch {
      setError("Failed to revoke all sessions.");
    } finally {
      setRevokeAll(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/60 p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Active Sessions</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            These are all devices currently signed into your admin account.
          </p>
        </div>
        {sessions.length > 1 && (
          <button
            onClick={() => setConfirmRevokeAll(true)}
            disabled={revokeAll}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/40 disabled:opacity-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            Revoke all
          </button>
        )}
      </div>

      {confirmRevokeAll && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-900/20 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" />
          <div className="flex-1">
            <p className="text-sm font-medium text-yellow-300">Revoke all sessions?</p>
            <p className="mt-0.5 text-xs text-yellow-300/70">
              All devices will be signed out. You will need to sign in again everywhere.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={handleRevokeAll}
                className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500"
              >
                Yes, revoke all
              </button>
              <button
                onClick={() => setConfirmRevokeAll(false)}
                className="rounded bg-slate-700 px-3 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-600"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
        </div>
      )}

      {!loading && error && (
        <p className="rounded-lg bg-red-900/30 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {!loading && !error && sessions.length === 0 && (
        <p className="text-sm text-slate-500">No active sessions found.</p>
      )}

      {!loading && !error && sessions.length > 0 && (
        <ul className="divide-y divide-slate-700/50">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-start justify-between gap-4 py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-700 text-slate-300">
                  <DeviceIcon ua={session.userAgent} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">
                    {session.deviceName}
                    {" · "}
                    <span className="font-normal text-slate-400">
                      {parseBrowserName(session.userAgent)}
                    </span>
                  </p>
                  {session.ipAddress && (
                    <p className="mt-0.5 text-xs text-slate-500">
                      <Globe className="mr-1 inline-block h-3 w-3" />
                      {session.ipAddress}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                    <span>
                      <Clock className="mr-0.5 inline-block h-3 w-3" />
                      Signed in {formatRelative(session.createdAt)}
                    </span>
                    {session.lastUsedAt && (
                      <span>Last active {formatRelative(session.lastUsedAt)}</span>
                    )}
                    <span>Expires {formatDate(session.expiresAt)}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleRevoke(session.id)}
                disabled={revoking === session.id}
                className="mt-1 shrink-0 rounded-lg border border-slate-600 bg-slate-700/50 px-2.5 py-1 text-xs font-medium text-slate-400 transition-colors hover:border-red-500/50 hover:bg-red-900/20 hover:text-red-400 disabled:opacity-50"
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminProfilePage() {
  return (
    <div className="p-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600/20">
          <Shield className="h-5 w-5 text-indigo-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">My Account</h1>
          <p className="text-sm text-slate-400">Manage your admin account and active sessions</p>
        </div>
      </div>

      <div className="max-w-2xl space-y-6">
        <SessionsPanel />
      </div>
    </div>
  );
}
