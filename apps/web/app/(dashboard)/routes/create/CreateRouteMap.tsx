"use client";

import * as React from "react";
import {
  APIProvider,
  Map,
  AdvancedMarker,
  InfoWindow,
  useMap,
  useMapsLibrary,
} from "@vis.gl/react-google-maps";
import { MapPin, Plus, Minus } from "lucide-react";
import type { StopEntry, CustomerForMap } from "./page";
import { useGoogleMapsKey } from "@/hooks/useGoogleMapsKey";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CreateRouteMapProps {
  customers: CustomerForMap[];
  stops: StopEntry[];
  assignments: Record<string, { routeId: string; routeName: string }[]>;
  onAddStop: (customer: CustomerForMap) => void;
  onRemoveStop: (customerId: string) => void;
}

interface GeoCustomer {
  customer: CustomerForMap;
  lat: number;
  lng: number;
  addressId?: string;
}

// ─── Marker bubble ─────────────────────────────────────────────────────────────

function MarkerBubble({
  selected,
  stopNumber,
}: {
  selected: boolean;
  stopNumber?: number;
}) {
  const size = selected ? 36 : 32;
  const bg = selected ? "#3b82f6" : "#94a3b8";

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          backgroundColor: bg,
          border: selected ? "3px solid #fff" : "2px solid rgba(255,255,255,0.7)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          transform: selected ? "scale(1.15)" : "scale(1)",
          transition: "transform 0.15s, background-color 0.15s",
        }}
      >
        {selected && stopNumber != null ? (
          <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", lineHeight: 1 }}>
            {stopNumber}
          </span>
        ) : (
          <MapPin style={{ width: 16, height: 16, color: "#fff" }} />
        )}
      </div>
    </div>
  );
}

// ─── Polyline connecting selected stops ────────────────────────────────────────

function PolylineLayer({ stops }: { stops: StopEntry[] }) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");

  React.useEffect(() => {
    if (!map || !mapsLib) return;

    const path = stops
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ lat: s.lat!, lng: s.lng! }));

    if (path.length < 2) return;

    const polyline = new mapsLib.Polyline({
      path,
      geodesic: true,
      strokeColor: "#3b82f6",
      strokeOpacity: 0.7,
      strokeWeight: 3,
      map,
    });

    return () => polyline.setMap(null);
  }, [map, mapsLib, stops]);

  return null;
}

// ─── Auto-fit bounds ───────────────────────────────────────────────────────────

function FitBoundsLayer({ geoCustomers }: { geoCustomers: GeoCustomer[] }) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");

  React.useEffect(() => {
    if (!map || !mapsLib || geoCustomers.length === 0) return;

    const bounds = new (google.maps as any).LatLngBounds();
    geoCustomers.forEach((gc) => bounds.extend({ lat: gc.lat, lng: gc.lng }));
    map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
  }, [map, mapsLib, geoCustomers]);

  return null;
}

// ─── InfoWindow content ────────────────────────────────────────────────────────

function CustomerInfoWindow({
  gc,
  isSelected,
  stopNumber,
  routeAssigns,
  onAdd,
  onRemove,
  onClose,
}: {
  gc: GeoCustomer;
  isSelected: boolean;
  stopNumber?: number;
  routeAssigns?: { routeId: string; routeName: string }[];
  onAdd: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const addr = (gc.customer.addresses ?? []).find((a) => a.isDefault) ?? gc.customer.addresses?.[0];

  return (
    <InfoWindow
      position={{ lat: gc.lat, lng: gc.lng }}
      onCloseClick={onClose}
    >
      <div style={{ maxWidth: 240, padding: "4px 0" }}>
        <p style={{ fontWeight: 700, fontSize: 14, margin: "0 0 4px", color: "#0f172a" }}>
          {gc.customer.businessName}
        </p>
        {addr && (
          <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 6px" }}>
            {addr.line1 ?? addr.street}, {addr.city}, {addr.state}
          </p>
        )}
        {routeAssigns && routeAssigns.length > 0 && (
          <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 8px" }}>
            Currently in: {routeAssigns.map((r) => r.routeName).join(", ")}
          </p>
        )}
        <button
          onClick={isSelected ? onRemove : onAdd}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            backgroundColor: isSelected ? "#fee2e2" : "#eff6ff",
            color: isSelected ? "#dc2626" : "#3b82f6",
            width: "100%",
            justifyContent: "center",
          }}
        >
          {isSelected ? (
            <>
              <Minus style={{ width: 14, height: 14 }} />
              Remove stop #{stopNumber}
            </>
          ) : (
            <>
              <Plus style={{ width: 14, height: 14 }} />
              Add to route
            </>
          )}
        </button>
      </div>
    </InfoWindow>
  );
}

