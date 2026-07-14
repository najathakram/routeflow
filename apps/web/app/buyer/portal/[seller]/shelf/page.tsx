"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlarmClock,
  ArrowRight,
  Loader2,
  Package,
  Plus,
  ShoppingCart,
  Store,
  Undo2,
} from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerShelf,
  useBuyerCreateOrder,
  useSnoozeReplenishment,
  useUnsnoozeReplenishment,
  useAddAllLow,
  type ShelfEstimate,
} from "@/lib/api/buyer";
import { objectPositionForUrl } from "@/lib/image-focal";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** "24 pcs (2 boxes of 12)" for boxed products, "6 gal" otherwise. */
function qtyLabel(e: ShelfEstimate): string {
  if (e.unitsPerBox && e.unitsPerBox > 1) {
    const boxes = Math.max(1, Math.round(e.suggestedQty / e.unitsPerBox));
    return `${e.suggestedQty} pcs (${boxes} ${boxes === 1 ? "box" : "boxes"} of ${e.unitsPerBox})`;
  }
  return `${e.suggestedQty} ${e.unit}`;
}

/** Share of the cadence remaining, clamped 0..1; null when cadence unknown. */
function daysLeftFraction(e: ShelfEstimate): number | null {
  if (e.estDaysLeft == null || e.cadenceDays == null || e.cadenceDays <= 0) return null;
  return Math.min(1, Math.max(0, e.estDaysLeft / e.cadenceDays));
}

function daysLeftLabel(e: ShelfEstimate): string {
  if (e.estDaysLeft == null) return "no pattern yet";
  if (e.estDaysLeft < 0) return `${Math.abs(e.estDaysLeft)}d overdue`;
  if (e.estDaysLeft === 0) return "due today";
  return `~${e.estDaysLeft}d left`;
}

const BAR_COLOR: Record<ShelfEstimate["state"], string> = {
  low: "bg-danger",
  "due-soon": "bg-warning",
  ok: "bg-buyer-500",
};

// ─── Row ──────────────────────────────────────────────────────────────────────

