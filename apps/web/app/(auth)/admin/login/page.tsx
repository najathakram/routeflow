"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Shield } from "lucide-react";
import axios from "axios";

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/api\/v1\/?$/, "") ??
    (typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:3000`
      : "http://localhost:3000");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError("Username and password are required.");
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      // Intentionally no X-Tenant-Slug header — SUPER_ADMIN has tenantId=null
      const res = await axios.post(`${apiUrl}/api/v1/auth/login`, { username, password });
      const { accessToken, user } = res.data;

      if (user.role !== "SUPER_ADMIN") {
        setError("This login is for platform administrators only.");
        setIsLoading(false);
        return;
      }

      localStorage.setItem("superAdminToken", accessToken);
      router.push("/admin/dashboard");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Invalid username or password.";
      setError(typeof msg === "string" ? msg : "Login failed.");
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 shadow-lg">
            <Shield className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">RouteFlow Platform</h1>
          <p className="text-sm text-slate-400">Platform Administrator Login</p>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-slate-800 p-6 shadow-xl ring-1 ring-white/10">
          <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
            {error && (
              <div className="rounded-lg bg-red-900/50 px-3 py-2 text-sm text-red-300 ring-1 ring-red-700">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label htmlFor="username" className="text-sm font-medium text-slate-300">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Platform admin username"
                autoComplete="username"
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="password" className="text-sm font-medium text-slate-300">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="mt-2 flex h-10 w-full items-center justify-center rounded-lg bg-indigo-600 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-600">
          RouteFlow Platform Administration — authorized personnel only
        </p>
      </div>
    </div>
  );
}
