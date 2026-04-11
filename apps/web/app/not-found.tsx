"use client";

import Link from "next/link";
import { Home, ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

export default function NotFound() {
  const router = useRouter();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-base px-4">
      <div className="flex flex-col items-center gap-6 text-center">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500 text-white font-bold text-lg select-none">
            RF
          </div>
          <span className="text-xl font-semibold text-navy">RouteFlow</span>
        </div>

        {/* Error code */}
        <div className="space-y-2">
          <p className="text-8xl font-extrabold text-brand-500 leading-none">404</p>
          <h1 className="text-2xl font-bold text-navy">Page not found</h1>
          <p className="max-w-sm text-sm text-navy/50">
            The page you&apos;re looking for doesn&apos;t exist or may have been moved.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-brand-600 transition-colors"
          >
            <Home className="h-4 w-4" />
            Back to Dashboard
          </Link>
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center gap-2 rounded-lg border border-surface-border bg-white px-5 py-2.5 text-sm font-medium text-navy hover:bg-surface-raised transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}
