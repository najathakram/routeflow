import { readFileSync } from "fs";
import { join } from "path";

/**
 * Row 500: the web and mobile clients send x-client and x-app-version on every request. Browsers preflight
 * custom headers, so CORS must let both through. main.ts sets no allowedHeaders, which makes the cors
 * package reflect the request's Access-Control-Request-Headers; this pin fails if an explicit list is
 * added later without both names.
 */
describe("CORS lets the client identity headers through (row 500)", () => {
  const src = readFileSync(join(__dirname, "..", "main.ts"), "utf8");
  const block = src.slice(src.indexOf("app.enableCors("), src.indexOf("Global exception filters"));

  it("either reflects request headers (no allowedHeaders) or lists both names", () => {
    const m = /allowedHeaders\s*:\s*(\[[^\]]*\]|"[^"]*")/.exec(block);
    if (!m) return;
    const list = m[1].toLowerCase();
    expect(list).toContain("x-client");
    expect(list).toContain("x-app-version");
  });

  it("enableCors is still configured in main.ts", () => {
    expect(block).toContain("enableCors");
  });
});
