/**
 * Mobile fit for the small confirm dialogs (ConfirmDialog and the add-on enable sheet), proved at
 * 390px in the #3224 pixel review: the 384px `max-w-sm` cap left 3px side margins in a 390px
 * viewport, and the 34px footer buttons were under the 44px tap target.
 *
 * Both are small-screen only (`sm` is 640px), so a desktop dialog is unchanged. Pass `DIALOG_FIT`
 * as the Modal `className` (it replaces `max-w-sm`) and `DIALOG_FOOTER_BUTTON` as each footer
 * Button's `className`.
 */
export const DIALOG_FIT = "max-w-[calc(100vw-2rem)] sm:max-w-sm";
export const DIALOG_FOOTER_BUTTON = "min-h-11 sm:min-h-0";
