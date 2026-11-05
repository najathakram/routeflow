import * as fs from "fs";
import * as path from "path";
import {
  AI_BUSINESS_KEY_REFUSED_MESSAGE,
  AI_NOT_AVAILABLE_MESSAGE,
  aiKeyRefusedException,
  aiNotAvailableException,
} from "../common/ai-key-failure";

/**
 * SA-1102 F-1102-T (the class): the words a business reads when the key behind an AI call fails. Only a business's OWN
 * refused key is something the business can fix (AI_KEY_INVALID, "update or remove it in Settings"); RouteFlow's key
 * refused, or no key set up, reads as "not available right now" (AI_UNAVAILABLE). No site says "not configured", names
 * an environment variable, or sends a business to Settings for a key it does not own.
 */
const SRC = path.join(__dirname, "..");

/** The four files that call Anthropic (the census pins this list both ways). */
const SITES = [
  "bookkeeping/bookkeeping.service.ts",
  "route-optimization/route-analysis.service.ts",
  "supplier-statements/supplier-statements.service.ts",
  "vendor-bills/vendor-bills.service.ts",
];

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FORBIDDEN =
  /ANTHROPIC_API_KEY|not configured|not been configured|system administrator|Settings → AI|invalid or expired/i;

describe("AI key failure text (SA-1102 F-1102-T)", () => {
  it.each(SITES)("%s has no key text of its own (it uses common/ai-key-failure)", (file) => {
    const text = strip(fs.readFileSync(path.join(SRC, file), "utf8"));
    expect([file, text.match(FORBIDDEN)?.[0] ?? null]).toEqual([file, null]);
  });

  it("a business's own refused key is the one thing it is told to fix: 400 AI_KEY_INVALID with the Settings pointer", () => {
    const e = aiKeyRefusedException("business");
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toEqual({
      message: AI_BUSINESS_KEY_REFUSED_MESSAGE,
      code: "AI_KEY_INVALID",
    });
    expect(AI_BUSINESS_KEY_REFUSED_MESSAGE).toBe(
      "Your Claude key was refused. Update or remove it in Settings → AI & Integrations.",
    );
  });

  it("RouteFlow's refused key, or no key, is 503 AI_UNAVAILABLE and never points the business at Settings", () => {
    for (const e of [aiKeyRefusedException("routeflow"), aiNotAvailableException()]) {
      expect(e.getStatus()).toBe(503);
      expect(e.getResponse()).toEqual({
        message: AI_NOT_AVAILABLE_MESSAGE,
        code: "AI_UNAVAILABLE",
      });
    }
    expect(AI_NOT_AVAILABLE_MESSAGE).toBe(
      "AI scanning isn't available right now. Please try again later.",
    );
    expect(AI_NOT_AVAILABLE_MESSAGE).not.toMatch(FORBIDDEN);
  });

  it("each site's 401/403 path asks the helper with the key's real source, and no key is the helper's 503", () => {
    for (const file of SITES) {
      const text = strip(fs.readFileSync(path.join(SRC, file), "utf8"));
      expect([file, /\bnew BadRequestException\([^)]*AI_KEY_INVALID/s.test(text)]).toEqual([
        file,
        false,
      ]);
    }
    const bills = fs.readFileSync(path.join(SRC, SITES[3]), "utf8");
    expect(bills).toMatch(/aiKeyRefusedException\(source\)/);
    const statements = fs.readFileSync(path.join(SRC, SITES[2]), "utf8");
    expect(statements).toMatch(/aiKeyRefusedException\(source\)/);
    for (const file of [SITES[0], SITES[2], SITES[3]])
      expect(fs.readFileSync(path.join(SRC, file), "utf8")).toMatch(/aiNotAvailableException\(\)/);
  });
});
