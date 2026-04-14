'use client';

import * as React from 'react';
import {
  APIProvider,
  Map,
  AdvancedMarker,
  InfoWindow,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { MapPin } from 'lucide-react';
import type { RouteRunStop } from '@/lib/api/routes';
import { useGoogleMapsKey } from '@/hooks/useGoogleMapsKey';

// ─── Marker colour by stop status ────────────────────────────────────────────

function markerColor(status: RouteRunStop['status']): string {
  if (status === 'COMPLETED') return '#22c55e';
  if (status === 'IN_PROGRESS') return '#3b82f6';
  return '#94a3b8';
}

// ─── Numbered stop bubble ─────────────────────────────────────────────────────

function MarkerBubble({
  stop,
  selected,
}: {
  stop: RouteRunStop;
  selected: boolean;
}) {
  const bg = markerColor(stop.status);
  const isActive = stop.status === 'IN_PROGRESS';

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
      {isActive && (
        <span
          style={{
            position: 'absolute',
            inset: -6,
            borderRadius: '50%',
            backgroundColor: bg,
            opacity: 0.3,
            animation: 'routemap-ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite',
          }}
        />
      )}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          backgroundColor: bg,
          border: selected ? '3px solid #fff' : '2px solid rgba(255,255,255,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          transform: selected ? 'scale(1.15)' : 'scale(1)',
          transition: 'transform 0.1s',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff', lineHeight: 1 }}>
          {stop.stopNumber}
        </span>
      </div>
    </div>
  );
}

// ─── Polyline connecting stops in order ───────────────────────────────────────

function PolylineLayer({ stops }: { stops: RouteRunStop[] }) {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');

  React.useEffect(() => {
    if (!map || !mapsLib) return;

    const path = [...stops]
      .sort((a, b) => a.stopNumber - b.stopNumber)
      .filter((s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null)
      .map((s) => ({ lat: s.customerAddress!.lat!, lng: s.customerAddress!.lng! }));

    if (path.length < 2) return;

    const polyline = new mapsLib.Polyline({
      path,
      geodesic: true,
      strokeColor: '#3b82f6',
      strokeOpacity: 0.7,
      strokeWeight: 3,
      map,
    });

    return () => polyline.setMap(null);
  }, [map, mapsLib, stops]);

  return null;
}

// ─── Auto-fit bounds to all markers ──────────────────────────────────────────

function FitBoundsLayer({ stops }: { stops: RouteRunStop[] }) {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');

  React.useEffect(() => {
    if (!map || !mapsLib) return;

    const coordStops = stops.filter(
      (s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null,
    );
    if (coordStops.length === 0) return;

    const bounds = new (google.maps as any).LatLngBounds();
    coordStops.forEach((s) =>
      bounds.extend({ lat: s.customerAddress!.lat!, lng: s.customerAddress!.lng! }),
    );
    map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
  }, [map, mapsLib, stops]);

  return null;
}

// ─── InfoWindow content ───────────────────────────────────────────────────────

function StopInfoWindow({
  stop,
  onClose,
}: {
  stop: RouteRunStop;
  onClose: () => void;
}) {
  return (
    <InfoWindow
      position={{
        lat: stop.customerAddress!.lat!,
        lng: stop.customerAddress!.lng!,
      }}
      onCloseClick={onClose}
    >
      <div style={{ maxWidth: 220, padding: '4px 0' }}>
        <p style={{ fontWeight: 700, fontSize: 14, margin: '0 0 4px', color: '#0f172a' }}>
          {stop.customer?.businessName ?? 'Customer'}
        </p>
        {stop.customerAddress && (
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 8px' }}>
            {stop.customerAddress.line1}, {stop.customerAddress.city}
          </p>
        )}
        {stop.orders && stop.orders.length > 0 && (
          <div>
            <p style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 4px' }}>
              Orders
            </p>
            {stop.orders.map((o) => (
              <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                <span style={{ color: '#0f172a' }}>#{o.orderNumber}</span>
                <span style={{ color: '#94a3b8' }}>{o.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </InfoWindow>
  );
}

// ─── No-key fallback ──────────────────────────────────────────────────────────

function MapPlaceholder({ stops }: { stops: RouteRunStop[] }) {
  const done = stops.filter((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED').length;
  const active = stops.filter((s) => s.status === 'IN_PROGRESS').length;
  const pending = stops.filter((s) => s.status === 'PENDING').length;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface-raised">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-surface-border bg-white p-8 text-center shadow-card">
        <MapPin className="h-10 w-10 text-navy/20" />
        <div>
          <p className="font-semibold text-navy">Map view unavailable</p>
          <p className="mt-1 text-sm text-navy/50">
            Google Maps is not configured for this deployment. Contact your administrator to enable the map.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <span className="rounded-full bg-success-bg px-3 py-1 text-xs font-medium text-success">
            {done} completed
          </span>
          {active > 0 && (
            <span className="rounded-full bg-brand-100 px-3 py-1 text-xs font-medium text-brand-700">
              {active} in progress
            </span>
          )}
          <span className="rounded-full border border-surface-border bg-surface-raised px-3 py-1 text-xs font-medium text-navy/60">
            {pending} upcoming
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Exported component ───────────────────────────────────────────────────────

export function RouteMap({ stops }: { stops: RouteRunStop[] }) {
  const MAPS_KEY = useGoogleMapsKey();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const stopsWithCoords = stops.filter(
    (s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null,
  );
  const selectedStop = selectedId ? stopsWithCoords.find((s) => s.id === selectedId) : null;

  if (!MAPS_KEY) return <MapPlaceholder stops={stops} />;

  // If we have a key but no stops have geocoded addresses, show the placeholder
  // instead of rendering an empty map with default San Francisco center
  if (stopsWithCoords.length === 0) return <MapPlaceholder stops={stops} />;

  return (
    <>
      <style>{`@keyframes routemap-ping { 75%, 100% { transform: scale(2); opacity: 0; } }`}</style>
      <APIProvider apiKey={MAPS_KEY}>
        <Map
          mapId="DEMO_MAP_ID"
          defaultCenter={{ lat: 37.7749, lng: -122.4194 }}
          defaultZoom={12}
          gestureHandling="greedy"
          disableDefaultUI={false}
          style={{ width: '100%', height: '100%' }}
          onClick={() => setSelectedId(null)}
        >
          <PolylineLayer stops={stopsWithCoords} />
          <FitBoundsLayer stops={stopsWithCoords} />

          {stopsWithCoords.map((stop) => (
            <AdvancedMarker
              key={stop.id}
              position={{ lat: stop.customerAddress!.lat!, lng: stop.customerAddress!.lng! }}
              onClick={() => setSelectedId((prev) => (prev === stop.id ? null : stop.id))}
            >
              <MarkerBubble stop={stop} selected={selectedId === stop.id} />
            </AdvancedMarker>
          ))}

          {selectedStop && (
            <StopInfoWindow stop={selectedStop} onClose={() => setSelectedId(null)} />
          )}
        </Map>
      </APIProvider>
    </>
  );
}
