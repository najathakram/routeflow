"use client";

import * as React from "react";

/**
 * Drive mode (pos-cost-roles-spec §4): "Role = permissions; mode = layout." A
 * one-tap avatar-menu toggle that swaps the field layout on for admins/operators
 * who can also act as a driver (`canActAsDriver`) — no logout, no permission
 * change, no draft loss. Persisted in localStorage so it survives reloads and
 * is picked up by any screen (e.g. the topbar indicator, my-runs reskin).
 *
 * SSR-safe: server render always sees `driveMode: false`; the real value is
 * read from localStorage in an effect after mount, then mirrored on every
 * change (in this tab) and cross-tab (via the `storage` event).
 */

const STORAGE_KEY = "rf-drive-mode";

type Listener = () => void;
const listeners = new Set<Listener>();

function readStored(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStored(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    // localStorage unavailable (private mode, quota) — drive mode just won't persist.
  }
  listeners.forEach((l) => l());
}

export interface UseDriveMode {
  driveMode: boolean;
  setDriveMode: (on: boolean) => void;
  toggle: () => void;
}

export function useDriveMode(): UseDriveMode {
  // Default false on the server and on first client render (avoids a
  // hydration mismatch); synced from localStorage in the effect below.
  const [driveMode, setDriveModeState] = React.useState(false);

  React.useEffect(() => {
    setDriveModeState(readStored());

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setDriveModeState(readStored());
    };
    const onLocalChange = () => setDriveModeState(readStored());

    window.addEventListener("storage", onStorage);
    listeners.add(onLocalChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      listeners.delete(onLocalChange);
    };
  }, []);

  const setDriveMode = React.useCallback((on: boolean) => {
    writeStored(on);
    setDriveModeState(on);
  }, []);

  const toggle = React.useCallback(() => {
    setDriveMode(!readStored());
  }, [setDriveMode]);

  return { driveMode, setDriveMode, toggle };
}
