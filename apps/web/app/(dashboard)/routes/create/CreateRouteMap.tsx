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
import { Home, MapPin, Plus, Minus, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { StopEntry, CustomerForMap } from "./page";
import { useGoogleMapsKey } from "@/hooks/useGoogleMapsKey";
import { apiClient } from "@/lib/api-client";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CreateRouteMapProps {
  customers: CustomerForMap[];
  stops: StopEntry[];
  assignments: Record<string, { routeId: string; routeName: string }[]>;
  onAddStop: (customer: CustomerForMap) => void;
  onRemoveStop: (customerId: string) => void;
  depotLat?: number | null;
  depotLng?: number | null;
  depotAddress?: string | null;
}

interface GeoCustomer {
  customer: CustomerForMap;
  lat: number;
  lng: number;
  addressId?: string;
}

// ─── Marker bubble ─────────────────────────────────────────────────────────────

function MarkerBubble({ selected, stopNumber }: { selected: boolean; stopNumber?: number }) {
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

// ─── Depot marker bubble ──────────────────────────────────────────────────────

function DepotMarkerBubble() {
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: "#059669",
        border: "3px solid white",
        boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
      }}
    >
      <Home style={{ width: 16, height: 16 }} />
    </div>
  );
}

// ─── Polyline connecting selected stops (with depot) ───────────────────────────

function PolylineLayer({
  stops,
  depot,
}: {
  stops: StopEntry[];
  depot?: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");

  React.useEffect(() => {
    if (!map || !mapsLib) return;

    const stopCoords = stops
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ lat: s.lat!, lng: s.lng! }));

    // Build path: depot → stops → depot (if depot)
    const path: Array<{ lat: number; lng: number }> = [];
    if (depot) path.push({ lat: depot.lat, lng: depot.lng });
    path.push(...stopCoords);
    if (depot && stopCoords.length > 0) path.push({ lat: depot.lat, lng: depot.lng });

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
  }, [map, mapsLib, stops, depot]);

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
    <InfoWindow position={{ lat: gc.lat, lng: gc.lng }} onCloseClick={onClose}>
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

// ─── Placeholder when map cannot render ─────────────────────────────────────────

function MapPlaceholder({
  customerCount,
  reason,
}: {
  customerCount: number;
  reason: "no-key" | "no-geocoded";
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface-raised">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-surface-border bg-white p-8 text-center shadow-card">
        <MapPin className="h-10 w-10 text-navy/20" />
        <div>
          <p className="font-semibold text-navy">
            {reason === "no-key" ? "Map unavailable" : "No addresses to map"}
          </p>
          <p className="mt-1 text-sm text-navy/70">
            {reason === "no-key"
              ? "Google Maps API key not configured. Contact your administrator."
              : "None of your customers have geocoded addresses yet. Add addresses with coordinates to see them on the map."}
          </p>
        </div>
        <span className="rounded-full border border-surface-border bg-surface-raised px-3 py-1 text-xs font-medium text-navy/70">
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
  depotLat,
  depotLng,
  depotAddress,
}: CreateRouteMapProps) {
  const { key: MAPS_KEY, loading: mapsKeyLoading } = useGoogleMapsKey();
  const queryClient = useQueryClient();
  const [selectedCustomerId, setSelectedCustomerId] = React.useState<string | null>(null);
  const [depotInfoOpen, setDepotInfoOpen] = React.useState(false);
  const [isGeocoding, setIsGeocoding] = React.useState(false);

  const depot = depotLat != null && depotLng != null ? { lat: depotLat, lng: depotLng } : null;
  const geocodeTriggeredRef = React.useRef(false);

  // Split customers: those with lat/lng and those with addresses but no coords
  const { geoCustomers, needsGeocodingCount } = React.useMemo(() => {
    const geo: GeoCustomer[] = [];
    let ungeo = 0;
    for (const c of customers) {
      const addr = (c.addresses ?? []).find((a) => a.isDefault) ?? c.addresses?.[0];
      if (addr?.lat && addr?.lng) {
        geo.push({ customer: c, lat: addr.lat, lng: addr.lng, addressId: addr.id });
      } else if (addr?.line1) {
        ungeo++;
      }
    }
    return { geoCustomers: geo, needsGeocodingCount: ungeo };
  }, [customers]);

  // Auto-trigger backend geocoding when un-geocoded addresses are detected
  React.useEffect(() => {
    if (needsGeocodingCount === 0 || geocodeTriggeredRef.current) return;
    geocodeTriggeredRef.current = true;
    setIsGeocoding(true);
    apiClient
      .post("/customers/geocode-all")
      .then(() => queryClient.invalidateQueries({ queryKey: ["customers"] }))
      .catch(() => {}) // silent — map still shows whatever is already geocoded
      .finally(() => setIsGeocoding(false));
  }, [needsGeocodingCount, queryClient]);

  const selectedGc = selectedCustomerId
    ? geoCustomers.find((gc) => gc.customer.id === selectedCustomerId)
    : null;

  // Determine if selected customer is already a stop
  const selectedStopIdx = selectedCustomerId
    ? stops.findIndex((s) => s.customerId === selectedCustomerId)
    : -1;
  const isSelectedAdded = selectedStopIdx >= 0;

  if (mapsKeyLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-raised">
        <MapPin className="h-10 w-10 animate-pulse text-navy/20" />
        <p className="text-sm text-navy/70">Loading map…</p>
      </div>
    );
  }
  if (!MAPS_KEY) return <MapPlaceholder customerCount={customers.length} reason="no-key" />;

  // If geocoding is in progress and we have no pins yet, show a progress indicator
  if (geoCustomers.length === 0 && isGeocoding) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-raised">
        <Loader2 className="h-10 w-10 animate-spin text-brand-500" />
        <p className="text-sm font-medium text-navy/70">
          Geocoding {needsGeocodingCount} address{needsGeocodingCount !== 1 ? "es" : ""}…
        </p>
        <p className="text-xs text-navy/70">Resolving locations from address text</p>
      </div>
    );
  }

  if (geoCustomers.length === 0)
    return <MapPlaceholder customerCount={customers.length} reason="no-geocoded" />;

  return (
    <APIProvider apiKey={MAPS_KEY}>
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        {isGeocoding && (
          <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-brand-200 bg-white/95 px-4 py-1.5 shadow-md backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-500" />
              <span className="text-xs font-medium text-navy/70">
                Geocoding {needsGeocodingCount} more address{needsGeocodingCount !== 1 ? "es" : ""}…
              </span>
            </div>
          </div>
        )}
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
          <PolylineLayer stops={stops} depot={depot} />

          {/* Depot marker */}
          {depot && (
            <>
              <AdvancedMarker position={depot} onClick={() => setDepotInfoOpen((v) => !v)}>
                <DepotMarkerBubble />
              </AdvancedMarker>
              {depotInfoOpen && (
                <InfoWindow
                  position={depot}
                  onCloseClick={() => setDepotInfoOpen(false)}
                  pixelOffset={[0, -42]}
                >
                  <div style={{ padding: "4px 0", minWidth: 140 }}>
                    <p style={{ fontWeight: 700, fontSize: 13, margin: 0, color: "#0f172a" }}>
                      Depot
                    </p>
                    {depotAddress && (
                      <p style={{ fontSize: 11, color: "#64748b", margin: "2px 0 0" }}>
                        {depotAddress}
                      </p>
                    )}
                  </div>
                </InfoWindow>
              )}
            </>
          )}

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
      </div>
    </APIProvider>
  );
}
