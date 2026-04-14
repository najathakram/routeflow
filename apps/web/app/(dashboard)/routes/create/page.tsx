"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useCustomers } from "@/lib/api/customers";
import { useDrivers } from "@/lib/api/drivers";
import { useCreateRoute, useCustomerRouteAssignments } from "@/lib/api/routes";
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

// ─── Client-side nearest-neighbour optimisation ────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestNeighborOrder(stops: StopEntry[]): StopEntry[] {
  const withCoords = stops.filter((s) => s.lat != null && s.lng != null);
  const withoutCoords = stops.filter((s) => s.lat == null || s.lng == null);
  if (withCoords.length < 2) return stops;
  const remaining = [...withCoords];
  const ordered: StopEntry[] = [remaining.splice(0, 1)[0]];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let nearestIdx = 0;
    let minDist = Infinity;
    remaining.forEach((s, i) => {
      const dist = haversineKm(last.lat!, last.lng!, s.lat!, s.lng!);
      if (dist < minDist) { minDist = dist; nearestIdx = i; }
    });
    ordered.push(remaining.splice(nearestIdx, 1)[0]);
  }
  // Stops without coordinates are appended at the end in their original relative order
  return [...ordered, ...withoutCoords];
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function CreateRoutePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => { setTitle("Create Route"); }, [setTitle]);

  // ── Data fetching ──
  const { data: customersData, isLoading: customersLoading } = useCustomers({ page: 1, limit: 500 } as any);
  const { data: driversData } = useDrivers({ page: 1, limit: 100 });
  const { data: assignments } = useCustomerRouteAssignments();

  const customers: CustomerForMap[] = customersData?.data ?? [];

  // ── Form ──
  const createRoute = useCreateRoute();
  const form = useForm<FormValues>({ resolver: zodResolver(schema) });
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // ── Stops state ──
  const [stops, setStops] = React.useState<StopEntry[]>([]);

  const addStop = React.useCallback((customer: CustomerForMap) => {
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
  }, [stops]);

  const removeStop = React.useCallback((customerId: string) => {
    setStops((prev) => prev.filter((s) => s.customerId !== customerId));
  }, []);

  const handleOptimize = React.useCallback(() => {
    setStops((prev) => nearestNeighborOrder(prev));
  }, []);

  // ── Submit ──
  const onSubmit = async (data: FormValues) => {
    setIsSubmitting(true);
    try {
      const route = await createRoute.mutateAsync({
        name: data.name,
        driverId: data.defaultDriverId || undefined,
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
            className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Routes
          </Link>
          <div className="h-4 w-px bg-surface-border" />
          <h1 className="text-lg font-bold text-navy">Create Route</h1>
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
          {customersLoading ? (
            <div className="flex flex-1 items-center justify-center bg-surface-raised">
              <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
            </div>
          ) : (
            <CreateRouteMap
              customers={customers}
              stops={stops}
              assignments={assignments ?? {}}
              onAddStop={addStop}
              onRemoveStop={removeStop}
            />
          )}
        </div>
      </div>
    </div>
  );
}
