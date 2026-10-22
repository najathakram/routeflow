/**
 * apple-ux r4 Q28/Q30: every quantity and price field of an Edit Items line shares ONE control height and
 * ONE quantity input style, whether the line is a boxed (cases) line or a plain one.
 */
// 44 px below lg (touch widths), 36 px from lg (row 730).
export const EDIT_CONTROL_H = "h-9 max-lg:h-11";
export const EDIT_QTY_INPUT = `${EDIT_CONTROL_H} w-14 rounded border border-surface-border bg-white px-1.5 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500`;
