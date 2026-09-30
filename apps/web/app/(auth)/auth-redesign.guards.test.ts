import * as fs from "fs";
import * as path from "path";

// Regression FENCE for the auth redesign — NOT part of the red gate.
// .claude/pipeline/2026-09-07-auth-redesign/test-plan.md
//
// Every assertion here is an ABSENCE guard: the artifacts it bans (design-preview
// leftovers, `next/image` imports, bundled font/asset URLs) are not in the tree today,
// so these tests are green BY DESIGN before the implementation and must stay green
// after it. They cannot be red-gate tests — a test that can only go red once an
// implementation introduces the banned artifact proves nothing about the requirement
// being unmet. They live in their own file so the red gate
// (`auth-redesign.static.test.ts`) contains only tests that fail today.
const WEB_ROOT = path.resolve(__dirname, "..", "..");

const AUTH_PAGE_PATHS = [
  "app/(auth)/login/page.tsx",
  "app/(auth)/signup/page.tsx",
  "app/(auth)/signup/check-email/page.tsx",
  "app/(auth)/forgot-password/page.tsx",
  "app/(auth)/reset-password/page.tsx",
  "app/buyer/login/page.tsx",
  "app/buyer/register/page.tsx",
  "app/buyer/forgot-password/page.tsx",
  "app/buyer/reset-password/page.tsx",
  "app/buyer/verify-email/page.tsx",
  "app/buyer/verify-merge/page.tsx",
  "app/buyer/change-password/page.tsx",
  "app/buyer/invite/[token]/page.tsx",
  "app/change-password/page.tsx",
  "app/verify-email/page.tsx",
];

function readAuthPage(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

const IGNORE_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", "coverage", ".git"]);

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const AUTH_COMPONENTS_DIR = path.join(WEB_ROOT, "components", "auth");

/** Shipped sources only — a test file naming a banned string is not a leftover. */
function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

// ---------------------------------------------------------------------------
// T2b (moved) — none of the 15 pages, nor components/auth/**, carry design-preview
// artifacts or placeholder/demo copy left over from the redesign mock (R3).
// "routeflow.info" is deliberately NOT banned: its only occurrences are legitimate
// tenant-subdomain explanatory comments in app/(auth)/login/page.tsx.
// ---------------------------------------------------------------------------

const BANNED_PREVIEW_STRINGS = [
  "rf-preview-note",
  "Design preview",
  "Sample-only",
  "demo@example.com",
  "useHydrated",
  "readOnly",
];

describe("no design-preview leftovers in the reskinned auth surface — T2b (R3)", () => {
  it.each(BANNED_PREVIEW_STRINGS)(
    'zero references to "%s" across the 15 auth pages and components/auth/** (T2b)',
    (needle) => {
      const files = [
        ...AUTH_PAGE_PATHS.map((relPath) => path.join(WEB_ROOT, relPath)),
        ...walkFiles(AUTH_COMPONENTS_DIR),
      ].filter((f) => fs.existsSync(f) && !isTestFile(f));
      const hits: Array<{ file: string; line: number }> = [];
      for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        text.split("\n").forEach((line, i) => {
          if (line.includes(needle))
            hits.push({ file: path.relative(WEB_ROOT, file), line: i + 1 });
        });
      }
      expect(hits).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// T2e (moved) — no page or components/auth/** imports next/image (R8).
// (The repo-wide guard components/no-next-image.test.ts is T3; this narrows it to
// the auth surface.)
// ---------------------------------------------------------------------------

describe("no next/image import in the reskinned auth surface — T2e (R8)", () => {
  it("none of the 15 auth pages import next/image (T2e)", () => {
    const hits = AUTH_PAGE_PATHS.filter((relPath) =>
      /from ["']next\/image["']/.test(readAuthPage(relPath)),
    );
    expect(hits).toEqual([]);
  });

  it("components/auth/** imports no next/image (T2e)", () => {
    const hits = walkFiles(AUTH_COMPONENTS_DIR)
      .filter((f) => fs.existsSync(f))
      .filter((f) => /from ["']next\/image["']/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(WEB_ROOT, f));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T2c's "no new font/asset" absence half used to live here, but it read a
// missing stylesheet as "" and so held vacuously before the implementation. It
// now sits inside the `exists (T2c)` red-gate test in
// app/(auth)/auth-redesign.static.test.ts, AFTER the existsSync assertion, so
// the two `not.toContain` checks can only be evaluated against a real file.
// ---------------------------------------------------------------------------
