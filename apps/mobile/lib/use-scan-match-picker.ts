import { useCallback, useRef, useState } from "react";
import type { PickMatchFn } from "./scan-suggestion";

export interface ScanMatchPickerProps<T> {
  visible: boolean;
  matches: T[];
  confirmText: string;
  /** A row's Add/Apply button. */
  onChoose: (product: T) => void;
  /** Cancel, backdrop or hardware back — writes nothing. */
  onClose: () => void;
}

/**
 * State for `ScanMatchPickerSheet`: `open` is the `pick` callback `runScanDecision` takes. Nothing
 * is committed until `onChoose(row)`; `onClose` only fires the cancel callback.
 */
export function useScanMatchPicker<T = any>(): {
  open: PickMatchFn<T>;
  props: ScanMatchPickerProps<T>;
} {
  const [state, setState] = useState<{ matches: T[]; confirmText: string } | null>(null);
  const commitRef = useRef<((p: T) => void) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const open: PickMatchFn<T> = useCallback((matches, confirmText, onCommit, onCancel) => {
    commitRef.current = onCommit;
    cancelRef.current = onCancel;
    setState({ matches, confirmText });
  }, []);

  const onChoose = useCallback((product: T) => {
    const commit = commitRef.current;
    commitRef.current = null;
    cancelRef.current = null;
    setState(null);
    commit?.(product);
  }, []);

  const onClose = useCallback(() => {
    const cancel = cancelRef.current;
    commitRef.current = null;
    cancelRef.current = null;
    setState(null);
    cancel?.();
  }, []);

  return {
    open,
    props: {
      visible: state !== null,
      matches: state?.matches ?? [],
      confirmText: state?.confirmText ?? "Add",
      onChoose,
      onClose,
    },
  };
}
