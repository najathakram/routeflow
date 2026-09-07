/**
 * F08 round 3 (finding 7): `restockForReason` in `apps/mobile/lib/returns-logic.ts`
 * is a hand-typed mirror of the server's `NO_RESTOCK_REASONS`
 * (`apps/api/src/returns/returns.service.ts`) — the exact class of duplicated rule
 * CLAUDE.md / L-072 names as the cause of three shipped bugs. They agree today and
 * nothing keeps them agreeing: add WRONG_ITEM to the server set and the mobile
 * screens keep sending `restock: true`, which wins over the server default, so
 * damaged-class goods restock from mobile while the same return restocks correctly
 * from web — with no test in either workspace going red.
 *
 * A shared VALUE import is not available here: `apps/api` may not runtime-import a
 * workspace package (`no-runtime-workspace-imports.spec.ts`; it also breaks
 * `node dist/main.js`), and mobile's jest maps `@routeflow/types` to a stub. So this
 * is a STATIC-SCAN pin, modelled on `apps/api/src/common/enum-parity.spec.ts`'s
 * regression layer: both files are read as TEXT from the repo root — no runtime
 * import of either side — and the two rules are diffed as sets.
 */

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SERVER_FILE = path.join(REPO_ROOT, "apps/api/src/returns/returns.service.ts");
const MOBILE_FILE = path.join(REPO_ROOT, "apps/mobile/lib/returns-logic.ts");

function readSource(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Every double-quoted literal inside a snippet, in source order. */
function quotedLiterals(snippet: string): string[] {
  const matches = snippet.match(/"[^"]*"/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

/** The members of the server's `NO_RESTOCK_REASONS` set literal. */
function serverNoRestockReasons(text: string): string[] {
  const m = text.match(/const NO_RESTOCK_REASONS = new Set\(\[([^\]]*)\]\)/);
  return m ? quotedLiterals(m[1]) : [];
}

/** The body of mobile's `restockForReason`, comments and all. */
function mobileRestockBody(text: string): string {
  const m = text.match(
    /export function restockForReason\s*\([^)]*\)\s*:\s*boolean\s*\{([\s\S]*?)\n\}/,
  );
  return m ? m[1] : "";
}

const SERVER_REASONS = serverNoRestockReasons(readSource(SERVER_FILE));
const MOBILE_BODY = mobileRestockBody(readSource(MOBILE_FILE));
const MOBILE_BODY_NORMALIZED = MOBILE_BODY.replace(/\s+/g, " ").trim();

describe("F08: mobile restockForReason stays set-equal to the server's NO_RESTOCK_REASONS", () => {
  it("finds both rules in source (guards against a silently-vacuous suite)", () => {
    expect(SERVER_REASONS.length).toBeGreaterThan(0);
    expect(MOBILE_BODY_NORMALIZED.length).toBeGreaterThan(0);
  });

  it('the mobile rule is a plain chain of `reason !== "X"` comparisons', () => {
    // The set diff below only means something if the mobile rule really is
    // "not one of these literals": a body that branched, called a helper, or used
    // `===` would name the same strings while computing something else entirely.
    expect(MOBILE_BODY_NORMALIZED).toMatch(
      /^return reason !== "[A-Z_]+"( && reason !== "[A-Z_]+")*;$/,
    );
  });

  it("names exactly the server's no-restock reasons — no extra, none missing", () => {
    const mobileReasons = quotedLiterals(MOBILE_BODY_NORMALIZED);
    expect(new Set(mobileReasons)).toEqual(new Set(SERVER_REASONS));
    // One comparison per reason: a duplicated literal would pass a set diff while
    // leaving the chain out of step with the server rule.
    expect(mobileReasons.length).toBe(SERVER_REASONS.length);
  });
});
