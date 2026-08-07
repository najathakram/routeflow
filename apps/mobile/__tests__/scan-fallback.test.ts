/**
 * Web scan mode must always offer manual code entry. The embedded scanner
 * (split-view scan sheet) turns the help copy off, and a camera that streams
 * but never decodes — poor light, damaged label, a webcam that won't focus —
 * raises no error, so gating manual entry on the help copy strands the
 * operator with no way to enter the code at all.
 */
import { scanFallbackContent } from "../lib/scan-fallback";

const STATES = [
  { hint: true, manualMode: false, hasError: false },
  { hint: true, manualMode: true, hasError: false },
  { hint: true, manualMode: false, hasError: true },
  { hint: true, manualMode: true, hasError: true },
  { hint: false, manualMode: false, hasError: false },
  { hint: false, manualMode: true, hasError: false },
  { hint: false, manualMode: false, hasError: true },
  { hint: false, manualMode: true, hasError: true },
];

describe("scanFallbackContent", () => {
  it("offers manual entry with the help copy off and the camera working", () => {
    const card = scanFallbackContent({ hint: false, manualMode: false, hasError: false });
    expect(card.showManualLink).toBe(true);
    expect(card.showHelp).toBe(false);
  });

  it("keeps a way into manual entry in every state", () => {
    for (const state of STATES) {
      const card = scanFallbackContent(state);
      expect(card.showManualInput || card.showManualLink).toBe(true);
      // The link switches manual entry ON; once open the input replaces it.
      expect(card.showManualInput).toBe(state.manualMode);
      expect(card.showManualLink).toBe(!state.manualMode);
    }
  });

  it("keeps the help copy behind the hint flag", () => {
    expect(scanFallbackContent({ hint: true, manualMode: false, hasError: false }).showHelp).toBe(
      true,
    );
    expect(scanFallbackContent({ hint: false, manualMode: true, hasError: false }).showHelp).toBe(
      false,
    );
  });

  it("replaces the help copy with the camera error while one stands", () => {
    const card = scanFallbackContent({ hint: true, manualMode: true, hasError: true });
    expect(card.showError).toBe(true);
    expect(card.showHelp).toBe(false);
  });

  it("reports no error when there is none", () => {
    expect(scanFallbackContent({ hint: false, manualMode: false, hasError: false }).showError).toBe(
      false,
    );
  });
});
