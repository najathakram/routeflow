"use client";

import * as React from "react";
import Link from "next/link";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("Dashboard render error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold text-navy">Something went wrong</h1>
      <p className="max-w-md text-sm text-navy/70">
        This page hit an unexpected error. Your changes were most likely saved — try again, or go
        back to the dashboard.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded border border-surface-border px-4 py-2 text-sm text-navy hover:bg-surface-sunken"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
