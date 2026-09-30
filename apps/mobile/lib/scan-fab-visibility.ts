/**
 * B246 Option C — visibility rule for the order-edit line-list scan FAB.
 *
 * `cause-ruling.md` §2/§3: the FAB stays hidden while pricing is not ready
 * (REG-B62 — the picker is the only place a line gets priced, so nothing
 * scan-shaped may act before the customer's contract loads), while the
 * product picker is open, while the price-edit modal is open, or while any
 * other transparent modal on the screen is up; visible only when none of
 * those hold. Every one of those modals is `<Modal transparent>`, so the
 * screen behind it — the FAB included — stays visible through the scrim;
 * the driver adjust screen sets the same precedent (`adjust.tsx:474` hides
 * the FAB behind its licence guard).
 *
 * `pickerOpen` is defensive: at the only call site (edit-items.tsx) the FAB
 * renders solely on the `!showPicker` branch of a ternary, so `pickerOpen`
 * is structurally always false there today. It stays part of the rule so a
 * future re-layout that lifts the FAB outside that ternary can't un-hide it
 * under the picker.
 */
export interface ScanFabVisibilityInput {
  pricingReady: boolean;
  pickerOpen: boolean;
  priceModalOpen: boolean;
  /**
   * Any other transparent modal on the screen — unlisted-item, credit-note,
   * licence guard, credit-limit guard.
   */
  blockingModalOpen: boolean;
}

export function scanFabHidden(input: ScanFabVisibilityInput): boolean {
  return !(
    input.pricingReady &&
    !input.pickerOpen &&
    !input.priceModalOpen &&
    !input.blockingModalOpen
  );
}
