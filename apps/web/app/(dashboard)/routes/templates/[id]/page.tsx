"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  MapPin,
  Play,
  Loader2,
  GripVertical,
  Calendar,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { Badge, Button, Card, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useRoute, useCreateRouteRun, type RouteTemplateStop } from "@/lib/api/routes";

// ─── Stop row ─────────────────────────────────────────────────────────────────

function StopRow({ stop }: { stop: RouteTemplateStop }) {
  const addr = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}`
    : null;
  return (
    <li className="flex items-start gap-3 rounded-lg border border-surface-border bg-white p-3">
      <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-navy/20" />
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-500">
        {stop.stopNumber}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-navy truncate">
          {stop.customer?.businessName ?? stop.customerId}
        </p>
        {addr && <p className="mt-0.5 truncate text-xs text-navy/50">{addr}</p>}
        {stop.notes && (
          <p className="mt-0.5 text-xs text-navy/40 italic">{stop.notes}</p>
        )}
      </div>
    </li>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RouteTemplateDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const { setTitle } = usePageTitle();
  const router = useRouter();
  const { toast } = useToast();

  const { data: route, isLoading, isError } = useRoute(params.id);
  const createRun = useCreateRouteRun();

  const today = new Date().toISOString().split("T")[0];

  const name = route?.name ?? "Route Template";
  React.useEffect(() => { setTitle(name); }, [setTitle, name]);

  const handleDispatch = () => {
    createRun.mutate(
      { routeId: params.id, scheduledDate: today },
      {
        onSuccess: (run) => {
          toast({ title: "Route run dispatched", variant: "success" });
          router.push(`/routes/${run.id}`);
        },
        onError: (err) =>
          toast({ title: "Dispatch failed", description: err.message, variant: "error" }),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (isError || !route) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Route template not found.</p>
        <Button variant="secondary" href="/routes">Back to Routes</Button>
      </div>
    );
  }

  const stops = route.stops ?? [];

  return (
    <div className="space-y-6 p-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/routes"
          className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Routes
        </Link>
        <div className="h-4 w-px bg-surface-border" />
        <h1 className="text-xl font-bold text-navy">{route.name}</h1>
        <Badge
          variant={route.isActive ? "success" : "neutral"}
          label={route.isActive ? "Active" : "Inactive"}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button
            leftIcon={<Play className="h-4 w-4" />}
            loading={createRun.isPending}
            onClick={handleDispatch}
          >
            Dispatch Run Today
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <MapPin className="h-8 w-8 text-brand-500 bg-brand-50 rounded-lg p-1.5" />
            <div>
              <p className="text-2xl font-bold text-navy">{stops.length}</p>
              <p className="text-xs text-navy/50">Total Stops</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <Calendar className="h-8 w-8 text-brand-500 bg-brand-50 rounded-lg p-1.5" />
            <div>
              <p className="text-sm font-semibold text-navy">
                {new Date(route.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
              <p className="text-xs text-navy/50">Created</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            {route.isActive ? (
              <ToggleRight className="h-8 w-8 text-success bg-success-bg rounded-lg p-1.5" />
            ) : (
              <ToggleLeft className="h-8 w-8 text-navy/30 bg-surface-raised rounded-lg p-1.5" />
            )}
            <div>
              <p className="text-sm font-semibold text-navy">
                {route.isActive ? "Active" : "Inactive"}
              </p>
              <p className="text-xs text-navy/50">Status</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Stops */}
      <Card title={`Stops (${stops.length})`}>
        {stops.length === 0 ? (
          <p className="py-6 text-center text-sm text-navy/40">
            No stops added yet. Create a route with stops using the "Create Route" button.
          </p>
        ) : (
          <ul className="space-y-2">
            {stops.map((stop) => (
              <StopRow key={stop.id} stop={stop} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
