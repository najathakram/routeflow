"use client";

import * as React from "react";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";
import { planLabel } from "../../../_components/AdminBadge";

const PLANS = ["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;

interface CreatedTenant {
  slug: string;
  id: string;
  adminUsername?: string;
  tempPassword?: string;
  checkoutUrl?: string;
}

export default function AdminCreateTenantPage() {
  const [form, setForm] = React.useState({
    slug: "",
    businessName: "",
    adminEmail: "",
    adminUsername: "",
    adminPassword: "",
    plan: "STARTER",
  });
  const [showPw, setShowPw] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<CreatedTenant | null>(null);
  const [copied, setCopied] = React.useState(false);

  const onChange =
    (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    try {
      // Omit a blank password so the API auto-generates a temporary one and
      // returns it (we then surface it for the admin to copy).
      const payload: Record<string, string> = { ...form };
      if (!payload.adminPassword) delete payload.adminPassword;
      const res = await superAdminClient.post("/platform-admin/tenants", payload);
      setSuccess(res.data);
      setCopied(false);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data
        ?.message;
      setError(Array.isArray(msg) ? msg.join(", ") : (msg ?? "Failed to create tenant"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center gap-4">
        <Link href="/admin/tenants" className="text-sm text-slate-400 hover:text-slate-300">
          ← Back to Tenants
        </Link>
        <h1 className="text-2xl font-bold text-white">Create New Tenant</h1>
      </div>

      <div className="max-w-xl">
        {success && (
          <div className="mb-4 rounded-xl bg-green-900/40 p-4 ring-1 ring-green-700">
            <p className="font-semibold text-green-400">Tenant created successfully!</p>
            <p className="mt-1 text-sm text-green-300">
              Slug: <span className="font-mono">{success.slug}</span>
            </p>
            {success.tempPassword && (
              <div className="mt-3 rounded-lg bg-slate-900/60 p-3 ring-1 ring-green-700/40">
                <p className="text-xs text-green-300">
                  Auto-generated temporary password — copy it now, it won&apos;t be shown again. The
                  admin must change it on first login.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  {success.adminUsername && (
                    <span className="text-xs text-slate-400">
                      {success.adminUsername}
                      {" · "}
                    </span>
                  )}
                  <code className="rounded bg-slate-800 px-2 py-1 font-mono text-sm text-white">
                    {success.tempPassword}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(success.tempPassword ?? "");
                      setCopied(true);
                    }}
                    className="rounded px-2 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-900/40"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            )}
            {success.checkoutUrl && (
              <p className="mt-3 text-sm text-green-300">
                Payment link:{" "}
                <a
                  href={success.checkoutUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-indigo-300 underline hover:text-indigo-200"
                >
                  {success.checkoutUrl}
                </a>
              </p>
            )}
            <div className="mt-3 flex gap-3">
              <Link
                href={`/admin/tenants/${success.id}`}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                View tenant
              </Link>
              <Link
                href="/admin/tenants"
                className="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
              >
                Back to list
              </Link>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl bg-red-900/40 p-4 ring-1 ring-red-700">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <form
          onSubmit={onSubmit}
          className="rounded-xl bg-slate-800 p-6 ring-1 ring-white/5 flex flex-col gap-4"
        >
          {/* Slug */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">
              Slug <span className="text-slate-500 font-normal">(URL identifier, lowercase)</span>
            </label>
            <input
              value={form.slug}
              onChange={onChange("slug")}
              placeholder="e.g. acme-foods"
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Business Name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">Business Name</label>
            <input
              value={form.businessName}
              onChange={onChange("businessName")}
              placeholder="e.g. Acme Foods Ltd."
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Admin Email */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">Admin Email</label>
            <input
              type="email"
              value={form.adminEmail}
              onChange={onChange("adminEmail")}
              placeholder="admin@acme.com"
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Admin Username */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">Admin Username</label>
            <input
              value={form.adminUsername}
              onChange={onChange("adminUsername")}
              placeholder="acme_admin"
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Admin Password */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">
              Admin Password <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                value={form.adminPassword}
                onChange={onChange("adminPassword")}
                placeholder="Leave blank to auto-generate"
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 pr-10 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors"
              >
                {showPw ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              If left blank, a secure temporary password is generated and shown once after creation.
            </p>
          </div>

          {/* Plan */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">Plan</label>
            <select
              value={form.plan}
              onChange={onChange("plan")}
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            >
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {planLabel(p)}
                </option>
              ))}
            </select>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={isLoading}
            className="mt-2 flex h-10 w-full items-center justify-center rounded-lg bg-indigo-600 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Creating…" : "Create Tenant"}
          </button>
        </form>
      </div>
    </div>
  );
}
