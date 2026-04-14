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
import { MapPin, Trash2 } from 'lucide-react';
import { cn } from '@routeflow/ui/web';
import type { RouteTemplateStop } from '@/lib/api/routes';
import { useGoogleMapsKey } from '@/hooks/useGoogleMapsKey';

// ─── Numbered stop bubble ──────────────────────────────────────────────────────

function MarkerBubble({ stop, selected }: { stop: RouteTemplateStop; selected: boolean }) {
  const size = selected ? 36 : 32;
  const bg = selected ? '#3b82f6' : '#94a3b8';
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        border: '2px solid white',
        boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontWeight: 700,
        fontSize: selected ? 13 : 11,
        transition: 'all 0.15s',
      }}
    >
      {stop.stopNumber}
    </div>
  );
}

// ─── Polyline between stops ────────────────────────────────────────────────────

function PolylineLayer({ stops }: { stops: RouteTemplateStop[] }) {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');
  const polylineRef = React.useRef<google.maps.Polyline | null>(null);

  React.useEffect(() => {
    if (!map || !mapsLib) return;
    const coords = stops
      .filter((s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null)
      .sort((a, b) => a.stopNumber - b.stopNumber)
      .map((s) => ({ lat: s.customerAddress!.lat!, lng: s.customerAddress!.lng! }));

    if (polylineRef.current) polylineRef.current.setMap(null);
    polylineRef.current = new mapsLib.Polyline({
      path: coords,
      strokeColor: '#3b82f6',
      strokeOpacity: 0.8,
      strokeWeight: 3,
      map,
    });
    return () => { polylineRef.current?.setMap(null); };
  }, [map, mapsLib, stops]);

  return null;
}

// ─── Auto-fit bounds ───────────────────────────────────────────────────────────

function FitBoundsLayer({ stops }: { stops: RouteTemplateStop[] }) {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');
  const fitted = React.useRef(false);

  React.useEffect(() => {
    if (!map || !mapsLib || fitted.current) return;
    const geo = stops.filter((s) => s.customerAddress?.lat != null);
    if (!geo.length) return;
    const bounds = new (google.maps as any).LatLngBounds();
    geo.forEach((s) => bounds.extend({ lat: s.customerAddress!.lat!, lng: s.customerAddress!.lng! }));
    map.fitBounds(bounds, 80);
    fitted.current = true;
  }, [map, mapsLib, stops]);

  return null;
}

// ─── Placeholder when no key / no stops ───────────────────────────────────────

function MapPlaceholder({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-raised text-navy/40">
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
}

function MapContent({
  stops,
  selectedStopId,
  onSelectStop,
  onRemoveStop,
}: TemplateRouteMapProps) {
  const [openInfoId, setOpenInfoId] = React.useState<string | null>(null);

  const geoStops = stops.filter(
    (s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null,
  );

  return (
    <>
      <FitBoundsLayer stops={geoStops} />
      <PolylineLayer stops={stops} />

      {geoStops.map((stop) => (
        <React.Fragment key={stop.id}>
          <AdvancedMarker
            position={{ lat: stop.customerAddress!.lat!, lng: stop.customerAddress!.lng! }}
            onClick={() => {
              setOpenInfoId(openInfoId === stop.id ? null : stop.id);
              onSelectStop?.(stop.id);
            }}
          >
            <MarkerBubble stop={stop} selected={selectedStopId === stop.id || openInfoId === stop.id} />
          </AdvancedMarker>

          {openInfoId === stop.id && (
            <InfoWindow
              position={{ lat: stop.customerAddress!.lat!, lng: stop.customerAddress!.lng! }}
              onCloseClick={() => setOpenInfoId(null)}
              pixelOffset={[0, -42]}
            >
              <div className="min-w-[180px] space-y-2 p-1 text-sm">
                <p className="font-semibold text-navy">
                  #{stop.stopNumber} — {stop.customer?.businessName ?? 'Customer'}
                </p>
                <p className="text-xs text-navy/60">
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
}: TemplateRouteMapProps) {
  const { key: MAPS_KEY, loading: mapsKeyLoading } = useGoogleMapsKey();
  const geoStops = stops.filter((s) => s.customerAddress?.lat != null);

  if (mapsKeyLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-raised">
        <MapPin className="h-10 w-10 animate-pulse text-navy/20" />
        <p className="text-sm text-navy/50">Loading map…</p>
      </div>
    );
  }

  if (!MAPS_KEY) {
    return <MapPlaceholder message="Google Maps API key not configured." />;
  }

  if (!geoStops.length) {
    return <MapPlaceholder message="No geocoded stops to display on map." />;
  }

  const center = {
    lat: geoStops[0].customerAddress!.lat!,
    lng: geoStops[0].customerAddress!.lng!,
  };

  return (
    <APIProvider apiKey={MAPS_KEY}>
      <Map
        defaultCenter={center}
        defaultZoom={11}
        mapId="template-route-map"
        gestureHandling="greedy"
        disableDefaultUI={false}
        style={{ width: '100%', height: '100%' }}
      >
        <MapContent
          stops={stops}
          selectedStopId={selectedStopId}
          onSelectStop={onSelectStop}
          onRemoveStop={onRemoveStop}
        />
      </Map>
    </APIProvider>
  );
}
