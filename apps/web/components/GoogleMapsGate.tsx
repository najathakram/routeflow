"use client";

import * as React from "react";
import { APILoadingStatus, useApiLoadingStatus } from "@vis.gl/react-google-maps";

/**
 * Containment for Google Maps failures.
 *
 * When the Maps JS API rejects the key at runtime (gm_authFailure →
 * InvalidKeyMapError etc.), @vis.gl/react-google-maps tears the map down while
 * mounted AdvancedMarkers still reference it; the marker's `map` setter then
 * throws from inside React's commit phase and the nearest error boundary — the
 * dashboard-wide one — replaces the ENTIRE page with "Something went wrong".
 * A maps problem must never cost more than the map pane, so every map surface
 * wraps its APIProvider subtree in both pieces below.
 */

/**
 * Swaps in `fallback` when the Maps API reports AUTH_FAILURE or FAILED.
 * Must be rendered inside an <APIProvider> (it reads the load status from
 * that context). Unmounting the <Map> subtree in the same commit the status
 * flips also detaches markers before they can touch the dead map instance.
 */
export function MapsApiGate({
  fallback,
  children,
}: {
  fallback: React.ReactNode;
  children: React.ReactNode;
}) {
  const status = useApiLoadingStatus();

  if (status === APILoadingStatus.AUTH_FAILURE || status === APILoadingStatus.FAILED) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}

/**
 * Error boundary for anything the status gate can't prevent (the auth-failure
 * teardown races React's commit, and Maps internals have thrown from marker
 * attach/detach). Renders `fallback` instead of letting the exception reach
 * the dashboard error boundary.
 */
export class MapErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error("Google Maps render error:", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
