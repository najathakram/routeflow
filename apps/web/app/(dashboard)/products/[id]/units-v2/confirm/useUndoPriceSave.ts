import * as React from "react";
import type { UndoPriceSaveApi } from "./types";

/**
 * STUB until SPRINT-CONTRACT names the inverse-write hook (UX-V5 section 5 item 2): the real one is a
 * single inverse write that answers `{status:"changed", rows}` instead of writing when anything moved
 * since the save. Replace the body, keep the signature.
 */
export function useUndoPriceSave(productId: string): UndoPriceSaveApi {
  return React.useMemo(
    () => ({
      undo: () => Promise.reject(new Error(`useUndoPriceSave is a stub (product ${productId})`)),
    }),
    [productId],
  );
}
