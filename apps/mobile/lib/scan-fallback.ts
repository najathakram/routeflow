/**
 * What the web scanner's fallback card shows for a given camera state.
 *
 * Manual entry is an ESCAPE HATCH, not a help affordance: a camera that opens
 * and streams fine but never decodes (poor light, damaged label, a webcam that
 * won't focus) raises no error and flips no fallback flag, so gating manual
 * entry on the optional help copy strands the operator with no way in. Hence
 * the invariant every caller relies on: one of `showManualInput` /
 * `showManualLink` is always true.
 */
export interface ScanFallbackContent {
  /** Camera failure copy — replaces the help copy while it stands. */
  showError: boolean;
  /** Idle help copy. Off for embedded scanners whose host UI already explains itself. */
  showHelp: boolean;
  /** The type-a-code row (manual entry is already open). */
  showManualInput: boolean;
  /** The link that switches the camera out for manual entry. */
  showManualLink: boolean;
}

export function scanFallbackContent(state: {
  hint: boolean;
  manualMode: boolean;
  hasError: boolean;
}): ScanFallbackContent {
  return {
    showError: state.hasError,
    showHelp: !state.hasError && state.hint,
    showManualInput: state.manualMode,
    showManualLink: !state.manualMode,
  };
}