function ShelfRow({
  e,
  onAdd,
  addPending,
  onSnooze,
  onUnsnooze,
  snoozePending,
}: {
  e: ShelfEstimate;
  onAdd: () => void;
  addPending: boolean;
  onSnooze: () => void;
  onUnsnooze: () => void;
  snoozePending: boolean;
}) {
  const frac = daysLeftFraction(e);
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      {/* Thumbnail */}
      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-raised">
        {e.imageUrl ? (
          <img
            src={e.imageUrl}
            alt=""
            className="h-full w-full object-cover"
            style={{ objectPosition: objectPositionForUrl(e.imageUrl) }}
          />
        ) : (
          <Package className="h-5 w-5 text-navy/15" />
        )}
      </div>

      {/* Name + cadence + days-left bar */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-navy">{e.name}</p>
        <p className="text-xs text-navy/70">
          Last ordered {formatDate(e.lastOrderedAt)}
          {e.cadenceDays != null && <> · every ~{e.cadenceDays}d</>} · {daysLeftLabel(e)}
        </p>
        {e.snoozed && e.snoozedUntil ? (
          <p className="mt-1 text-[11px] text-navy/50">
            Snoozed until {formatDate(e.snoozedUntil)}
          </p>
        ) : (
          frac != null && (
            <div className="mt-1.5 h-1.5 w-full max-w-[220px] rounded-full bg-surface-raised">
              <div
                className={`h-1.5 rounded-full ${BAR_COLOR[e.state]}`}
                style={{ width: `${Math.round(frac * 100)}%` }}
              />
            </div>
          )
        )}
      </div>

      {/* Suggested qty (no price by design — estimates carry none) */}
      <div className="hidden shrink-0 text-right sm:block">
        <p className="text-sm font-semibold text-navy">{qtyLabel(e)}</p>
        <p className="text-[11px] text-navy/50">suggested</p>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onAdd}
          disabled={addPending}
          className="flex items-center gap-1 rounded-lg bg-buyer-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-buyer-600 disabled:opacity-50"
        >
          {addPending ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          Add
        </button>
        {e.snoozed ? (
          <button
            onClick={onUnsnooze}
            disabled={snoozePending}
            title="Show suggestions for this product again"
            className="flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-navy/70 transition-colors hover:text-navy disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" /> Unsnooze
          </button>
        ) : (
          <button
            onClick={onSnooze}
            disabled={snoozePending}
            title="Hide for one cycle"
            className="flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-navy/70 transition-colors hover:text-navy disabled:opacity-50"
          >
            <AlarmClock className="h-3.5 w-3.5" /> Snooze
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-surface-border bg-white">
      <div className="flex items-center gap-2 border-b border-surface-border px-4 py-3">
        <h2 className="text-sm font-semibold text-navy">{title}</h2>
        <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-bold text-navy/60">
          {count}
        </span>
      </div>
      <div className="divide-y divide-surface-border">{children}</div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerShelfPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const { data: shelf, isLoading, isError } = useBuyerShelf();
  const createOrder = useBuyerCreateOrder();
  const addAllLow = useAddAllLow();
  const snooze = useSnoozeReplenishment();
  const unsnooze = useUnsnoozeReplenishment();

  const [pendingAdd, setPendingAdd] = React.useState<string | null>(null);
  const [pendingSnooze, setPendingSnooze] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  const estimates = shelf?.estimates ?? [];
  const running = estimates.filter((e) => e.state === "low" && !e.snoozed);
  const dueSoon = estimates.filter((e) => e.state === "due-soon" && !e.snoozed);
  const snoozed = estimates.filter((e) => e.snoozed);
  const rest = estimates.filter((e) => e.state === "ok" && !e.snoozed);

  const handleAdd = async (e: ShelfEstimate) => {
    if (pendingAdd) return;
    setPendingAdd(e.productId);
    try {
      // Server-side create/merge at the suggested qty — same path as the cart.
      // For boxed products send a box split so the server prorates by the box:
      // suggestedQty is a whole-box multiple of PIECES, and a box-unaware boxed
      // line is ordered/charged as suggestedQty BOXES (unitsPerBox× too much).
      const upb = e.unitsPerBox;
      await createOrder.mutateAsync({
        items: [
          {
            productId: e.productId,
            qty: e.suggestedQty,
            ...(upb && upb > 1
              ? { boxes: Math.max(1, Math.round(e.suggestedQty / upb)), pieces: 0 }
              : {}),
          },
        ],
      });
    } finally {
      setPendingAdd(null);
    }
  };

  const handleSnooze = async (e: ShelfEstimate) => {
    if (pendingSnooze) return;
    setPendingSnooze(e.productId);
    try {
      if (e.snoozed) await unsnooze.mutateAsync(e.productId);
      else await snooze.mutateAsync(e.productId);
    } finally {
      setPendingSnooze(null);
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          Failed to load your shelf. Please try again later.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">Your Shelf</h1>
          <p className="mt-1 text-sm text-navy/70">
            What you usually reorder from {activeSeller?.tenant.name} — and when it&apos;s likely to
            run out
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Open order card (delivery route-day calendar deferred — no schedule model yet) */}
          {shelf?.activeOrder && (
            <Link
              href={`/buyer/portal/${sellerSlug}/orders/${shelf.activeOrder.id}`}
              className="flex items-center gap-3 rounded-xl border border-buyer-200 bg-buyer-50 px-4 py-2 transition-colors hover:border-buyer-300"
            >
              <div>
                <p className="text-xs font-semibold text-navy">
                  Open order{" "}
                  {shelf.activeOrder.orderNumber ?? `#${shelf.activeOrder.id.slice(0, 8)}`}
                </p>
                <p className="text-[11px] text-navy/70">
                  {shelf.activeOrder.itemCount}{" "}
                  {shelf.activeOrder.itemCount === 1 ? "item" : "items"} ·{" "}
                  {fmt(shelf.activeOrder.total)}
                </p>
              </div>
              <ArrowRight className="h-4 w-4 text-buyer-500" />
            </Link>
          )}
          <Button
            onClick={() => addAllLow.mutate()}
            disabled={addAllLow.isPending || running.length === 0}
            className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
          >
            {addAllLow.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <ShoppingCart className="mr-1.5 h-4 w-4" />
            )}
            Add all low to cart{running.length > 0 ? ` (${running.length})` : ""}
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {estimates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <Package className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="mb-2 text-lg font-semibold text-navy">Nothing on your shelf yet</h2>
          <p className="mb-4 text-sm text-navy/70">
            Once you&apos;ve placed a few orders, we&apos;ll learn what you usually reorder and
            when.
          </p>
          <Button
            variant="secondary"
            onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
          >
            <Store className="mr-1.5 h-4 w-4" /> Browse Products
          </Button>
        </div>
      ) : (
        <>
          <Section title="Running low" count={running.length}>
            {running.map((e) => (
              <ShelfRow
                key={e.productId}
                e={e}
                onAdd={() => handleAdd(e)}
                addPending={pendingAdd === e.productId}
                onSnooze={() => handleSnooze(e)}
                onUnsnooze={() => handleSnooze(e)}
                snoozePending={pendingSnooze === e.productId}
              />
            ))}
          </Section>

          <Section title="Due soon" count={dueSoon.length}>
            {dueSoon.map((e) => (
              <ShelfRow
                key={e.productId}
                e={e}
                onAdd={() => handleAdd(e)}
                addPending={pendingAdd === e.productId}
                onSnooze={() => handleSnooze(e)}
                onUnsnooze={() => handleSnooze(e)}
                snoozePending={pendingSnooze === e.productId}
              />
            ))}
          </Section>

          <Section title="Snoozed" count={snoozed.length}>
            {snoozed.map((e) => (
              <ShelfRow
                key={e.productId}
                e={e}
                onAdd={() => handleAdd(e)}
                addPending={pendingAdd === e.productId}
                onSnooze={() => handleSnooze(e)}
                onUnsnooze={() => handleSnooze(e)}
                snoozePending={pendingSnooze === e.productId}
              />
            ))}
          </Section>

          <Section title="Everything else" count={rest.length}>
            {rest.map((e) => (
              <ShelfRow
                key={e.productId}
                e={e}
                onAdd={() => handleAdd(e)}
                addPending={pendingAdd === e.productId}
                onSnooze={() => handleSnooze(e)}
                onUnsnooze={() => handleSnooze(e)}
                snoozePending={pendingSnooze === e.productId}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
