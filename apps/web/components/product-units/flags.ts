/**
 * Per-level barcode / SKU fields (U-2 builds them, U-8 turns them on). The server already stores and checks
 * the codes; the UI stays HIDDEN until the lead flips this constant. `flags.test.ts` pins it to false.
 */
export const LEVEL_CODES_UI_ENABLED = false;
