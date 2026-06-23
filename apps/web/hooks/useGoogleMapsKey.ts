"use client";

import { useEffect, useState } from "react";
import { apiClient } from "../lib/api-client";

/**
 * Fetches the Google Maps API key from the backend at runtime.
 *
 * Uses the authenticated apiClient so the request carries the operator's
 * Bearer token — the /public/places/config endpoint requires auth to prevent
 * the key from being served to unauthenticated callers.
 */

// Module-level cache so multiple components share a single fetch per session.
// Keyed on token so it re-fetches if the user logs out and a different user logs in.
let _cachedKey: string | undefined;

export function useGoogleMapsKey(): { key: string; loading: boolean } {
  const [key, setKey] = useState(_cachedKey ?? "");
  const [loading, setLoading] = useState(_cachedKey === undefined);

  useEffect(() => {
    if (_cachedKey !== undefined) {
      setKey(_cachedKey);
      setLoading(false);
      return;
    }

    // Check build-time env var first (works in local dev with NEXT_PUBLIC_GOOGLE_MAPS_KEY set)
    const buildTimeKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
    if (buildTimeKey) {
      _cachedKey = buildTimeKey;
      setKey(buildTimeKey);
      setLoading(false);
      return;
    }

    let cancelled = false;
    apiClient
      .get<{ googleMapsKey?: string }>("/public/places/config")
      .then(({ data }) => {
        const k = data?.googleMapsKey ?? "";
        _cachedKey = k;
        if (!cancelled) {
          setKey(k);
          setLoading(false);
        }
      })
      .catch(() => {
        _cachedKey = "";
        if (!cancelled) {
          setKey("");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { key, loading };
}
