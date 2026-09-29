import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { planScanPriceEdit } from "./scan-price-edit";

interface ScanPriceEditActions {
  isUnlisted: (id: string) => boolean;
  isSpecialLine: (id: string) => boolean;
  showInline: (message: string) => void;
}

interface Args {
  scanOpen: boolean;
  setScanOpen: (open: boolean) => void;
  setPriceEditId: (id: string | null) => void;
  /** Read lazily (ref-backed) so the memoized tray callback never goes stale. */
  getActions: () => ScanPriceEditActions;
}

/**
 * B901 sequencing: a Modal cannot be presented over another Modal on iOS (it is
 * queued until the first dismisses). ScanOrderSheet is a Modal, so close it,
 * present the price modal after the dismissal, and reopen the scanner when the
 * price modal closes (closePriceEdit).
 */
export function useScanPriceEdit({ scanOpen, setScanOpen, setPriceEditId, getActions }: Args) {
  // Mirrors of scanOpen / "reopen the scan sheet when the price modal closes"
  // for the memoized tray callback, plus the pending present timer.
  const scanOpenRef = useRef(false);
  scanOpenRef.current = scanOpen;
  const resumeScanRef = useRef(false);
  const priceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Line whose price modal waits for the scan sheet to finish dismissing.
  const pendingPriceEditIdRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (priceTimerRef.current) clearTimeout(priceTimerRef.current);
    },
    [],
  );
  const onTrayEditPrice = useCallback(
    (id: string) => {
      const a = getActions();
      if (!a.isUnlisted(id) && a.isSpecialLine(id)) {
        a.showInline("Contract price — not editable on this order");
        return;
      }
      const plan = planScanPriceEdit(scanOpenRef.current, Platform.OS);
      if (plan.closeScan) setScanOpen(false);
      resumeScanRef.current = plan.resumeScanOnClose;
      if (priceTimerRef.current) clearTimeout(priceTimerRef.current);
      pendingPriceEditIdRef.current = id;
      if (plan.present === "now") {
        pendingPriceEditIdRef.current = null;
        setPriceEditId(id);
      } else if (plan.present === "timer") {
        priceTimerRef.current = setTimeout(() => {
          priceTimerRef.current = null;
          pendingPriceEditIdRef.current = null;
          setPriceEditId(id);
        }, plan.fallbackDelayMs);
      }
      // "onDismiss": handleScanSheetDismiss presents it once the sheet is gone.
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const handleScanSheetDismiss = useCallback(() => {
    const id = pendingPriceEditIdRef.current;
    if (id == null) return;
    pendingPriceEditIdRef.current = null;
    setPriceEditId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const closePriceEdit = () => {
    setPriceEditId(null);
    if (resumeScanRef.current) {
      resumeScanRef.current = false;
      setScanOpen(true);
    }
  };
  return { onTrayEditPrice, handleScanSheetDismiss, closePriceEdit };
}
