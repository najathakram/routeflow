/**
 * #2331 kit A: the pure style resolvers behind Button / IconButton / the text fields, pinned
 * against web `Button` / `Input` (`packages/ui/src/web/`). Imported by path because this jest
 * config stubs `@routeflow/ui/*`.
 */
import {
  BUTTON_SIZES,
  MIN_TOUCH,
  resolveButtonStyle,
  slopFor,
  type ButtonVariant,
} from "../../../packages/ui/src/native/button-style";
import {
  FIELD_HEIGHT,
  FIELD_PLACEHOLDER,
  TEXTAREA_MIN_HEIGHT,
  resolveFieldStyle,
} from "../../../packages/ui/src/native/field-style";
import { buildNativeTheme } from "../../../packages/ui/src/native/theme";
import {
  ledgerAccents,
  ledgerBrand,
  ledgerInk,
  ledgerRadius,
  ledgerStatus,
  ledgerSurface,
} from "../../../packages/ui/src/tokens/ledger";
import { parseMoney, sanitizeMoneyInput } from "../lib/money-input";

const operator = buildNativeTheme({ surface: "operator" });
const buyer = buildNativeTheme({ surface: "buyer" });
const btn = (
  variant: ButtonVariant,
  extra: Partial<Parameters<typeof resolveButtonStyle>[0]> = {},
) =>
  resolveButtonStyle({
    variant,
    size: "md",
    pressed: false,
    disabled: false,
    theme: operator,
    ...extra,
  });

describe("Button: web sizes, 6px ctl radius, 44pt touch target", () => {
  it("visual heights match web (28 / 34 / 40)", () => {
    expect(BUTTON_SIZES.sm.height).toBe(28);
    expect(BUTTON_SIZES.md.height).toBe(34);
    expect(BUTTON_SIZES.lg.height).toBe(40);
    expect(btn("primary").container.borderRadius).toBe(ledgerRadius.ctl);
  });

  it("hitSlop lifts every size to at least 44pt tall", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const s = resolveButtonStyle({
        variant: "primary",
        size,
        pressed: false,
        disabled: false,
        theme: operator,
      });
      expect(BUTTON_SIZES[size].height + s.hitSlop.top + s.hitSlop.bottom).toBeGreaterThanOrEqual(
        MIN_TOUCH,
      );
    }
    expect(slopFor(44)).toBe(0);
    expect(slopFor(60)).toBe(0);
  });
});

describe("Button variants mirror web", () => {
  it("primary = accent-strong fill, deep when pressed, #fff text (surface-aware)", () => {
    expect(btn("primary").container.backgroundColor).toBe(ledgerAccents.operator.strong);
    expect(btn("primary", { pressed: true }).container.backgroundColor).toBe(
      ledgerAccents.operator.deep,
    );
    expect(btn("primary").label.color).toBe("#ffffff");
    expect(btn("primary", { theme: buyer }).container.backgroundColor).toBe(
      ledgerAccents.buyer.strong,
    );
  });

  it("primary follows a tenant brand on the operator surface", () => {
    const t = buildNativeTheme({ surface: "operator", tenantPrimary: "#3355aa" });
    expect(btn("primary", { theme: t }).container.backgroundColor).toBe(t.accent.strong);
  });

  it("secondary = paper, line-strong hairline, card shadow, ink-900 text", () => {
    const s = btn("secondary");
    expect(s.container.backgroundColor).toBe(ledgerSurface.paper);
    expect(s.container.borderWidth).toBe(1);
    expect(s.container.borderColor).toBe(ledgerSurface.lineStrong);
    expect(s.container.shadowOpacity).toBe(0.05);
    expect(s.label.color).toBe(ledgerInk[900]);
    expect(btn("secondary", { pressed: true }).container.backgroundColor).toBe(
      ledgerSurface.canvas,
    );
  });

  it("ghost = transparent ink-500, sunken + ink-900 when pressed", () => {
    expect(btn("ghost").container.backgroundColor).toBe("transparent");
    expect(btn("ghost").label.color).toBe(ledgerInk[500]);
    expect(btn("ghost", { pressed: true }).container.backgroundColor).toBe(ledgerSurface.sunken);
    expect(btn("ghost", { pressed: true }).label.color).toBe(ledgerInk[900]);
  });

  it("the destructive variant is named danger, with the danger fill and white text", () => {
    expect(btn("danger").container.backgroundColor).toBe(ledgerStatus.danger.fg);
    expect(btn("danger").label.color).toBe(ledgerSurface.paper);
  });

  it("link renders inline: no height, padding or radius, underlined accent-deep", () => {
    const s = btn("link");
    expect(s.container.height).toBeUndefined();
    expect(s.container.paddingHorizontal).toBe(0);
    expect(s.container.borderRadius).toBe(0);
    expect(s.label.textDecorationLine).toBe("underline");
    expect(s.label.color).toBe(ledgerAccents.operator.deep);
  });

  it("disabled halves opacity and ignores press feedback", () => {
    const s = btn("primary", { disabled: true, pressed: true });
    expect(s.container.opacity).toBe(0.5);
    expect(s.container.backgroundColor).toBe(ledgerAccents.operator.strong);
  });

  it("labels use Spline Sans 500 at the web size", () => {
    expect(btn("primary").label.fontFamily).toBe("SplineSans_500Medium");
    expect(btn("primary").label.fontSize).toBe(13);
  });
});

