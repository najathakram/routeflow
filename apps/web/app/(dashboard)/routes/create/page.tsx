"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useCustomers } from "@/lib/api/customers";
import { useDrivers } from "@/lib/api/drivers";
import { useCreateRoute, useCustomerRouteAssignments, useRouteSettings } from "@/lib/api/routes";
import { apiClient } from "@/lib/api-client";
import { CreateRouteLeftPanel } from "./CreateRouteLeftPanel";
import { CreateRouteMap } from "./CreateRouteMap";

// ─── Schema ────────────────────────────────────────────────────────────────────

const schema = z.object({
  name: z.string().min(1, "Route name is required"),
  defaultDriverId: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface StopEntry {
  id: string;
  customerId: string;
  customerName: string;
  address: string;
  addressId?: string;
  lat?: number;
  lng?: number;
}

export interface CustomerForMap {
  id: string;
  businessName: string;
  contactName?: string;
  addresses?: Array<{
    id: string;
    label?: string;
    line1?: string;
    street?: string;
    city?: string;
    state?: string;
    lat?: number | null;
    lng?: number | null;
    isDefault?: boolean;
  }>;
}

// ─── Client-side route optimisation (nearest-neighbour + 2-opt) ───────────────
//
// Pure greedy NN can produce routes that are significantly longer than optimal
// when stops are geographically clustered and the wrong starting stop is chosen.
// The 2-opt pass fixes crossed edges and typically closes that gap entirely for
// the typical route sizes (≤ 30 stops) used in this app.

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pathKm(stops: StopEntry[]): number {
  let total = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    total += haversineKm(stops[i].lat!, stops[i].lng!, stops[i + 1].lat!, stops[i + 1].lng!);
  }
  return total;
}

function nnFrom(stops: StopEntry[], startIdx: number): StopEntry[] {
  const remaining = [...stops];
  let current = remaining.splice(startIdx, 1)[0];
  const ordered: StopEntry[] = [current];
  while (remaining.length > 0) {
    let nearestIdx = 0;
    let minDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversineKm(current.lat!, current.lng!, s.lat!, s.lng!);
      if (d < minDist) {
        minDist = d;
        nearestIdx = i;
      }
    });
    current = remaining.splice(nearestIdx, 1)[0];
    ordered.push(current);
  }
  return ordered;
}

function twoOpt(stops: StopEntry[]): StopEntry[] {
  const n = stops.length;
  if (n < 4) return stops;
  let route = [...stops];
  let improved = true;
  while (improved) {
    improved = false;
    outer: for (let i = 0; i <= n - 3; i++) {
      for (let j = i + 2; j <= n - 2; j++) {
        const [a, b, c, d] = [route[i], route[i + 1], route[j], route[j + 1]];
        const delta =
          haversineKm(a.lat!, a.lng!, b.lat!, b.lng!) +
          haversineKm(c.lat!, c.lng!, d.lat!, d.lng!) -
          haversineKm(a.lat!, a.lng!, c.lat!, c.lng!) -
          haversineKm(b.lat!, b.lng!, d.lat!, d.lng!);
        if (delta > 0.001) {
          route = [
            ...route.slice(0, i + 1),
            ...route.slice(i + 1, j + 1).reverse(),
            ...route.slice(j + 1),
          ];
          improved = true;
          break outer;
        }
      }
    }
  }
  return route;
}

