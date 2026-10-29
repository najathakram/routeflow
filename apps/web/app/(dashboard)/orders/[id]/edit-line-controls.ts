/**
 * apple-ux r4 Q28/Q30: every quantity and price field of an Edit Items line shares ONE control height and
 * ONE quantity input style, whether the line is a boxed (cases) line or a plain one.
 */
export const EDIT_CONTROL_H = "h-9 max-lg:h-11";
/** W-961: a phone/tablet tap target (>= 44 x 44 px) for a text button in an Edit Items line; the desktop row is unchanged. */
export const EDIT_TAP_BELOW_LG =
  "max-lg:inline-flex max-lg:min-h-[44px] max-lg:min-w-[44px] max-lg:items-center max-lg:justify-center";
export const EDIT_QTY_INPUT = `${EDIT_CONTROL_H} w-14 rounded border border-surface-border bg-white px-1.5 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500`;
