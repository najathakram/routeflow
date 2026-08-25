"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, Eye, Trash2 } from "lucide-react";
import { Badge, EmptyState, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useRoutes, useDeleteRoute } from "@/lib/api/routes";

export default function TripsListPage() {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const [page, setPage] = React.useState(1);
  const [deletingTripId, setDeletingTripId] = React.useState<string | null>(null);
  const deleteTrip = useDeleteRoute();

  React.useEffect(() => {
    setTitle("Trips");
  }, [setTitle]);

  const { data, isLoading, isError } = useRoutes({ kind: "ADHOC", page });
  const trips = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/routes"
          className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Routes
        </Link>
        <div className="h-4 w-px bg-surface-border" />
        <h2 className="text-2xl font-bold text-navy">Trips</h2>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">Failed to load trips. Please try refreshing.</span>
        </div>
      ) : trips.length === 0 ? (
        <EmptyState
          variant="routes"
          title="No ad-hoc trips yet"
          description={
            'Select orders from the Orders list and choose "Plan delivery trip" to start one.'
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {trips.map((trip) => {
              const run = trip.runs?.[0];
              const href = run ? `/routes/${run.id}` : `/routes/templates/${trip.id}`;
              const stopCount = trip._count?.stops ?? 0;
              return (
                <div
                  key={trip.id}
                  className="flex flex-col gap-2 rounded-lg border border-surface-border bg-white p-4 shadow-card"
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={href}
                      className="min-w-0 truncate font-semibold text-navy hover:text-brand-600 transition-colors"
                    >
                      {trip.name}
                    </Link>
                    {run ? <Badge status={run.status} /> : <Badge status="DRAFT" />}
                  </div>
                  <p className="text-xs text-navy/70">
                    {stopCount} stop{stopCount !== 1 ? "s" : ""} · Created{" "}
                    {new Date(trip.createdAt).toLocaleDateString()}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Link
                      href={href}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-navy hover:bg-surface-raised transition-colors"
                    >
                      <Eye className="h-3.5 w-3.5" /> View
                    </Link>
                    {/* Draft trips only: once a trip has a run, deleting it would
                        destroy that run's stops (POD photos, signature, arrival
                        times) — the only delivery record an ad-hoc trip has. */}
                    {!run &&
                      (deletingTripId === trip.id ? (
                        <>
                          <button
                            onClick={() =>
                              deleteTrip.mutate(trip.id, {
                                onSuccess: () =>
                                  toast({ title: "Trip deleted", variant: "success" }),
                                onError: (err) =>
                                  toast({
                                    title: "Delete failed",
                                    description: err.message,
                                    variant: "error",
                                  }),
                                onSettled: () => setDeletingTripId(null),
                              })
                            }
                            disabled={deleteTrip.isPending}
                            className="rounded-lg bg-danger px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-danger/80 transition-colors"
                          >
                            {deleteTrip.isPending ? "Deleting…" : "Confirm"}
                          </button>
                          <button
                            onClick={() => setDeletingTripId(null)}
                            className="rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-navy/70 hover:text-navy transition-colors"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setDeletingTripId(trip.id)}
                          title="Delete trip"
                          className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-navy/70 hover:border-danger hover:text-danger transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>

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
        </>
      )}
    </div>
  );
}