// ─── No-key fallback ───────────────────────────────────────────────────────────

function MapPlaceholder({ customerCount }: { customerCount: number }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface-raised">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-surface-border bg-white p-8 text-center shadow-card">
        <MapPin className="h-10 w-10 text-navy/20" />
        <div>
          <p className="font-semibold text-navy">Map unavailable</p>
          <p className="mt-1 text-sm text-navy/50">
            Set NEXT_PUBLIC_GOOGLE_MAPS_KEY to enable map view.
          </p>
        </div>
        <span className="rounded-full border border-surface-border bg-surface-raised px-3 py-1 text-xs font-medium text-navy/60">
          {customerCount} customer{customerCount !== 1 ? "s" : ""} available
        </span>
      </div>
    </div>
  );
}

// ─── Exported component ────────────────────────────────────────────────────────

export function CreateRouteMap({
  customers,
  stops,
  assignments,
  onAddStop,
  onRemoveStop,
}: CreateRouteMapProps) {
  const MAPS_KEY = useGoogleMapsKey();
  const [selectedCustomerId, setSelectedCustomerId] = React.useState<string | null>(null);

  // Build geocoded customer list
  const geoCustomers = React.useMemo<GeoCustomer[]>(() => {
    return customers
      .map((c) => {
        const addr = (c.addresses ?? []).find((a) => a.isDefault) ?? c.addresses?.[0];
        if (!addr?.lat || !addr?.lng) return null;
        return { customer: c, lat: addr.lat, lng: addr.lng, addressId: addr.id };
      })
      .filter(Boolean) as GeoCustomer[];
  }, [customers]);

  const selectedGc = selectedCustomerId
    ? geoCustomers.find((gc) => gc.customer.id === selectedCustomerId)
    : null;

  // Determine if selected customer is already a stop
  const selectedStopIdx = selectedCustomerId
    ? stops.findIndex((s) => s.customerId === selectedCustomerId)
    : -1;
  const isSelectedAdded = selectedStopIdx >= 0;

  if (!MAPS_KEY) return <MapPlaceholder customerCount={customers.length} />;
  if (geoCustomers.length === 0) return <MapPlaceholder customerCount={customers.length} />;

  return (
    <APIProvider apiKey={MAPS_KEY}>
      <Map
        mapId="CREATE_ROUTE_MAP"
        defaultCenter={{ lat: 37.7749, lng: -122.4194 }}
        defaultZoom={12}
        gestureHandling="greedy"
        disableDefaultUI={false}
        style={{ width: "100%", height: "100%" }}
        onClick={() => setSelectedCustomerId(null)}
      >
        <FitBoundsLayer geoCustomers={geoCustomers} />
        <PolylineLayer stops={stops} />

        {geoCustomers.map((gc) => {
          const stopIdx = stops.findIndex((s) => s.customerId === gc.customer.id);
          const isStop = stopIdx >= 0;

          return (
            <AdvancedMarker
              key={gc.customer.id}
              position={{ lat: gc.lat, lng: gc.lng }}
              onClick={() => {
                setSelectedCustomerId((prev) =>
                  prev === gc.customer.id ? null : gc.customer.id,
                );
              }}
            >
              <MarkerBubble selected={isStop} stopNumber={isStop ? stopIdx + 1 : undefined} />
            </AdvancedMarker>
          );
        })}

        {selectedGc && (
          <CustomerInfoWindow
            gc={selectedGc}
            isSelected={isSelectedAdded}
            stopNumber={isSelectedAdded ? selectedStopIdx + 1 : undefined}
            routeAssigns={assignments[selectedGc.customer.id]}
            onAdd={() => {
              onAddStop(selectedGc.customer);
              setSelectedCustomerId(null);
            }}
            onRemove={() => {
              onRemoveStop(selectedGc.customer.id);
              setSelectedCustomerId(null);
            }}
            onClose={() => setSelectedCustomerId(null)}
          />
        )}
      </Map>
    </APIProvider>
  );
}
