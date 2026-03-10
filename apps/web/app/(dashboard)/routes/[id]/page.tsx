"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  MapPin,
  Package,
  FileText,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { Badge, Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { getRouteRun, getTemplate, type Stop, type TimelineEvent } from "@/mocks/routes";

// ─── Stop status icon ─────────────────────────────────────────────────────────

function StopIcon({ status }: { status: Stop["status"] }) {
  if (status === "COMPLETED")
    return <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />;
  if (status === "CURRENT")
    return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-500" />;
  if (status === "SKIPPED")
    return <XCircle className="h-5 w-5 shrink-0 text-danger" />;
  return <Circle className="h-5 w-5 shrink-0 text-navy/25" />;
}

// ─── Timeline dot ─────────────────────────────────────────────────────────────

function TimelineDot({ type }: { type: TimelineEvent["type"] }) {
  const base = "h-2.5 w-2.5 rounded-full ring-2 ring-white";
  if (type === "start" || type === "end") return <span className={cn(base, "bg-brand-500")} />;
  if (type === "stop_complete") return <span className={cn(base, "bg-success")} />;
  if (type === "skip") return <span className={cn(base, "bg-danger")} />;
  return <span className={cn(base, "bg-navy/30")} />;
}

// ─── Stop list item ───────────────────────────────────────────────────────────

function StopItem({ stop }: { stop: Stop }) {
  const [expanded, setExpanded] = React.useState(stop.status === "CURRENT");

  return (
    <li
      className={cn(
        "rounded-lg border transition-colors",
        stop.status === "CURRENT"
          ? "border-brand-200 bg-brand-50"
          : stop.status === "COMPLETED"
          ? "border-surface-border bg-white"
          : "border-surface-border bg-white opacity-70",
      )}
    >
      {/* Header row */}
      <button
        className="flex w-full items-start gap-3 p-3 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <StopIcon status={stop.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-navy/40">#{stop.order}</span>
            <span className="font-medium text-navy truncate">{stop.customerName}</span>
            {stop.status === "CURRENT" && (
              <span className="ml-auto shrink-0 rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold text-white">
                CURRENT
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-navy/50">{stop.address}</p>
          {stop.completedAt && (
            <p className="mt-0.5 text-xs text-success/80">Completed {stop.completedAt}</p>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-navy/30" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-navy/30" />
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-surface-border px-3 pb-3 pt-2 space-y-2">
          {/* Items */}
          <div>
            <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-navy/50">
              <Package className="h-3.5 w-3.5" /> Items
            </p>
            <ul className="space-y-0.5">
              {stop.items.map((item, i) => (
                <li key={i} className="flex items-center justify-between text-xs text-navy">
                  <span>{item.name}</span>
                  <span className="text-navy/50">
                    {item.qty} × {item.unit}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Driver note */}
          {stop.driverNote && (
            <div className="rounded bg-warning-bg p-2">
              <p className="flex items-center gap-1 text-xs font-semibold text-warning">
                <FileText className="h-3.5 w-3.5" /> Driver note
              </p>
              <p className="mt-0.5 text-xs text-navy/80">{stop.driverNote}</p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RouteRunDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();

  // Try live run first, then template
  const run = getRouteRun(params.id);
  const template = !run ? getTemplate(params.id) : undefined;
  const name = run?.routeName ?? template?.name ?? "Route";

  React.useEffect(() => { setTitle(name); }, [setTitle, name]);

  if (!run && !template) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Route not found.</p>
        <Button variant="secondary" href="/routes">Back to Routes</Button>
      </div>
    );
  }

  // If it's a template with no live run, show a minimal view
  if (!run && template) {
    return (
      <div className="space-y-5 p-6">
        <Link href="/routes" className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors">
          <ArrowLeft className="h-4 w-4" />Routes
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-navy">{template.name}</h1>
            <p className="mt-1 text-sm text-navy/60">
              {template.stopCount} stops · Default driver: {template.defaultDriverName}
            </p>
          </div>
          <Button href={`/routes/${template.id}/dispatch`} leftIcon={<ExternalLink className="h-4 w-4" />}>
            Dispatch Run
          </Button>
        </div>
        <p className="text-sm text-navy/40 italic">No active run for this template today. Dispatch one to see live details.</p>
      </div>
    );
  }

  const stopsDone = run!.stops.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").length;
  const total = run!.stops.length;

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 border-b border-surface-border bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <Link href="/routes" className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors">
            <ArrowLeft className="h-4 w-4" />Routes
          </Link>
          <div className="h-4 w-px bg-surface-border" />
          <div className="flex flex-1 flex-wrap items-center gap-3">
            <h1 className="text-lg font-bold text-navy">{run!.routeName}</h1>
            <Badge
              status={
                run!.status === "IN_PROGRESS"
                  ? "IN_PROGRESS"
                  : run!.status === "COMPLETED"
                  ? "COMPLETED"
                  : run!.status === "CANCELLED"
                  ? "CANCELLED"
                  : "SCHEDULED"
              }
            />
            <span className="text-sm text-navy/60">{run!.driverName}</span>
            <span className="text-sm text-navy/40">·</span>
            <span className="text-sm text-navy/60">Started {run!.startTime}</span>
            <span className="text-sm text-navy/40">·</span>
            <span className="text-sm text-navy/60">{stopsDone}/{total} stops</span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            href={`/routes/${run!.id}/dispatch`}
          >
            Dispatch Panel
          </Button>
        </div>
      </div>

      {/* Main split layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: Stop list (40%) ── */}
        <div className="flex w-[40%] shrink-0 flex-col overflow-hidden border-r border-surface-border">
          <div className="shrink-0 border-b border-surface-border bg-surface-raised px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/50">
              Stops ({total})
            </p>
          </div>
          <ul className="flex-1 space-y-2 overflow-y-auto p-4">
            {run!.stops.map((stop) => (
              <StopItem key={stop.id} stop={stop} />
            ))}
          </ul>
        </div>

        {/* ── Right: Map placeholder (60%) ── */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface-raised">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-surface-border bg-white p-8 text-center shadow-card">
              <MapPin className="h-10 w-10 text-navy/20" />
              <div>
                <p className="font-semibold text-navy">Map will load here</p>
                <p className="mt-1 text-sm text-navy/50">
                  Google Maps integration coming in Phase 7.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <span className="rounded-full bg-success-bg px-3 py-1 text-xs font-medium text-success">
                  {stopsDone} completed
                </span>
                {run!.stops.filter((s) => s.status === "CURRENT").length > 0 && (
                  <span className="rounded-full bg-brand-100 px-3 py-1 text-xs font-medium text-brand-700">
                    1 in progress
                  </span>
                )}
                <span className="rounded-full bg-surface-raised border border-surface-border px-3 py-1 text-xs font-medium text-navy/60">
                  {run!.stops.filter((s) => s.status === "UPCOMING").length} upcoming
                </span>
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div className="shrink-0 border-t border-surface-border bg-white">
            <div className="border-b border-surface-border px-4 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-navy/50">
                Timeline
              </p>
            </div>
            <ul className="flex gap-0 overflow-x-auto px-4 py-3">
              {run!.timeline.map((event, idx) => (
                <li key={event.id} className="flex shrink-0 items-start gap-2">
                  <div className="flex flex-col items-center gap-1 pt-0.5">
                    <TimelineDot type={event.type} />
                    {idx < run!.timeline.length - 1 && (
                      <div className="h-px w-12 bg-surface-border mt-1" />
                    )}
                  </div>
                  <div className="min-w-[120px] max-w-[160px] mr-3">
                    <p className="text-[10px] font-semibold text-navy/40">{event.time}</p>
                    <p className="text-xs text-navy leading-snug">{event.label}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
