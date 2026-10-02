import * as React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SCAN_MODE_STORAGE_KEY, parseScanMode, type ScanMode } from "@routeflow/scanning";

/**
 * Hold-to-scan (owner ruling 2026-09-24): the OPTIONAL per-device scan mode, default Continuous. Storage that fails must never
 * break the scanner: a failed read is Continuous, a failed write is swallowed (the choice still applies this session).
 */
export async function readScanMode(): Promise<ScanMode> {
  try {
    return parseScanMode(await AsyncStorage.getItem(SCAN_MODE_STORAGE_KEY));
  } catch {
    return "continuous";
  }
}

export async function writeScanMode(mode: ScanMode): Promise<void> {
  try {
    await AsyncStorage.setItem(SCAN_MODE_STORAGE_KEY, mode);
  } catch {
    // not remembered; still applied for this session
  }
}

/**
 * The scanner's mode + setter. `enabled` is the aimAssist opt-in: a default-off caller never touches storage and is always
 * Continuous.
 */
export function useScanMode(enabled: boolean): [ScanMode, (mode: ScanMode) => void] {
  const [mode, setModeState] = React.useState<ScanMode>("continuous");
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    void readScanMode().then((m) => {
      if (live) setModeState(m);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  const setMode = React.useCallback((next: ScanMode) => {
    setModeState(next);
    void writeScanMode(next);
  }, []);
  return [mode, setMode];
}