function nearestNeighborOrder(
  stops: StopEntry[],
  depot?: { lat: number; lng: number } | null,
): StopEntry[] {
  const withCoords = stops.filter((s) => s.lat != null && s.lng != null);
  const withoutCoords = stops.filter((s) => s.lat == null || s.lng == null);
  if (withCoords.length < 2) return stops;

  let best: StopEntry[];

  if (depot) {
    // With depot: start NN from the stop nearest to the depot
    let nearestIdx = 0;
    let minDist = haversineKm(depot.lat, depot.lng, withCoords[0].lat!, withCoords[0].lng!);
    for (let i = 1; i < withCoords.length; i++) {
      const d = haversineKm(depot.lat, depot.lng, withCoords[i].lat!, withCoords[i].lng!);
      if (d < minDist) {
        minDist = d;
        nearestIdx = i;
      }
    }
    best = nnFrom(withCoords, nearestIdx);
  } else {
    // No depot: try all starting points, keep shortest
    best = nnFrom(withCoords, 0);
    let bestDist = pathKm(best);
    for (let i = 1; i < withCoords.length; i++) {
      const candidate = nnFrom(withCoords, i);
      const dist = pathKm(candidate);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
  }

  // 2-opt improvement pass
  best = twoOpt(best);

  // Stops without coordinates are appended last in their original relative order
  return [...best, ...withoutCoords];
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function CreateRoutePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => {
    setTitle("Create Route");
  }, [setTitle]);

  // ── Data fetching ──
  const { data: customersData } = useCustomers({ page: 1, limit: 500 } as any);
  const { data: driversData } = useDrivers({ page: 1, limit: 100 });
  const { data: assignments } = useCustomerRouteAssignments();
  const { data: routeSettings } = useRouteSettings();

  const customers: CustomerForMap[] = customersData?.data ?? [];

  // ── Form ──
  const createRoute = useCreateRoute();
  const form = useForm<FormValues>({ resolver: zodResolver(schema) });
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // ── Stops state ──
  const [stops, setStops] = React.useState<StopEntry[]>([]);

  const addStop = React.useCallback(
    (customer: CustomerForMap) => {
      if (stops.some((s) => s.customerId === customer.id)) return;
      const addr = (customer.addresses ?? []).find((a) => a.isDefault) ?? customer.addresses?.[0];
      setStops((prev) => [
        ...prev,
        {
          id: customer.id + "-" + Date.now(),
          customerId: customer.id,
          customerName: customer.businessName,
          address: addr
            ? `${addr.line1 ?? addr.street ?? ""}, ${addr.city ?? ""}, ${addr.state ?? ""}`
            : "—",
          addressId: addr?.id,
          lat: addr?.lat ?? undefined,
          lng: addr?.lng ?? undefined,
        },
      ]);
    },
    [stops],
  );

  const removeStop = React.useCallback((customerId: string) => {
    setStops((prev) => prev.filter((s) => s.customerId !== customerId));
  }, []);

  const depot = React.useMemo(() => {
    if (routeSettings?.depotLat != null && routeSettings?.depotLng != null) {
      return { lat: routeSettings.depotLat, lng: routeSettings.depotLng };
    }
    return null;
  }, [routeSettings]);

  const handleOptimize = React.useCallback(() => {
    setStops((prev) => nearestNeighborOrder(prev, depot));
  }, [depot]);

  // ── Submit ──
  const onSubmit = async (data: FormValues) => {
    setIsSubmitting(true);
    try {
      const route = await createRoute.mutateAsync({
        name: data.name,
        driverId: data.defaultDriverId || undefined,
        depotLat: routeSettings?.depotLat ?? undefined,
        depotLng: routeSettings?.depotLng ?? undefined,
        depotAddress: routeSettings?.depotAddress || undefined,
      });
      // Add stops sequentially
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        await apiClient.post(`/routes/${route.id}/stops`, {
          customerId: stop.customerId,
          customerAddressId: stop.addressId,
          stopNumber: i + 1,
        });
      }
      // Invalidate AFTER all stops are added (fixes race condition)
      await queryClient.invalidateQueries({ queryKey: ["routes"] });
      await queryClient.invalidateQueries({ queryKey: ["customer-route-assignments"] });
      toast({
        title: "Route created",
        description: `${data.name} created with ${stops.length} stop(s).`,
        variant: "success",
      });
      router.push("/routes");
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? "Failed to create route.";
      toast({ title: "Error", description: msg, variant: "error" });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Driver options ──
  const driverOptions = React.useMemo(
    () => [
      { value: "", label: "No driver assigned" },
      ...(driversData?.data ?? []).map((d) => ({ value: d.id, label: d.contactName })),
    ],
    [driversData],
  );

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 border-b border-surface-border bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <Link
            href="/routes"
            className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Routes
          </Link>
          <div className="h-4 w-px bg-surface-border" />
          <h2 className="text-2xl font-bold text-navy">Create Route</h2>
        </div>
      </div>

      {/* Main split layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel (40%) */}
        <div className="flex w-[40%] shrink-0 flex-col overflow-hidden border-r border-surface-border">
          <CreateRouteLeftPanel
            form={form}
            driverOptions={driverOptions}
            stops={stops}
            customers={customers}
            assignments={assignments ?? {}}
            onAddStop={addStop}
            onRemoveStop={removeStop}
            onOptimize={handleOptimize}
            onSubmit={form.handleSubmit(onSubmit)}
            isSubmitting={isSubmitting}
          />
        </div>

        {/* Right panel — Map (60%) */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <CreateRouteMap
            customers={customers}
            stops={stops}
            assignments={assignments ?? {}}
            onAddStop={addStop}
            onRemoveStop={removeStop}
            depotLat={routeSettings?.depotLat}
            depotLng={routeSettings?.depotLng}
            depotAddress={routeSettings?.depotAddress}
          />
        </div>
      </div>
    </div>
  );
}
