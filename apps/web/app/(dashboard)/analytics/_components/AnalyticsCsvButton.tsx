"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { downloadCsv } from "@/lib/export";
import {
  ANALYTICS_CSV,
  analyticsCsvFilename,
  type AnalyticsCsvData,
  type AnalyticsCsvSlug,
} from "./analytics-csv";

/**
 * Small "Download CSV" icon button for one analytics card, built client-side from the card's
 * already-loaded state. OPERATOR / TENANT_ADMIN only; hidden while loading, disabled when empty.
 * `bare` drops the right-aligned wrapper so several buttons can share one row.
 */
export function AnalyticsCsvButton<S extends AnalyticsCsvSlug>({
  slug,
  data,
  from,
  to,
  loading = false,
  bare = false,
}: {
  slug: S;
  data: AnalyticsCsvData<S>;
  from: string;
  to: string;
  loading?: boolean;
  bare?: boolean;
}) {
  const { user } = useAuth();
  if (user?.role !== "OPERATOR" && user?.role !== "TENANT_ADMIN") return null;
  if (loading) return null;

  const spec = ANALYTICS_CSV[slug] as {
    headers: string[];
    rows: (d: AnalyticsCsvData<S>) => (string | number | null)[][];
  };
  const rows = spec.rows(data);
  const empty = rows.length === 0;

  const button = (
    <button
      type="button"
      data-testid={`analytics-csv-${slug}`}
      aria-label={`Download ${slug.replace(/-/g, " ")} CSV`}
      title={empty ? "Nothing to export" : "Download CSV"}
      disabled={empty}
      onClick={() => downloadCsv(analyticsCsvFilename(slug, from, to), spec.headers, rows)}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-navy/60 hover:bg-surface-raised hover:text-navy disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Download className="h-4 w-4" />
    </button>
  );
  return bare ? button : <div className="mb-2 flex justify-end">{button}</div>;
}
