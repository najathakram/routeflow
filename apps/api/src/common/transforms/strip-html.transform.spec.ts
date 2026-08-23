import { plainToInstance } from "class-transformer";
import { StripHtml } from "./strip-html.transform";

/**
 * Pins the StripHtml contract: tags/attributes are removed, but the surviving
 * text is stored as PLAIN TEXT — literal characters, never HTML-entity-encoded.
 * Regression for the client-reported bug where "Smith & Sons" was persisted as
 * "Smith &amp; Sons" (sanitize-html re-encodes text nodes when serializing;
 * the transform must decode its output back).
 */

class TestDto {
  @StripHtml()
  value?: unknown;
}

const strip = (value: unknown): unknown => plainToInstance(TestDto, { value }).value;

describe("StripHtml", () => {
  it("round-trips plain text containing an ampersand unchanged", () => {
    expect(strip("Smith & Sons")).toBe("Smith & Sons");
  });

  it("round-trips every character sanitize-html entity-encodes", () => {
    const text = `Bits & Bobs < 5 > 3 "quoted" and Tom's`;
    expect(strip(text)).toBe(text);
  });

  it("still strips script tags including their content", () => {
    expect(strip("<script>alert(1)</script>")).toBe("");
  });

  it("strips tags and event-handler attributes but keeps the text", () => {
    expect(strip(`<a href="/x" onclick="evil()">Acme</a> Wholesale`)).toBe("Acme Wholesale");
    expect(strip("<b>Smith</b> & <i>Sons</i>")).toBe("Smith & Sons");
  });

  // Documented behavior: input is parsed as HTML, so entities the caller
  // pre-escaped decode to their literal characters — the stored value is
  // always plain text.
  it("decodes pre-escaped input exactly once", () => {
    expect(strip("a &amp; b")).toBe("a & b");
    // Double-escaped input decodes one level, proving no double-decode.
    expect(strip("a &amp;amp; b")).toBe("a &amp; b");
  });

  it("preserves literal entity text without collapsing it (&amp; decoded last)", () => {
    // The user's text literally contains "&lt;". Decoding &amp; before &lt;
    // would collapse this to "5 < 6".
    expect(strip("5 &amp;lt; 6")).toBe("5 &lt; 6");
  });

  it("passes non-string values through untouched", () => {
    expect(strip(123)).toBe(123);
    expect(strip(null)).toBeNull();
    expect(strip(undefined)).toBeUndefined();
    expect(strip(true)).toBe(true);
  });
});
