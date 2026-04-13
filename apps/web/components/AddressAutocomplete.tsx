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
  placeId: string;
  display: string;
  mainText: string;
  secondaryText: string;
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

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

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

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputId = label?.toLowerCase().replace(/\s+/g, "-") ?? "street";

  // ── Fetch suggestions from backend proxy ─────────────────────────────────

  const fetchSuggestions = React.useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/public/places/autocomplete?q=${encodeURIComponent(q.trim())}`,
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { suggestions?: Suggestion[] };
      const list = data.suggestions ?? [];
      setSuggestions(list);
      setIsOpen(list.length > 0);
    } catch {
      setSuggestions([]);
      setIsOpen(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ── Select a suggestion: fetch full address components ────────────────────

  const handleSelect = React.useCallback(
    async (s: Suggestion) => {
      setIsOpen(false);
      setActiveIndex(-1);
      onChange(s.mainText || s.display);

      try {
        const res = await fetch(
          `${API_BASE}/public/places/details?placeId=${encodeURIComponent(s.placeId)}`,
        );
        if (!res.ok) throw new Error(`${res.status}`);
        const parts = (await res.json()) as AddressParts;
        if (parts.street) onChange(parts.street);
        onAddressSelect(parts);
      } catch {
        // Fallback: use the display text as the street value
        onAddressSelect({ street: s.mainText || s.display, city: "", state: "", zip: "" });
      }
    },
    [onChange, onAddressSelect],
  );

  // ── Input handlers ────────────────────────────────────────────────────────

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    setActiveIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 300);
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
              key={s.placeId}
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
              <span className="leading-snug">
                <span className="font-medium">{s.mainText}</span>
                {s.secondaryText && (
                  <span className="text-navy/60">{" "}{s.secondaryText}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
