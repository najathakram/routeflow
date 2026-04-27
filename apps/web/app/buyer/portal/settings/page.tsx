"use client";

import * as React from "react";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { Merge, Loader2, CheckCircle, AlertCircle } from "lucide-react";

export default function BuyerSettingsPage() {
  const { buyer } = useBuyerAuth();
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
      const token = typeof window !== "undefined" ? localStorage.getItem("buyerToken") : null;
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
      const res = await fetch(`${apiBase}/buyer/auth/merge-request`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ secondaryEmail: email, notes: notes || undefined }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Something went wrong");
      setSuccess(data.message ?? `Verification email sent to ${email}.`);
      setEmail("");
      setNotes("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-navy">Account Settings</h1>
      <p className="mb-8 text-sm text-navy/60">Manage your buyer portal preferences</p>

      {/* Merge Accounts Section */}
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
          request to merge them. Your current account (<strong>{buyer?.email}</strong>) will be kept,
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
    </div>
  );
}
