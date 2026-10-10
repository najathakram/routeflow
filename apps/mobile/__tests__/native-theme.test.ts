/**
 * #2330: the native theme is built from the Ledger source, and the tenant accent ramp is the
 * same math web applies. `@routeflow/ui/*` is stubbed in this jest config, so the sources are
 * imported by path.
 */
import {
  ledgerAccents,
  ledgerBrand,
  ledgerDensity,
  ledgerInk,
  ledgerRadius,
  ledgerStatus,
  ledgerSurface,
  ledgerTypeScale,
} from "../../../packages/ui/src/tokens/ledger";
import { accentForSurface, shadeHex, TENANT_SHADE } from "../../../packages/ui/src/tokens/accent";
import {
  nativeFonts,
  nativeMoney,
  nativeOverline,
  nativeShadow,
  nativeShadows,
  nativeType,
} from "../../../packages/ui/src/native/tokens";
import { buildNativeTheme } from "../../../packages/ui/src/native/theme";
import { borderRadius, colors, shadows } from "../../../packages/ui/src/tokens";
import { surfaceForSegments } from "../lib/theme-surface";

describe("legacy @routeflow/ui/tokens: ruling (a), additive only", () => {
  it("keeps every pre-Ledger value, so existing screens do not move", () => {
    expect(colors.brand[500]).toBe("#0b9e9b");
    expect(colors.brand[50]).toBe("#f0faf9");
    expect(colors.navy.DEFAULT).toBe("#1B3A5C");
    expect(colors.surface.raised).toBe("#f8fafc");
    expect(colors.surface.border).toBe("#e2e8f0");
    expect(borderRadius.DEFAULT).toBe(8);
    expect(shadows.card).toEqual({
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 3,
      elevation: 2,
    });
  });

  it("adds Ledger values under new keys", () => {
    expect(colors.ink).toBe(ledgerInk);
    expect(colors.info.DEFAULT).toBe(ledgerStatus.info.fg);
    expect(colors.surface.sunken).toBe(ledgerSurface.sunken);
    expect(borderRadius.ctl).toBe(ledgerRadius.ctl);
    expect(borderRadius.card).toBe(ledgerRadius.card);
  });

  it("the native kit's Ledger values differ from the legacy ones (the kit is the new look)", () => {
    expect(ledgerBrand[500]).toBe("#14A39F");
    expect(nativeShadows.card.shadowOpacity).toBe(0.05);
  });
});

describe("native type, money and shadows", () => {
  it("maps each weight to its own Spline family and em letter-spacing to px", () => {
    expect(nativeType.display).toEqual({
      fontFamily: "SplineSans_700Bold",
      fontSize: 32,
      lineHeight: 40,
      letterSpacing: -0.96,
    });
    expect(nativeType.heading1.fontFamily).toBe(nativeFonts.ui[600]);
    expect(nativeType.body.fontFamily).toBe(nativeFonts.ui[400]);
    expect(nativeType.label.fontFamily).toBe(nativeFonts.ui[500]);
    expect(nativeType.caption.fontSize).toBe(ledgerTypeScale.caption.size);
  });

  it("money is mono 500 with tabular numerals", () => {
    expect(nativeMoney.fontFamily).toBe("SplineSansMono_500Medium");
    expect(nativeMoney.fontVariant).toEqual(["tabular-nums"]);
  });

  it("overline is 11px uppercase ink-500 at 0.08em", () => {
    expect(nativeOverline).toMatchObject({
      fontSize: 11,
      letterSpacing: 0.88,
      textTransform: "uppercase",
      color: ledgerInk[500],
    });
  });

  it("converts a CSS shadow to iOS props plus Android elevation", () => {
    expect(nativeShadow({ x: 0, y: 8, blur: 24, rgb: [15, 27, 45], opacity: 0.14 })).toEqual({
      shadowColor: "#0f1b2d",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.14,
      shadowRadius: 12,
      elevation: 8,
    });
  });
});

describe("accent ramp (same math as web TenantProvider)", () => {
  it("shades toward black and white", () => {
    expect(shadeHex("#14a39f", -0.14)).toBe("#118c89");
    expect(shadeHex("#000000", 0.5)).toBe("#808080");
    expect(shadeHex("14a39f", 0)).toBe("#14a39f");
  });

  it("returns a non-hex input unchanged", () => {
    expect(shadeHex("#abc", -0.14)).toBe("#abc");
    expect(shadeHex("teal", 0.9)).toBe("teal");
  });

  it("operator follows a custom tenant brand; mist stays static", () => {
    const a = accentForSurface("operator", "#3355aa");
    expect(a.accent).toBe("#3355aa");
    expect(a.strong).toBe(shadeHex("#3355aa", TENANT_SHADE.strong));
    expect(a.deep).toBe(shadeHex("#3355aa", TENANT_SHADE.deep));
    expect(a.soft).toBe(shadeHex("#3355aa", TENANT_SHADE.soft));
    expect(a.mist).toBe(ledgerAccents.operator.mist);
  });

  it("operator without a valid brand keeps the exact Ledger teal ramp", () => {
    expect(accentForSurface("operator", null)).toBe(ledgerAccents.operator);
    expect(accentForSurface("operator", "not-a-colour")).toBe(ledgerAccents.operator);
  });

  it("buyer is always emerald, even when the tenant has a brand", () => {
    expect(accentForSurface("buyer", "#3355aa")).toBe(ledgerAccents.buyer);
  });
});

describe("buildNativeTheme + surfaceForSegments", () => {
  it("buyer surface: emerald accent, 52px rows, #fff on accent", () => {
    const t = buildNativeTheme({ surface: "buyer", tenantPrimary: "#3355aa" });
    expect(t.accent.accent).toBe(ledgerAccents.buyer.accent);
    expect(t.density).toEqual(ledgerDensity.buyer);
    expect(t.onAccent).toBe("#ffffff");
  });

  it("operator surface: tenant accent, 44px rows", () => {
    const t = buildNativeTheme({ surface: "operator", tenantPrimary: "#3355aa" });
    expect(t.accent.accent).toBe("#3355aa");
    expect(t.density.rowHeight).toBe(44);
  });

  it("only the (customer) group is the buyer surface", () => {
    expect(surfaceForSegments(["(customer)", "home"])).toBe("buyer");
    expect(surfaceForSegments(["(operator)"])).toBe("operator");
    expect(surfaceForSegments(["(driver)"])).toBe("operator");
    expect(surfaceForSegments(["(auth)", "login"])).toBe("operator");
    expect(surfaceForSegments([])).toBe("operator");
  });
});
