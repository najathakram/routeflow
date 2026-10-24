import { RegulatedVisibilityService } from "../../buyer/regulated-visibility.service";

/**
 * Test provider for the regulated-category gate OrderTemplatesService now requires: no category is locked, so a buyer
 * read or write is judged by the portal rule alone. Specs that exercise the gate itself provide their own double.
 */
export const regulatedGateOpenProvider = {
  provide: RegulatedVisibilityService,
  useValue: { computeGate: async () => ({ hiddenIds: new Set<string>(), locked: [] }) },
};
