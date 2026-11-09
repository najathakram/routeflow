"use client";

import * as React from "react";
import { Building2 } from "lucide-react";
import { superAdminClient } from "@/lib/admin-api";

interface Row {
  tenantId: string;
  name: string;
  calls: number;
  spendUsd: number;
  capUsd: number;
  percentUsed: number | null;
  aiOff: boolean;
}
interface Usage {
  month: string;
  platformCapUsd: number;
  businesses: Row[];
}

const thisMonth = () => new Date().toISOString().slice(0, 7); // UTC, as the server counts

/**
 * AI limits PR-2: each business's spend on RouteFlow's key for one UTC month, next to the allowance that applies to it
 * (the platform value, or its own override). Read-only; the allowance is changed on the business page.
 */
export function AiUsageByBusinessCard() {
  const [month, setMonth] = React.useState(thisMonth);
  const [data, setData] = React.useState<Usage | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setFailed(false);
    superAdminClient
      .get<Usage>(`/platform-admin/ai-usage/by-business?month=${month}`)
      .then((res) => {
        if (!cancelled) setData(res.data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  return (
    <section
      aria-labelledby="ai-usage-by-business"
      className="rounded-xl border border-slate-700/50 bg-slate-900 p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-slate-400" />
          <h2 id="ai-usage-by-business" className="text-sm font-semibold text-slate-200">
            AI use by business
          </h2>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Month
          <input
            type="month"
            value={month}
            max={thisMonth()}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="w-40 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
          />
        </label>
      </div>
      {failed ? (
        <p className="text-sm text-red-400">Couldn&apos;t load AI use. Try again.</p>
      ) : !data ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-400">
            <tr>
              <th className="pb-2 font-medium">Business</th>
              <th className="pb-2 text-right font-medium">Scans</th>
              <th className="pb-2 text-right font-medium">Spent</th>
              <th className="pb-2 text-right font-medium">Limit</th>
              <th className="pb-2 text-right font-medium">Used</th>
            </tr>
          </thead>
          <tbody>
            {data.businesses.map((b) => (
              <tr key={b.tenantId} className="border-t border-slate-800">
                <td className="py-2 text-slate-200">{b.name}</td>
                <td className="py-2 text-right font-mono text-slate-300">
                  {b.calls.toLocaleString()}
                </td>
                <td className="py-2 text-right font-mono text-slate-300">
                  ${b.spendUsd.toFixed(2)}
                </td>
                <td className="py-2 text-right font-mono text-slate-300">
                  {b.aiOff ? "AI off" : `$${b.capUsd}`}
                </td>
                <td
                  className={`py-2 text-right font-mono ${
                    (b.percentUsed ?? 0) >= 100 ? "text-red-400" : "text-slate-300"
                  }`}
                >
                  {b.percentUsed === null ? "–" : `${b.percentUsed}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
