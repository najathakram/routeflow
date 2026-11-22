/**
 * One panel shape for every hand-rolled `fixed inset-0` dialog in inventory / purchase orders:
 * the panel is capped at the viewport, the header stays, the body scrolls and the footer with the
 * action buttons stays in view. Layout: panel > header + <form MODAL_FORM> > body + footer.
 */
export const MODAL_PANEL =
  "flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-xl bg-white shadow-xl";
export const MODAL_FORM = "flex min-h-0 flex-1 flex-col";
export const MODAL_BODY = "min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5";
export const MODAL_FOOTER =
  "flex shrink-0 justify-end gap-2 border-t border-surface-border px-6 py-3";
