/**
 * Bounded widths for the qty/price inputs that live inside a horizontal row,
 * plus the arithmetic that proves a row still has a usable text column.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * react-native-web renders `<TextInput>` as a real `<input>`. RNW's base style
 * (`exports/TextInput/index.js`) declares no `width`, so the element carries the
 * UA `size=20` intrinsic width — roughly 177px at these font sizes — and
 * `min-width: auto`. Neither exists on native, where Yoga sizes a TextInput to
 * its text.
 *
 * The stepper pill wrapping such an input is a `View`, and RNW's base `View`
 * style sets `flexShrink: 0`. So the pill contributes ~245px of max-content to
 * its row and refuses to give any of it back. The sibling `{flex: 1}` name
 * column collapses to ~31px, and at that width RNW's `word-wrap: break-word` on
 * `<Text>` renders one character per line — the reported "item name and
 * quantity appear vertically" defect.
 *
 * Two things do NOT fix it, and both look like they should:
 *   - `minWidth: 0` on the input — RNW's `View` base already sets `minWidth: 0`,
 *     and on the input itself a floor cannot cap an inflated base size.
 *   - `flexShrink: 1` on the input — the pill is `flexShrink: 0`, so no space
 *     deficit ever reaches the input to distribute.
 *
 * Only a DEFINITE `width` collapses the pill's max-content contribution. Each
 * value below is the width its input already reaches at `maxLength={5}` on
 * native, so no native row grows — the pill merely stops resizing while typing.
 *
 * Keep these in sync with the style objects that consume them; the invariants in
 * `__tests__/row-layout.test.ts` assert over this module, so reverting a call
 * site to `minWidth`-only leaves nothing registered here and fails the suite.
 */

/** Definite widths for every qty TextInput that sits in a flex row. */
export const QTY_INPUT_WIDTH = {
  /** QtyStepper `md` — catalog rows, scan tray. 16px font, 2px h-padding. */
  md: 52,
  /** QtyStepper `mini` — boxed case/loose band, scan tray rows. 14px font. */
  mini: 46,
  /** NewOrderScreen / invoices-new `CartStepperRow`. 16px font, 6px h-padding. */
  cart: 60,
  /** edit-items' hand-rolled stepper duplicate. 16px font, 4px h-padding. */
  edit: 56,
} as const;

/**
 * Money inputs take `maxWidth`, not `width`: their content is variable-length
 * and uncapped (`$99999.99`), so native content-hugging is desirable. 96px never
 * binds on native (8 chars at 15px ≈ 84px incl. padding) — it exists purely to
 * clamp the web intrinsic width.
 */
export const MONEY_INPUT_MAX_WIDTH = 96;

/** Widest a bounded control may be before it starves the row's text column. */
export const MAX_ROW_CONTROL_WIDTH = 130;

/** Narrowest phone-web viewport we support (iPhone SE 1st gen, 2016). */
export const MIN_SUPPORTED_VIEWPORT = 320;

/** What the field actually carries — iPhone 13/14/15 and most modern Androids. */
export const COMMON_VIEWPORT = 390;

/**
 * A row's text column at {@link COMMON_VIEWPORT} must stay at least this wide.
 * ~100px shows a dozen characters of a product name before the ellipsis.
 */
export const MIN_TEXT_COLUMN = 100;

/**
 * The floor at {@link MIN_SUPPORTED_VIEWPORT}. A 320px row carrying a 48px
 * thumbnail AND a qty stepper genuinely cannot spare 100px, so the invariant
 * there is weaker: enough for a truncated-but-legible name (~9 characters),
 * never the collapse-to-one-character-per-line the fix exists to prevent.
 */
export const MIN_TEXT_COLUMN_NARROW = 72;

/**
 * Total width of a −/input/+ stepper pill. Mirrors the `pill` style: two square
 * buttons, the input, symmetric padding, and a hairline border on each side.
 */
export function stepperPillWidth(spec: {
  btn: number;
  inputWidth: number;
  padding: number;
  border?: number;
}): number {
  const border = spec.border ?? 1;
  return spec.btn * 2 + spec.inputWidth + spec.padding * 2 + border * 2;
}

/**
 * Width left for the flexible text column of a row, given everything fixed
 * beside it. `gaps` is the total of every gap in the row, `leading` the width of
 * any fixed element before the text (a thumbnail, say).
 */
export function textColumnWidth(spec: {
  viewport: number;
  listPadding: number;
  rowPadding: number;
  leading: number;
  gaps: number;
  controlWidth: number;
}): number {
  return (
    spec.viewport -
    spec.listPadding * 2 -
    spec.rowPadding * 2 -
    spec.leading -
    spec.gaps -
    spec.controlWidth
  );
}