describe("text fields mirror web Input / Textarea", () => {
  const base = { focused: false, error: false, disabled: false };

  it("rest: 40 tall, 8px radius, line hairline, paper, 14px ink-900, 70% placeholder", () => {
    const s = resolveFieldStyle(base);
    expect(s.input.height).toBe(FIELD_HEIGHT);
    expect(s.input.borderRadius).toBe(ledgerRadius.default);
    expect(s.input.borderWidth).toBe(1);
    expect(s.input.borderColor).toBe(ledgerSurface.line);
    expect(s.input.backgroundColor).toBe(ledgerSurface.paper);
    expect(s.input.fontSize).toBe(14);
    expect(s.input.color).toBe(ledgerInk[900]);
    expect(s.placeholderTextColor).toBe(FIELD_PLACEHOLDER);
  });

  it("focus: 2px brand-500 ring, padding trimmed so the text does not shift", () => {
    const rest = resolveFieldStyle(base);
    const f = resolveFieldStyle({ ...base, focused: true });
    expect(f.input.borderWidth).toBe(2);
    expect(f.input.borderColor).toBe(ledgerBrand[500]);
    expect(f.input.paddingLeft + f.input.borderWidth).toBe(
      rest.input.paddingLeft + rest.input.borderWidth,
    );
  });

  it("error: danger border, even while focused; danger 12px message", () => {
    expect(resolveFieldStyle({ ...base, error: true }).input.borderColor).toBe(
      ledgerStatus.danger.fg,
    );
    expect(resolveFieldStyle({ ...base, error: true, focused: true }).input.borderColor).toBe(
      ledgerStatus.danger.fg,
    );
    expect(resolveFieldStyle(base).error).toMatchObject({
      fontSize: 12,
      color: ledgerStatus.danger.fg,
    });
  });

  it("disabled: 50% opacity on canvas, and never shows the focus ring", () => {
    const s = resolveFieldStyle({ ...base, disabled: true, focused: true });
    expect(s.input.opacity).toBe(0.5);
    expect(s.input.backgroundColor).toBe(ledgerSurface.canvas);
    expect(s.input.borderWidth).toBe(1);
  });

  it("textarea: min height 80, top-aligned, no fixed height", () => {
    const s = resolveFieldStyle({ ...base, multiline: true });
    expect(s.input.height).toBeUndefined();
    expect(s.input.minHeight).toBe(TEXTAREA_MIN_HEIGHT);
    expect(s.input.textAlignVertical).toBe("top");
  });

  it("the password toggle's inset only widens the right padding", () => {
    const s = resolveFieldStyle({ ...base, trailingInset: 28 });
    expect(s.input.paddingRight - s.input.paddingLeft).toBe(28);
  });

  it("label is 14px Spline 500 ink-900", () => {
    expect(resolveFieldStyle(base).label).toMatchObject({
      fontFamily: "SplineSans_500Medium",
      fontSize: 14,
      color: ledgerInk[900],
    });
  });
});

describe("money-input helpers moved to the kit, same behaviour via the old path", () => {
  it("the mobile re-export still sanitizes and parses", () => {
    expect(sanitizeMoneyInput("2.")).toBe("2.");
    expect(sanitizeMoneyInput("1,239")).toBe("1.23");
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("2.50")).toBe(2.5);
  });
});
