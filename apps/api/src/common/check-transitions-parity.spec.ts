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
 * `CheckStatus` type). `packages/types/api/checks.ts` is now the ONE canonical export.
 *
 * Web and mobile import the canonical export directly — both transpile workspace TS at build
 * time, so a value import is safe there, and this spec still asserts that for those two. The API
 * CANNOT import `@routeflow/types` at runtime (see `no-runtime-workspace-imports.spec.ts` — that
 * package ships raw TS with no build step, so a value import crashes `node dist/main.js` at
 * boot), so it keeps an API-local mirror instead (`apps/api/src/common/check-transitions.ts`).
 * For the API this spec instead pins that mirror value-equal to the canonical export by deep
 * equality — the actual guard against the two ever drifting apart, which is N5's real intent.
 *
 * This spec reads each call site's actual CURRENT source text (never a re-typed "expected"
 * value) and asserts it no longer hand-declares a local `CHECK_TRANSITIONS` object literal,
 * proving the mirror is gone rather than merely that a shared export exists somewhere.
 *
 * N5 (binding — independent Opus review of the design): PR-1 exports ONLY the current V1 table
 * — no `CHECK_TRANSITIONS_V2`. The last describe block below guards that directly: it fails the
 * moment anyone adds a `CHECK_TRANSITIONS_V2` export to the shared package ahead of the PR that
 * is supposed to introduce it.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const CALL_SITES: Array<[string, string]> = [
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

describe("regression: CHECK_TRANSITIONS is no longer hand-mirrored at web/mobile", () => {
  it.each(CALL_SITES)(
    "%s (%s) imports the shared table instead of declaring its own",
    (_app, relPath) => {
      const text = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");

      // Fails TODAY (pre-dedup) on both: each still hand-declares its own local object
      // literal, so this must be false and the import must be true post-fix.
      expect(LOCAL_DECLARATION_RE.test(text)).toBe(false);
      expect(importsSharedTable(text)).toBe(true);
    },
  );
});

describe("regression: the API never hand-mirrors CHECK_TRANSITIONS as a local object literal either", () => {
  it("invoices.service.ts declares no local CHECK_TRANSITIONS object literal", () => {
    const text = fs.readFileSync(
      path.join(REPO_ROOT, "apps/api/src/invoices/invoices.service.ts"),
      "utf8",
    );
    expect(LOCAL_DECLARATION_RE.test(text)).toBe(false);
  });
});

describe("API mirror: apps/api/src/common/check-transitions.ts stays value-equal to the canonical export", () => {
  it("invoices.service.ts imports CHECK_TRANSITIONS from the API-local mirror, not @routeflow/types", () => {
    const text = fs.readFileSync(
      path.join(REPO_ROOT, "apps/api/src/invoices/invoices.service.ts"),
      "utf8",
    );
    expect(importsSharedTable(text)).toBe(false);
    expect(
      /import\s*\{[^}]*\bCHECK_TRANSITIONS\b[^}]*\}\s*from\s*["']\.\.\/common\/check-transitions["']/.test(
        text,
      ),
    ).toBe(true);
  });

  it("the API-local mirror's CHECK_TRANSITIONS is deep-equal to packages/types/api/checks.ts's export", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const apiMirror = require("./check-transitions") as {
      CHECK_TRANSITIONS: Record<string, readonly string[]>;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const canonical = require("../../../../packages/types/api/checks") as {
      CHECK_TRANSITIONS: Record<string, readonly string[]>;
    };
    expect(apiMirror.CHECK_TRANSITIONS).toEqual(canonical.CHECK_TRANSITIONS);
  });
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
