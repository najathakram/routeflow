"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";

const PLANS = ["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;

export default function AdminCreateTenantPage() {
  const router = useRouter();
  const [form, setForm] = React.useState({
    slug: "",
    businessName: "",
    adminEmail: "",
    adminUsername: "",
    adminPassword: "",
    plan: "STARTER",
  });
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<{ slug: string; id: string } | null>(null);

  const onChange = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await superAdminClient.post("/platform-admin/tenants", form);
      setSuccess({ slug: res.data.slug, id: res.data.id });
      // Redirect after a short delay
      setTimeout(() => router.push("/admin/tenants"), 2500);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
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
              Slug: <span className="font-mono">{success.slug}</span> — redirecting to tenant list…
            </p>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl bg-red-900/40 p-4 ring-1 ring-red-700">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <form onSubmit={onSubmit} className="rounded-xl bg-slate-800 p-6 ring-1 ring-white/5 flex flex-col gap-4">
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
            <label className="text-sm font-medium text-slate-300">Admin Password</label>
            <input
              type="password"
              value={form.adminPassword}
              onChange={onChange("adminPassword")}
              placeholder="Min. 8 characters"
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
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
                <option key={p} value={p}>{p}</option>
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
