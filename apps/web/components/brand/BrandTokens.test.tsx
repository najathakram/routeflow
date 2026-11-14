import { renderToStaticMarkup } from "react-dom/server";
import { loadPalette, paletteCss } from "@routeflow/types/brand";
import { BrandTokens } from "./BrandTokens";
import { brandTokensTag } from "@/lib/static-site-page";

describe("BrandTokens", () => {
  it("renders the one brand-tokens style with every palette colour, as the static pages get it", () => {
    const html = renderToStaticMarkup(<BrandTokens />);
    expect(html).toBe(brandTokensTag(loadPalette()));
    expect(html).toContain(paletteCss(loadPalette()));
    expect(html.match(/<style id="brand-tokens">/g)).toHaveLength(1);
  });
});
