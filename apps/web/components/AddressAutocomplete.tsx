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
  street: string;
  city: string;
  state: string;
  zip: string;
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

// ─── Photon (OpenStreetMap) parser ────────────────────────────────────────────

function parseFeature(f: Record<string, unknown>): Suggestion | null {
  const p = (f.properties as Record<string, string | undefined>) ?? {};
  const streetLine = p.housenumber
    ? `${p.housenumber} ${p.street ?? p.name ?? ""}`.trim()
    : (p.street ?? p.name ?? "").trim();
  if (!streetLine) return null;

  const city = p.city ?? p.town ?? p.village ?? p.county ?? "";
  const state = p.state ?? "";
  const zip = p.postcode ?? "";

  const displayParts = [streetLine];
  if (city) displayParts.push(city);
  if (state && zip) displayParts.push(`${state} ${zip}`);
  else if (state) displayParts.push(state);
  else if (zip) displayParts.push(zip);
  // Show country for non-US results
  if (p.countrycode && p.countrycode !== "US") displayParts.push(p.country ?? p.countrycode);

  const geometry = f.geometry as { coordinates?: number[] } | undefined;
  return {
    id: `${(geometry?.coordinates ?? []).join(",")}-${streetLine}`,
    display: displayParts.join(", "),
    street: streetLine,
    city,
    state,
    zip,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddressAutocomplete({
  label,
  value,
  onChange,
  onAddressSelect,
  error,
  placeholder = "Start typing an address…",
  className,
  disabled,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);

  const abortRef = React.useRef<AbortController | null>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const inputId = label?.toLowerCase().replace(/\s+/g, "-") ?? "street";

  // ── Fetch suggestions ────────────────────────────────────────────────────

  const fetchSuggestions = React.useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsLoading(true);
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lang=en`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error("fetch error");
      const data = (await res.json()) as { features?: Record<string, unknown>[] };

      const seen = new Set<string>();
      const parsed: Suggestion[] = [];
      for (const f of data.features ?? []) {
        const s = parseFeature(f);
        if (!s) continue;
        const key = `${s.street}|${s.city}`;
        if (seen.has(key)) continue;
        seen.add(key);
        parsed.push(s);
        if (parsed.length >= 5) break;
      }

      setSuggestions(parsed);
      setIsOpen(parsed.length > 0);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setSuggestions([]);
        setIsOpen(false);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    setActiveIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 350);
  };

  const handleSelect = (s: Suggestion) => {
    onChange(s.street);
    onAddressSelect({ street: s.street, city: s.city, state: s.state, zip: s.zip });
    setSuggestions([]);
    setIsOpen(false);
    setActiveIndex(-1);
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
      abortRef.current?.abort();
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
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
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
          <li className="border-t border-surface-border px-3 py-1.5 text-right">
            <span className="text-[10px] text-navy/30">Powered by OpenStreetMap</span>
          </li>
        </ul>
      )}
    </div>
  );
}
