import * as fs from "fs";
import * as path from "path";
import { MARKETING_PAGE_PATHS } from "./marketing-routes";

// R-MKT — the public-route allow-lists that keep an expired-token visitor from
// being punted to /login must all come from MARKETING_PAGE_PATHS. Hand-typed
// copies in api-client.ts / auth-context.tsx are exactly how /privacy and
// /terms shipped missing from both sets (lesson L-072).
describe("R-MKT marketing route allow-lists", () => {
  it("MARKETING_PAGE_PATHS covers the legal pages (/privacy, /terms)", () => {
    expect(MARKETING_PAGE_PATHS).toContain("/privacy");
    expect(MARKETING_PAGE_PATHS).toContain("/terms");
  });

  // Static source read: importing api-client.ts / auth-context.tsx would pull
  // in axios + React and run module-level side effects for a text assertion.
  it.each([["api-client.ts"], ["auth-context.tsx"]])(
    "%s derives its marketing allow-list from MARKETING_PAGE_PATHS, not a literal",
    (file) => {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src).toContain("MARKETING_PAGE_PATHS");
      expect(src).not.toContain('"/retailers"');
    },
  );
});
