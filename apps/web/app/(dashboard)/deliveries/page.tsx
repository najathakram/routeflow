"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, Eye, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Table,
  useToast,
  type BadgeVariant,
} from "@routeflow/ui/web";
import { fmtCalendarDate, fmtDate } from "@/lib/formatting";
import { usePageTitle } from "@/lib/page-title-context";
import { useRoutes, useDeleteRoute, type Route } from "@/lib/api/routes";

// ─── Status derivation ──────────────────────────────────────────────────────────

interface DeliveryStatus {
  label: string;
  variant: BadgeVariant;
}

/**
 * Every ad-hoc delivery is one-shot: no run yet means it's still a draft
 * (built but never dispatched), and once dispatched the status simply
 * mirrors the latest run — there is no re-dispatch, so "latest" is always
 * the only run.
 */
function deriveDeliveryStatus(runs: Route["runs"]): DeliveryStatus {
  const run = runs?.[0];
  if (!run) return { label: "Draft", variant: "neutral" };
  if (run.status === "SCHEDULED") return { label: "Dispatched", variant: "neutral" };
  if (run.status === "IN_PROGRESS") return { label: "In progress", variant: "info" };
  if (run.status === "COMPLETED") return { label: "Delivered", variant: "success" };
  if (run.status === "CANCELLED") return { label: "Cancelled", variant: "danger" };
  return { label: "Draft", variant: "neutral" };
}

/**
 * Row / view-action target. Ad-hoc trips have no detail page of their own:
 * a dispatched delivery opens its route run, an undispatched draft opens the
 * route template it was built as. Kept identical to the legacy trips list.
 */
function deliveryHref(delivery: Route): string {
  const run = delivery.runs?.[0];
  return run ? `/routes/${run.id}` : `/routes/templates/${delivery.id}`;
}

// ─── Columns ────────────────────────────────────────────────────────────────────

function useDeliveryColumns(
  router: ReturnType<typeof useRouter>,
  deletingId: string | null,
  isDeleting: boolean,
  onStartDelete: (id: string) => void,
  onCancelDelete: () => void,
  onConfirmDelete: (id: string) => void,
) {
  return React.useMemo<ColumnDef<Route, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Delivery",
        cell: ({ row }) => <span className="font-medium text-navy">{row.original.name}</span>,
      },
      {
        id: "date",
        header: "Date",
        cell: ({ row }) => {
          const run = row.original.runs?.[0];
          // run.scheduledDate is a UTC-midnight CALENDAR date (fmtCalendarDate,
          // B91); the createdAt fallback is a real timestamp, so it stays on
          // the LOCAL formatter — but `fmtDate`, its date-only variant, not a
          // bare toLocaleDateString(): one column must render one style, or a
          // mixed list stacks "Jun 10, 2026" against "6/10/2026".
          const label = run?.scheduledDate
            ? fmtCalendarDate(run.scheduledDate)
            : fmtDate(row.original.createdAt);
          return <span className="text-navy/70">{label}</span>;
        },
      },
      {
        id: "driver",
        header: "Driver",
        cell: ({ row }) => (
          <span className="text-navy/70">{row.original.runs?.[0]?.driver?.contactName ?? "—"}</span>
        ),
      },
      {
        id: "stops",
        header: "Stops",
        cell: ({ row }) => <span className="text-navy/70">{row.original._count?.stops ?? 0}</span>,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const status = deriveDeliveryStatus(row.original.runs);
          return <Badge variant={status.variant} label={status.label} />;
        },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const delivery = row.original;
          const run = delivery.runs?.[0];
          return (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => router.push(deliveryHref(delivery))}
                title="View delivery"
                className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
              >
                <Eye className="h-4 w-4" />
              </button>
              {/* Draft deliveries only: once a delivery has a run, deleting it
                  would destroy that run's stops (POD photos, signature, arrival
                  times) — the only delivery record an ad-hoc trip has. Trips
                  are one-shot by design, so dispatched/completed rows never get
                  a re-dispatch or reuse affordance either. */}
              {!run &&
                (deletingId === delivery.id ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-danger">Delete?</span>
                    <button
                      onClick={() => onConfirmDelete(delivery.id)}
                      disabled={isDeleting}
                      className="rounded px-1.5 py-0.5 text-xs font-medium text-white bg-danger hover:bg-danger/80 transition-colors"
                    >
                      {isDeleting ? "…" : "Yes"}
                    </button>
                    <button
                      onClick={onCancelDelete}
                      className="rounded px-1.5 py-0.5 text-xs font-medium text-navy/70 hover:text-navy transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onStartDelete(delivery.id)}
                    title="Delete draft"
                    className="rounded p-1.5 text-navy/70 hover:bg-danger-bg hover:text-danger transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ))}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, deletingId, isDeleting],
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DeliveriesPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const [page, setPage] = React.useState(1);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const deleteDelivery = useDeleteRoute();

  React.useEffect(() => {
    setTitle("Deliveries");
  }, [setTitle]);

  const { data, isLoading, isError } = useRoutes({ kind: "ADHOC", page });
  const deliveries = data?.data ?? [];
  const meta = data?.meta;

  const handleConfirmDelete = (id: string) => {
    deleteDelivery.mutate(id, {
      onSuccess: () => toast({ title: "Draft deleted", variant: "success" }),
      onError: (err) =>
        toast({ title: "Delete failed", description: err.message, variant: "error" }),
      onSettled: () => setDeletingId(null),
    });
  };

  const columns = useDeliveryColumns(
    router,
    deletingId,
    deleteDelivery.isPending,
    setDeletingId,
    () => setDeletingId(null),
    handleConfirmDelete,
  );

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Deliveries"
        action={<Button onClick={() => router.push("/deliveries/new")}>Plan delivery</Button>}
      />

      {isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">
            Failed to load deliveries. Please try refreshing.
          </span>
        </div>
      ) : (
        <Table
          data={deliveries}
          columns={columns}
          isLoading={isLoading}
          onRowClick={(row) => router.push(deliveryHref(row.original))}
          emptyState={
            <EmptyState
              variant="routes"
              title="No deliveries yet"
              description="Plan one-shot delivery trips from selected orders — every past delivery stays here."
              action={
                <div className="flex items-center gap-3">
                  <Button onClick={() => router.push("/deliveries/new")}>Plan delivery</Button>
                  <Button variant="ghost" onClick={() => router.push("/orders")}>
                    Pick orders
                  </Button>
                </div>
              }
            />
          }
        />
      )}

      {(meta?.totalPages ?? 1) > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            aria-label="Previous page"
            className="grid h-8 w-8 place-items-center rounded-lg border border-surface-border text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm text-navy/70">
            Page {meta?.page ?? page} of {meta?.totalPages ?? 1}
          </span>
          <button
            disabled={page >= (meta?.totalPages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
            className="grid h-8 w-8 place-items-center rounded-lg border border-surface-border text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
