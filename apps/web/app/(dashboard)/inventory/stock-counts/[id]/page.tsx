"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge, type BadgeVariant, Button, Card, PageHeader } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { fmt, fmtDate } from "@/lib/formatting";
import { roundMoney } from "@/lib/pricing";
import {
  computeCountedAfter,
  computeQtyVariance,
  useStockCountSession,
  type StockCountStatus,
} from "@/lib/api/stock-count";

const STATUS_META: Record<StockCountStatus, { variant: BadgeVariant; label: string }> = {
  OPEN: { variant: "info", label: "Open" },
  REVIEW: { variant: "warning", label: "In review" },
  COMMITTED: { variant: "success", label: "Committed" },
  DISCARDED: { variant: "neutral", label: "Discarded" },
};

export default function StockCountDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { data: session, isLoading } = useStockCountSession(params.id);

  React.useEffect(() => {
    setTitle(session?.name || "Stock Count");
  }, [setTitle, session?.name]);

  const previews = (session?.lines ?? [])
    .map((l) => {
      const row = {
        mode: l.mode,
        countedQty: Number(l.countedQty),
        expectedQty: Number(l.expectedQty),
      };
      const after = computeCountedAfter(row);
      const qtyVariance = computeQtyVariance(row);
      const avgCost = l.product.averageCost != null ? Number(l.product.averageCost) : 0;
      const dollarVariance = roundMoney(qtyVariance * avgCost);
      return { line: l, after, qtyVariance, dollarVariance };
    })
    .sort((a, b) => Math.abs(b.dollarVariance) - Math.abs(a.dollarVariance));

  const changed = previews.filter((p) => p.qtyVariance !== 0);
  const netVariance = roundMoney(changed.reduce((s, p) => s + p.dollarVariance, 0));

  // Lines only carry `countedById` (no nested user, PR-C API is single-counter
  // today) — resolve it against the two users the session response already
  // names rather than printing a raw id.
  const counterName = (countedById: string): string => {
    if (session?.startedBy && countedById === session.startedById)
      return session.startedBy.username;
    if (session?.committedBy && countedById === session.committedById)
      return session.committedBy.username;
    return `${countedById.slice(0, 8)}…`;
  };

  if (isLoading || !session) {
    return (
      <div className="space-y-5 p-6">
        <Link
          href="/inventory/stock-counts"
          className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Stock Counts
        </Link>
        <div className="p-8 text-center text-navy/70">Loading…</div>
      </div>
    );
  }

  const statusMeta = STATUS_META[session.status];

  return (
    <div className="space-y-5 p-6">
      <Link
        href="/inventory/stock-counts"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Stock Counts
      </Link>

      <PageHeader
        title={session.name || "Untitled count"}
        subtitle={`Started ${fmtDate(session.startedAt)}${session.startedBy ? ` by ${session.startedBy.username}` : ""}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusMeta.variant} label={statusMeta.label} />
            {session.status === "COMMITTED" && (
              <Button
                size="sm"
                onClick={() => router.push(`/inventory?tab=count&amend=${session.id}`)}
              >
                Amend
              </Button>
            )}
            {(session.status === "OPEN" || session.status === "REVIEW") && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => router.push("/inventory?tab=count")}
              >
                Resume count
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
            Lines
          </p>
          <p className="text-xl font-bold text-navy">{session.lines.length}</p>
        </Card>
        <Card className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
            Changed
          </p>
          <p className="text-xl font-bold text-navy">{changed.length}</p>
        </Card>
        <Card className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
            Net variance
          </p>
          <p
            className={`text-xl font-bold ${
              netVariance > 0 ? "text-success" : netVariance < 0 ? "text-danger" : "text-navy"
            }`}
          >
            {netVariance > 0 ? "+" : netVariance < 0 ? "−" : ""}
            {fmt(Math.abs(netVariance))}
          </p>
        </Card>
        <Card className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
            Committed
          </p>
          <p className="text-sm font-medium text-navy">
            {session.committedAt
              ? `${fmtDate(session.committedAt)}${session.committedBy ? ` by ${session.committedBy.username}` : ""}`
              : "—"}
          </p>
        </Card>
      </div>

      {session.notes && (
        <Card>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-navy/70">Notes</p>
          <p className="mt-1 text-sm text-navy">{session.notes}</p>
        </Card>
      )}

      {session.movementReference && (
        <div>
          <Link
            href={`/inventory/movements?reference=${encodeURIComponent(session.movementReference)}`}
            className="text-sm text-brand-600 hover:text-brand-700 hover:underline"
          >
            View the movements this count wrote →
          </Link>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
            <tr>
              {[
                "Product",
                "Expected",
                "Counted",
                "After",
                "Variance",
                "$ at avg cost",
                "Unit cost",
                "Counted by",
              ].map((h) => (
                <th key={h} className="px-4 py-3 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {previews.map(({ line, after, qtyVariance, dollarVariance }) => (
              <tr key={line.id} className="transition-colors hover:bg-surface-raised/50">
                <td className="px-4 py-3">
                  <Link
                    href={`/products/${line.product.id}`}
                    className="font-medium text-navy hover:text-brand-500 hover:underline"
                  >
                    {line.product.name}
                  </Link>
                  {line.product.sku && (
                    <p className="font-mono text-xs text-navy/70">{line.product.sku}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-navy/70">{Number(line.expectedQty)}</td>
                <td className="px-4 py-3 text-navy/70">
                  {Number(line.countedQty)} ({line.mode === "REPLACE" ? "Replace" : "Add"})
                </td>
                <td className="px-4 py-3 font-medium text-navy">{after}</td>
                <td
                  className={`px-4 py-3 font-medium ${
                    qtyVariance > 0
                      ? "text-success"
                      : qtyVariance < 0
                        ? "text-danger"
                        : "text-navy/70"
                  }`}
                >
                  {qtyVariance > 0 ? "+" : ""}
                  {qtyVariance}
                </td>
                <td
                  className={`px-4 py-3 font-medium whitespace-nowrap ${
                    dollarVariance > 0
                      ? "text-success"
                      : dollarVariance < 0
                        ? "text-danger"
                        : "text-navy/70"
                  }`}
                >
                  {dollarVariance > 0 ? "+" : dollarVariance < 0 ? "−" : ""}
                  {fmt(Math.abs(dollarVariance))}
                </td>
                <td className="px-4 py-3 text-navy/70">
                  {line.unitCostOverride != null
                    ? `$${Number(line.unitCostOverride).toFixed(4)}`
                    : "—"}
                </td>
                <td className="px-4 py-3 text-navy/70">{counterName(line.countedById)}</td>
              </tr>
            ))}
            {previews.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-navy/70">
                  Nothing was counted in this session.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
