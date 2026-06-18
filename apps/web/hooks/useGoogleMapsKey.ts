"use client";

import { useEffect, useState, useCallback } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

/**
 * Fetches the Google Maps API key from the backend at runtime.
 *
 * Why not use process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY?
 * Next.js NEXT_PUBLIC_* vars are baked in at Docker build time.
 * Railway doesn't pass them as --build-arg, so the key is always empty
 * in the production bundle. This hook loads it from the API instead.
 */

// Module-level promise so multiple components share the same fetch
let _keyPromise: Promise<string> | null = null;
let _resolvedKey: string | undefined;

function fetchKey(): Promise<string> {
  if (_keyPromise) return _keyPromise;

  // Check build-time env var first (works in local dev)
  const buildTimeKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
  if (buildTimeKey) {
    _resolvedKey = buildTimeKey;
    _keyPromise = Promise.resolve(buildTimeKey);
    return _keyPromise;
  }

  const base = API_BASE.replace(/\/api\/v1\/?$/, "/api/v1");
  _keyPromise = fetch(`${base}/public/places/config`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const k = data?.googleMapsKey ?? "";
      _resolvedKey = k;
      return k;
    })
    .catch(() => {
      _resolvedKey = "";
      return "";
    });

  return _keyPromise;
}

export function useGoogleMapsKey(): { key: string; loading: boolean } {
  const [key, setKey] = useState(_resolvedKey ?? "");
  const [loading, setLoading] = useState(_resolvedKey === undefined);

  useEffect(() => {
    // If already resolved (cached from a previous component mount), use it
    if (_resolvedKey !== undefined) {
      setKey(_resolvedKey);
      setLoading(false);
      return;
    }

    let cancelled = false;
    fetchKey().then((k) => {
      if (!cancelled) {
        setKey(k);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { key, loading };
}
