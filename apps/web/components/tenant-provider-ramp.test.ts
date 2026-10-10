/**
 * #2330 pin: TenantProvider's accent ramp moved from a local `shade()` to the shared
 * `shadeHex` (`@routeflow/ui/accent`). The ramp output must stay byte-identical, so this pins
 * the shared function to (a) the exact values the old function produced for sample tenant colours
 * and (b) a frozen copy of the old function across a sweep of valid and malformed inputs.
 */
import { shadeHex, TENANT_SHADE } from "@routeflow/ui/accent";

/** The pre-#2330 `shade()` from `tenant-provider.tsx`, frozen verbatim as the reference. */
function legacyShade(hex: string, amount: number): string {
  const clean = hex.replace("#", "");
  const ch = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)].map((h) => parseInt(h, 16));
  if (ch.some((n) => isNaN(n))) return hex;
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return (
    "#" +
    ch
      .map((c) =>
        Math.round(c + (target - c) * t)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/** [strong, deep, soft] as the old TenantProvider wrote them. */
const GOLDEN: Record<string, [string, string, string]> = {
  "#14a39f": ["#118c89", "#0e7572", "#e8f6f5"],
  "#14A39F": ["#118c89", "#0e7572", "#e8f6f5"],
  "#000000": ["#000000", "#000000", "#e6e6e6"],
  "#ffffff": ["#dbdbdb", "#b8b8b8", "#ffffff"],
  "#3355aa": ["#2c4992", "#253d7a", "#ebeef7"],
  "#e11d48": ["#c2193e", "#a21534", "#fce8ed"],
  "#7c3aed": ["#6b32cc", "#592aab", "#f2ebfd"],
  "#0f1b2d": ["#0d1727", "#0b1320", "#e7e8ea"],
  "#f59e0b": ["#d38809", "#b07208", "#fef5e7"],
  "#808080": ["#6e6e6e", "#5c5c5c", "#f2f2f2"],
  "14a39f": ["#118c89", "#0e7572", "#e8f6f5"],
};

describe("tenant accent ramp stays byte-identical (#2330)", () => {
  it("TenantProvider's mix amounts are unchanged", () => {
    expect(TENANT_SHADE).toEqual({ strong: -0.14, deep: -0.28, soft: 0.9 });
  });

  it.each(Object.entries(GOLDEN))("%s → the exact ramp the old shade() produced", (hex, ramp) => {
    expect([
      shadeHex(hex, TENANT_SHADE.strong),
      shadeHex(hex, TENANT_SHADE.deep),
      shadeHex(hex, TENANT_SHADE.soft),
    ]).toEqual(ramp);
  });

  it("matches the frozen old shade() across a sweep, malformed inputs included", () => {
    const inputs: string[] = ["#abc", "teal", "", "#12345g", "#1234567", "rgb(1,2,3)", "#ABCDEF"];
    for (let r = 0; r < 256; r += 17)
      for (let g = 0; g < 256; g += 51)
        for (let b = 0; b < 256; b += 85)
          inputs.push("#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join(""));
    const amounts = [TENANT_SHADE.strong, TENANT_SHADE.deep, TENANT_SHADE.soft, 0, -1, 1, 0.5];
    for (const hex of inputs)
      for (const a of amounts)
        expect(`${hex}@${a}=${shadeHex(hex, a)}`).toBe(`${hex}@${a}=${legacyShade(hex, a)}`);
  });
});
