"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Repeat,
  ChevronDown,
  ChevronUp,
  Package,
  Loader2,
  Calendar,
  ShoppingCart,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { Badge, Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerTemplates, useBuyerReorder, type OrderTemplate } from "@/lib/api/buyer";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatSchedule(days: number[]): string {
  if (!days || days.length === 0) return "No schedule";
  if (days.length === 7) return "Every day";
  if (
    days.length === 5 &&
    [1, 2, 3, 4, 5].every((d) => days.includes(d))
  )
    return "Weekdays";
  return days
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES[d])
    .join(", ");
}

// ─── Template Row ─────────────────────────────────────────────────────────────

function TemplateRow({
  template,
  onReorder,
  isReordering,
}: {
  template: OrderTemplate;
  onReorder: () => void;
  isReordering: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="border-b border-surface-border last:border-b-0">
      {/* Main row */}
      <div className="flex items-center gap-4 px-4 py-4">
        {/* Expand toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
        >
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>

        {/* Icon */}
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-buyer-50">
          <Repeat className="h-5 w-5 text-buyer-500" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-navy truncate">{template.name}</h3>
            <Badge variant={template.isActive ? "success" : "neutral"}>
              {template.isActive ? "Active" : "Paused"}
            </Badge>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="flex items-center gap-1 text-xs text-navy/50">
              <Calendar className="h-3 w-3" />
              {formatSchedule(template.daysOfWeek)}
            </span>
            <span className="flex items-center gap-1 text-xs text-navy/50">
              <Package className="h-3 w-3" />
              {template.items.length} {template.items.length === 1 ? "item" : "items"}
            </span>
            {template.nextFireDate && (
              <span className="flex items-center gap-1 text-xs font-medium text-buyer-600">
                <Calendar className="h-3 w-3" />
                Next: {new Date(template.nextFireDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
              </span>
            )}
          </div>
        </div>

        {/* Reorder button */}
        <Button
          variant="secondary"
          size="sm"
          onClick={onReorder}
          loading={isReordering}
          disabled={isReordering}
        >
          <ShoppingCart className="mr-1.5 h-3.5 w-3.5" />
          Reorder Now
        </Button>
      </div>

      {/* Expanded items */}
      {expanded && (
        <div className="bg-surface-raised/50 px-4 pb-4 pl-[4.75rem]">
          {template.notes && (
            <p className="mb-3 text-xs text-navy/60 italic">{template.notes}</p>
          )}
          <div className="rounded-lg border border-surface-border bg-white overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-surface-border text-[11px] text-navy/50 uppercase tracking-wider">
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left w-20">Unit</th>
                  <th className="px-3 py-2 text-right w-16">Qty</th>
                  <th className="px-3 py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {template.items.map((item) => (
                  <tr key={item.id} className="text-sm">
                    <td className="px-3 py-2 font-medium text-navy">{item.product.name}</td>
                    <td className="px-3 py-2 text-navy/60">{item.product.unit}</td>
                    <td className="px-3 py-2 text-right text-navy">{item.qty}</td>
                    <td className="px-3 py-2 text-navy/50 text-xs">{item.notes ?? "N/A"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerTemplatesPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const { data: result, isLoading, isError } = useBuyerTemplates();
  const reorder = useBuyerReorder();

  const [reorderingId, setReorderingId] = React.useState<string | null>(null);
  const [successId, setSuccessId] = React.useState<string | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  // Redirect checks
  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  React.useEffect(() => {
    if (!authLoading && activeSeller && activeSeller.tenant.slug !== sellerSlug) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, sellerSlug, router]);

  const handleReorder = async (templateId: string) => {
    setReorderingId(templateId);
    setErrorMsg(null);
    setSuccessId(null);
    try {
      await reorder.mutateAsync(templateId);
      setSuccessId(templateId);
      setTimeout(() => setSuccessId(null), 4000);
    } catch (err: any) {
      setErrorMsg(
        err?.response?.data?.message ?? "Failed to create order from template.",
      );
    } finally {
      setReorderingId(null);
    }
  };

  const templates = result?.data ?? [];

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy">Standing Orders</h1>
        <p className="text-sm text-navy/60 mt-1">
          Recurring order templates set up by {activeSeller?.tenant.name}. Quickly reorder with one
          click.
        </p>
      </div>

      {/* Success toast */}
      {successId && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-success/30 bg-success-bg/50 px-4 py-2.5 text-sm text-success">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          Order created from template! View it in your{" "}
          <button
            onClick={() => router.push(`/buyer/portal/${sellerSlug}/orders`)}
            className="underline font-medium"
          >
            orders
          </button>
          .
        </div>
      )}

      {/* Error */}
      {errorMsg && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-2.5 text-sm text-danger">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {errorMsg}
        </div>
      )}

      {/* Templates list */}
      {isError ? (
        <div className="rounded-xl border border-danger/30 bg-danger-bg p-8 text-center">
          <p className="text-sm text-danger">Failed to load standing orders. Please try again later.</p>
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <Repeat className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">No standing orders</h2>
          <p className="text-sm text-navy/60">
            Your seller hasn&apos;t set up any recurring order templates for you yet.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
          {templates.map((t) => (
            <TemplateRow
              key={t.id}
              template={t}
              onReorder={() => handleReorder(t.id)}
              isReordering={reorderingId === t.id}
            />
          ))}
        </div>
      )}

      {/* Summary footer */}
      {templates.length > 0 && (
        <div className="mt-4 flex items-center gap-4 text-xs text-navy/50">
          <span>
            {templates.filter((t) => t.isActive).length} active ·{" "}
            {templates.filter((t) => !t.isActive).length} paused
          </span>
          <span>
            {templates.reduce((sum, t) => sum + t.items.length, 0)} total items across all
            templates
          </span>
        </div>
      )}
    </div>
  );
}
