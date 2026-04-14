"use client";

import { useEffect, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

/**
 * Fetches the Google Maps API key from the backend at runtime.
 *
 * Why not use process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY?
 * Next.js NEXT_PUBLIC_* vars are baked in at Docker build time.
 * Railway doesn't pass them as --build-arg, so the key is always empty
 * in the production bundle. This hook loads it from the API instead.
 */
let _cachedKey: string | null = null;

export function useGoogleMapsKey(): string {
  const [key, setKey] = useState(_cachedKey ?? "");

  useEffect(() => {
    if (_cachedKey !== null) {
      setKey(_cachedKey);
      return;
    }

    // Also check the build-time env var as a fast fallback for local dev
    const buildTimeKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
    if (buildTimeKey) {
      _cachedKey = buildTimeKey;
      setKey(buildTimeKey);
      return;
    }

    // Strip /api/v1 suffix to get the base origin for public endpoints
    const base = API_BASE.replace(/\/api\/v1\/?$/, "/api/v1");

    fetch(`${base}/public/places/config`, { cache: "force-cache" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const k = data?.googleMapsKey ?? "";
        _cachedKey = k;
        setKey(k);
      })
      .catch(() => {
        _cachedKey = "";
        setKey("");
      });
  }, []);

  return key;
}
