import * as fs from "fs";
import * as path from "path";

/**
 * Post-dated check payments PR-1 — de-duplication contract for the check-lifecycle
 * forward-transition table.
 *
 * Before this PR, the SAME table (`CHECK_TRANSITIONS`, `RECORDED -> [DEPOSITED, BOUNCED],
 * DEPOSITED -> [CLEARED, BOUNCED], CLEARED -> [BOUNCED], BOUNCED -> []`) was hand-written THREE
 * times: apps/api/src/invoices/invoices.service.ts, apps/web/app/(dashboard)/invoices/[id]/
 * page.tsx, and apps/mobile/lib/payments-logic.ts (which also hand-declared its own local
 * `CheckStatus` type). `packages/types/api/checks.ts` is now the ONE canonical export; all three
 * call sites import from it instead.
 *
 * This spec reads each call site's actual CURRENT source text (never a re-typed "expected"
 * value) and asserts it no longer hand-declares a local `CHECK_TRANSITIONS` object literal,
 * proving the mirror is gone rather than merely that a shared export exists somewhere. It is RED
 * on the pre-dedup code (each file still declares `const/export const CHECK_TRANSITIONS: ... =
 * { RECORDED: [...` locally) and GREEN once all three import from `@routeflow/types` instead.
 *
 * N5 (binding — independent Opus review of the design): PR-1 exports ONLY the current V1 table
 * — no `CHECK_TRANSITIONS_V2`. The last describe block below guards that directly: it fails the
 * moment anyone adds a `CHECK_TRANSITIONS_V2` export to the shared package ahead of the PR that
 * is supposed to introduce it.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const CALL_SITES: Array<[string, string]> = [
  ["api", "apps/api/src/invoices/invoices.service.ts"],
  ["web", "apps/web/app/(dashboard)/invoices/[id]/page.tsx"],
  ["mobile", "apps/mobile/lib/payments-logic.ts"],
];

/** A hand-declared local object literal named CHECK_TRANSITIONS — `(export )?const
 *  CHECK_TRANSITIONS: ... = { RECORDED: [...` — the exact shape all three files had before this
 *  PR. Matches regardless of the type annotation's exact spelling. */
const LOCAL_DECLARATION_RE = /(?:export\s+)?const\s+CHECK_TRANSITIONS\s*:.*=\s*\{\s*\n\s*RECORDED:/;

/** True once the file imports `CHECK_TRANSITIONS` from the shared package. */
function importsSharedTable(text: string): boolean {
  return /import\s*\{[^}]*\bCHECK_TRANSITIONS\b[^}]*\}\s*from\s*["']@routeflow\/types["']/.test(
    text,
  );
}

describe("regression: CHECK_TRANSITIONS is no longer hand-mirrored at any of the three call sites", () => {
  it.each(CALL_SITES)(
    "%s (%s) imports the shared table instead of declaring its own",
    (_app, relPath) => {
      const text = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");

      // Fails TODAY (pre-dedup) on all three: each still hand-declares its own local object
      // literal, so this must be false and the import must be true post-fix.
      expect(LOCAL_DECLARATION_RE.test(text)).toBe(false);
      expect(importsSharedTable(text)).toBe(true);
    },
  );
});

describe("mobile: the local CheckStatus union is also gone, not just CHECK_TRANSITIONS", () => {
  it("payments-logic.ts imports CheckStatus from @routeflow/types rather than hand-declaring the union", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, "apps/mobile/lib/payments-logic.ts"), "utf8");
    expect(text).not.toMatch(
      /export type CheckStatus = "RECORDED" \| "DEPOSITED" \| "CLEARED" \| "BOUNCED"/,
    );
    expect(
      /import\s*\{[^}]*\btype CheckStatus\b[^}]*\}\s*from\s*["']@routeflow\/types["']/.test(text),
    ).toBe(true);
  });
});

describe("the shared table's values are exactly the V1 table every call site used to hand-write", () => {
  it("packages/types/api/checks.ts CHECK_TRANSITIONS matches byte-for-byte", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require("@routeflow/types") as {
      CHECK_TRANSITIONS?: Record<string, readonly string[]>;
    };
    expect(shared.CHECK_TRANSITIONS).toEqual({
      RECORDED: ["DEPOSITED", "BOUNCED"],
      DEPOSITED: ["CLEARED", "BOUNCED"],
      CLEARED: ["BOUNCED"],
      BOUNCED: [],
    });
  });
});

describe("N5: PR-1 ships V1 only — no CHECK_TRANSITIONS_V2 anywhere yet", () => {
  it("packages/types exports no CHECK_TRANSITIONS_V2 (that is a later PR's CheckTransitionService)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require("@routeflow/types") as Record<string, unknown>;
    expect(shared).not.toHaveProperty("CHECK_TRANSITIONS_V2");
  });

  it("packages/types/api/checks.ts source declares no V2 export (a comment naming it as a future PR's work is fine)", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, "packages/types/api/checks.ts"), "utf8");
    expect(text).not.toMatch(/export\s+(?:const|function|type)\s+CHECK_TRANSITIONS_V2/);
  });
});
