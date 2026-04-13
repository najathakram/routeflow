"use client";

import * as React from "react";
import { MapPin, Loader2 } from "lucide-react";
import { cn } from "@routeflow/ui/web";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AddressParts {
  street: string;
  city: string;
  state: string;
  zip: string;
}

interface Suggestion {
  id: string;
  display: string;
  /** Google place_id — used to fetch full address details */
  placeId: string;
}

export interface AddressAutocompleteProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onAddressSelect: (parts: AddressParts) => void;
  error?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

// ─── Google Maps loader ──────────────────────────────────────────────────────

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";

/** Load the Google Maps JS SDK once, returning a promise that resolves when ready. */
let _loadPromise: Promise<void> | null = null;

function loadGoogleMaps(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.maps?.places) return Promise.resolve();
  if (_loadPromise) return _loadPromise;

  _loadPromise = new Promise<void>((resolve, reject) => {
    // Check again in case another script loaded it
    if (window.google?.maps?.places) { resolve(); return; }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(script);
  });

  return _loadPromise;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddressAutocomplete({
  label,
  value,
  onChange,
  onAddressSelect,
  error,
  placeholder = "Start typing an address\u2026",
  className,
  disabled,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [mapsReady, setMapsReady] = React.useState(false);

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const autocompleteRef = React.useRef<google.maps.places.AutocompleteService | null>(null);
  const placesRef = React.useRef<google.maps.places.PlacesService | null>(null);
  const attrDivRef = React.useRef<HTMLDivElement | null>(null);

  const inputId = label?.toLowerCase().replace(/\s+/g, "-") ?? "street";

  // ── Load Google Maps SDK ───────────────────────────────────────────────────

  React.useEffect(() => {
    if (!MAPS_KEY) return;
    loadGoogleMaps()
      .then(() => {
        autocompleteRef.current = new google.maps.places.AutocompleteService();
        // PlacesService needs a DOM element (can be hidden)
        if (!attrDivRef.current) {
          attrDivRef.current = document.createElement("div");
        }
        placesRef.current = new google.maps.places.PlacesService(attrDivRef.current);
        setMapsReady(true);
      })
      .catch(() => {
        // Google Maps failed to load — the component will still render,
        // but autocomplete will be unavailable
      });
  }, []);

  // ── Fetch suggestions via Google Places ─────────────────────────────────────

  const fetchSuggestions = React.useCallback(
    async (q: string) => {
      if (q.trim().length < 3 || !autocompleteRef.current) {
        setSuggestions([]);
        setIsOpen(false);
        return;
      }

      setIsLoading(true);
      try {
        const request: google.maps.places.AutocompletionRequest = {
          input: q,
          componentRestrictions: { country: "us" },
          types: ["address"],
        };

        autocompleteRef.current.getPlacePredictions(request, (results, status) => {
          setIsLoading(false);
          if (
            status !== google.maps.places.PlacesServiceStatus.OK ||
            !results
          ) {
            setSuggestions([]);
            setIsOpen(false);
            return;
          }

          const parsed: Suggestion[] = results.slice(0, 5).map((r) => ({
            id: r.place_id,
            display: r.description,
            placeId: r.place_id,
          }));

          setSuggestions(parsed);
          setIsOpen(parsed.length > 0);
        });
      } catch {
        setIsLoading(false);
        setSuggestions([]);
        setIsOpen(false);
      }
    },
    [],
  );

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    setActiveIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 300);
  };

  const handleSelect = (s: Suggestion) => {
    setIsOpen(false);
    setActiveIndex(-1);

    if (!placesRef.current) {
      onChange(s.display);
      return;
    }

    // Fetch full place details to get structured address components
    placesRef.current.getDetails(
      { placeId: s.placeId, fields: ["address_components"] },
      (place, status) => {
        if (
          status !== google.maps.places.PlacesServiceStatus.OK ||
          !place?.address_components
        ) {
          onChange(s.display);
          return;
        }

        const get = (type: string): string =>
          place.address_components!.find((c) => c.types.includes(type))?.short_name ?? "";

        const streetNumber = get("street_number");
        const route = get("route");
        const street = streetNumber ? `${streetNumber} ${route}` : route;
        const city = get("locality") || get("sublocality") || get("neighborhood");
        const state = get("administrative_area_level_1");
        const zip = get("postal_code");

        onChange(street);
        onAddressSelect({ street, city, state, zip });
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setIsOpen(false);
      setActiveIndex(-1);
    }
  };

  // ── Outside click ─────────────────────────────────────────────────────────

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  React.useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className={cn("relative flex flex-col gap-1", className)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-navy">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => suggestions.length > 0 && setIsOpen(true)}
          placeholder={!MAPS_KEY ? "Enter address manually" : (mapsReady ? placeholder : "Loading\u2026")}
          autoComplete="off"
          disabled={disabled || (!mapsReady && !!MAPS_KEY)}
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-invalid={!!error}
          role="combobox"
          className={cn(
            "h-10 w-full rounded border border-surface-border bg-white px-3 pr-8 text-sm text-navy placeholder:text-navy/40 transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent",
            error && "border-danger focus:ring-danger",
            disabled && "cursor-not-allowed opacity-50 bg-surface-raised",
          )}
        />
        {isLoading ? (
          <Loader2 className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-navy/30" />
        ) : (
          <MapPin className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/20" />
        )}
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      {isOpen && suggestions.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-[100] mt-1 w-full overflow-hidden rounded-lg border border-surface-border bg-white shadow-xl"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(s);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              className={cn(
                "flex cursor-pointer items-start gap-2 px-3 py-2.5 text-sm transition-colors",
                i === activeIndex
                  ? "bg-brand-50 text-brand-700"
                  : "text-navy hover:bg-surface-raised",
                i > 0 && "border-t border-surface-border",
              )}
            >
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-400" />
              <span className="leading-snug">{s.display}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
