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
import { Home, MapPin, Trash2 } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { RouteTemplateStop } from "@/lib/api/routes";
import { useGoogleMapsKey } from "@/hooks/useGoogleMapsKey";
import { MapErrorBoundary, MapsApiGate } from "@/components/GoogleMapsGate";

// ─── Numbered stop bubble ──────────────────────────────────────────────────────

function MarkerBubble({ stop, selected }: { stop: RouteTemplateStop; selected: boolean }) {
  const size = selected ? 36 : 32;
  const bg = selected ? "#3b82f6" : "#94a3b8";
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        border: "2px solid white",
        boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        fontWeight: 700,
        fontSize: selected ? 13 : 11,
        transition: "all 0.15s",
      }}
    >
      {stop.stopNumber}
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

// ─── Polyline between stops (with depot round-trip) ───────────────────────────

function PolylineLayer({
  stops,
  depot,
}: {
  stops: RouteTemplateStop[];
  depot?: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");
  const polylineRef = React.useRef<google.maps.Polyline | null>(null);

  React.useEffect(() => {
    if (!map || !mapsLib) return;
    const stopCoords = stops
      .filter((s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null)
      .sort((a, b) => a.stopNumber - b.stopNumber)
      .map((s) => ({ lat: s.customerAddress!.lat!, lng: s.customerAddress!.lng! }));

    // Build path: depot → stops → depot (if depot exists)
    const coords: Array<{ lat: number; lng: number }> = [];
    if (depot) coords.push({ lat: depot.lat, lng: depot.lng });
    coords.push(...stopCoords);
    if (depot && stopCoords.length > 0) coords.push({ lat: depot.lat, lng: depot.lng });

    if (polylineRef.current) polylineRef.current.setMap(null);
    polylineRef.current = new mapsLib.Polyline({
      path: coords,
      strokeColor: "#3b82f6",
      strokeOpacity: 0.8,
      strokeWeight: 3,
      map,
    });
    return () => {
      polylineRef.current?.setMap(null);
    };
  }, [map, mapsLib, stops, depot]);

  return null;
}

// ─── Auto-fit bounds ───────────────────────────────────────────────────────────

function FitBoundsLayer({
  stops,
  depot,
}: {
  stops: RouteTemplateStop[];
  depot?: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");
  const fitted = React.useRef(false);

  React.useEffect(() => {
    if (!map || !mapsLib || fitted.current) return;
    const geo = stops.filter((s) => s.customerAddress?.lat != null);
    if (!geo.length && !depot) return;
    const bounds = new (google.maps as any).LatLngBounds();
    geo.forEach((s) =>
      bounds.extend({ lat: s.customerAddress!.lat!, lng: s.customerAddress!.lng! }),
    );
    if (depot) bounds.extend({ lat: depot.lat, lng: depot.lng });
    map.fitBounds(bounds, 80);
    fitted.current = true;
  }, [map, mapsLib, stops, depot]);

  return null;
}

// ─── Placeholder when map cannot render ───────────────────────────────────────

function MapPlaceholder({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-raised text-navy/70">
      <MapPin className="h-10 w-10" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface TemplateRouteMapProps {
  stops: RouteTemplateStop[];
  selectedStopId?: string | null;
  onSelectStop?: (stopId: string) => void;
  onRemoveStop?: (stopId: string) => void;
  depotLat?: number | null;
  depotLng?: number | null;
  depotAddress?: string | null;
}

function MapContent({
  stops,
  selectedStopId,
  onSelectStop,
  onRemoveStop,
  depotLat,
  depotLng,
  depotAddress,
}: TemplateRouteMapProps) {
  const [openInfoId, setOpenInfoId] = React.useState<string | null>(null);
  const [depotInfoOpen, setDepotInfoOpen] = React.useState(false);

  const depot = depotLat != null && depotLng != null ? { lat: depotLat, lng: depotLng } : null;

  const geoStops = stops.filter(
    (s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null,
  );

  return (
    <>
      <FitBoundsLayer stops={geoStops} depot={depot} />
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
              <div className="min-w-[160px] p-1 text-sm">
                <p className="font-semibold text-navy">Depot</p>
                {depotAddress && <p className="mt-0.5 text-xs text-navy/70">{depotAddress}</p>}
              </div>
            </InfoWindow>
          )}
        </>
      )}

      {geoStops.map((stop) => (
        <React.Fragment key={stop.id}>
          <AdvancedMarker
            position={{ lat: stop.customerAddress!.lat!, lng: stop.customerAddress!.lng! }}
            onClick={() => {
              setOpenInfoId(openInfoId === stop.id ? null : stop.id);
              onSelectStop?.(stop.id);
            }}
          >
            <MarkerBubble
              stop={stop}
              selected={selectedStopId === stop.id || openInfoId === stop.id}
            />
          </AdvancedMarker>

          {openInfoId === stop.id && (
            <InfoWindow
              position={{ lat: stop.customerAddress!.lat!, lng: stop.customerAddress!.lng! }}
              onCloseClick={() => setOpenInfoId(null)}
              pixelOffset={[0, -42]}
            >
              <div className="min-w-[180px] space-y-2 p-1 text-sm">
                <p className="font-semibold text-navy">
                  #{stop.stopNumber} — {stop.customer?.businessName ?? "Customer"}
                </p>
                <p className="text-xs text-navy/70">
                  {stop.customerAddress?.line1}, {stop.customerAddress?.city}
                </p>
                {onRemoveStop && (
                  <button
                    onClick={() => {
                      onRemoveStop(stop.id);
                      setOpenInfoId(null);
                    }}
                    className="flex items-center gap-1.5 rounded bg-danger-bg px-2 py-1 text-xs font-medium text-danger hover:bg-danger/20 transition-colors"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove from route
                  </button>
                )}
              </div>
            </InfoWindow>
          )}
        </React.Fragment>
      ))}
    </>
  );
}

export function TemplateRouteMap({
  stops,
  selectedStopId,
  onSelectStop,
  onRemoveStop,
  depotLat,
  depotLng,
  depotAddress,
}: TemplateRouteMapProps) {
  const { key: MAPS_KEY, loading: mapsKeyLoading } = useGoogleMapsKey();
  const geoStops = stops.filter((s) => s.customerAddress?.lat != null);
  const hasDepot = depotLat != null && depotLng != null;

  if (mapsKeyLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-raised">
        <MapPin className="h-10 w-10 animate-pulse text-navy/20" />
        <p className="text-sm text-navy/70">Loading map…</p>
      </div>
    );
  }

  if (!MAPS_KEY) {
    return <MapPlaceholder message="Google Maps API key not configured." />;
  }

  if (!geoStops.length && !hasDepot) {
    return <MapPlaceholder message="No geocoded stops to display on map." />;
  }

  const center = hasDepot
    ? { lat: depotLat!, lng: depotLng! }
    : { lat: geoStops[0].customerAddress!.lat!, lng: geoStops[0].customerAddress!.lng! };

  const failedFallback = (
    <MapPlaceholder message="Google Maps couldn't start — the site's API key was rejected or the Maps script was blocked. Contact your administrator." />
  );

  return (
    <MapErrorBoundary fallback={failedFallback}>
      <APIProvider apiKey={MAPS_KEY}>
        <MapsApiGate fallback={failedFallback}>
          <Map
            defaultCenter={center}
            defaultZoom={11}
            mapId="template-route-map"
            gestureHandling="greedy"
            disableDefaultUI={false}
            style={{ width: "100%", height: "100%" }}
          >
            <MapContent
              stops={stops}
              selectedStopId={selectedStopId}
              onSelectStop={onSelectStop}
              onRemoveStop={onRemoveStop}
              depotLat={depotLat}
              depotLng={depotLng}
              depotAddress={depotAddress}
            />
          </Map>
        </MapsApiGate>
      </APIProvider>
    </MapErrorBoundary>
  );
}
