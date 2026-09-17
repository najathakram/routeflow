import * as fs from "fs";
import * as path from "path";

// R2, R3, R4, R5, R7, R8, R11 — static/textual scans of the repo (no rendering).
// Every path is resolved from this file's own location so the test is
// independent of the process cwd (pattern: app/(marketing)/marketing-port.static.test.ts).
const WEB_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// T2a — the 15 real auth pages are reskinned onto <AuthShell> from
// "@/components/auth".
// ---------------------------------------------------------------------------

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

describe("all 15 auth pages are reskinned onto AuthShell — T2a (R2)", () => {
  it('every page imports from "@/components/auth" and renders <AuthShell (T2a)', () => {
    const missing = AUTH_PAGE_PATHS.filter((relPath) => {
      const source = readAuthPage(relPath);
      return !/from "@\/components\/auth"/.test(source) || !source.includes("<AuthShell");
    });
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T2c — components/auth/auth-shell.css carries the redesign tokens/breakpoint.
// (T2b's design-preview bans and T2e's next/image bans are ABSENCE assertions
// that are green today, so they cannot be red-gate tests — they live in
// app/(auth)/auth-redesign.guards.test.ts. T2c's "no new font/asset" half is the
// exception: it is folded into the `exists` test below, behind the existsSync
// assertion, because on a missing file it would otherwise hold vacuously.)
// ---------------------------------------------------------------------------

const AUTH_SHELL_CSS_PATH = path.join(WEB_ROOT, "components", "auth", "auth-shell.css");

describe("components/auth/auth-shell.css — T2c (R5)", () => {
  it("exists, and ships no new font/asset (T2c)", () => {
    expect(fs.existsSync(AUTH_SHELL_CSS_PATH)).toBe(true);
    // The "no new font/asset" half only means something once the file is real —
    // read it here rather than letting a missing file read as "" and pass.
    const css = fs.readFileSync(AUTH_SHELL_CSS_PATH, "utf8");
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("url(");
  });

  it.each([
    "--rf-navy: #10264d",
    "--rf-plum: #623691",
    "--rf-muted: #637992",
    ".rf-auth-story small",
    "@media (max-width: 850px)",
    "prefers-reduced-motion",
    "var(--font-geist-sans)",
    // The hero type belongs to the story panel only — an unscoped `.rf-auth h2`
    // out-specifies the in-card headings' own `text-xl`.
    ".rf-auth-story h2 {",
    // A navy focus ring is invisible on the navy story panel.
    ".rf-auth-story :focus-visible",
    // Longhands: the `padding`/`border` shorthands out-specify `pr-10`/`border-danger`.
    "padding-block: 12px",
    "padding-inline-start: 12px",
    "border-color: #ffffffed",
    'input[aria-invalid="true"]',
    // The footer row wraps its page-supplied links instead of colliding with them.
    ".rf-auth-footer-links",
  ])('contains "%s" (T2c)', (needle) => {
    // No existsSync short-circuit: a missing file reads as "" so each case fails on
    // the token it names, not on a shared file-missing proxy.
    const css = fs.existsSync(AUTH_SHELL_CSS_PATH)
      ? fs.readFileSync(AUTH_SHELL_CSS_PATH, "utf8")
      : "";
    expect(css).toContain(needle);
  });

  it("does not style h2 across the whole shell (T2c)", () => {
    const css = fs.existsSync(AUTH_SHELL_CSS_PATH)
      ? fs.readFileSync(AUTH_SHELL_CSS_PATH, "utf8")
      : "";
    expect(css).not.toContain(".rf-auth h2 {");
  });

  it.each([
    ["padding", /\bpadding\s*:/],
    ["border", /\bborder\s*:/],
  ])(
    "the scoped input rule sets no `%s` shorthand — it would out-specify the utilities (T2c)",
    (_name, shorthand) => {
      const css = fs.existsSync(AUTH_SHELL_CSS_PATH)
        ? fs.readFileSync(AUTH_SHELL_CSS_PATH, "utf8")
        : "";
      const block = css.match(
        /\.rf-auth input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)\s*\{[^}]*\}/,
      );
      expect(block).not.toBeNull();
      expect(block?.[0] ?? "").not.toMatch(shorthand);
    },
  );
});

// ---------------------------------------------------------------------------
// T2d — the RF monogram is gone from forgot-password/reset-password and from
// the reskinned operator change-password page.
// ---------------------------------------------------------------------------

const MONOGRAM_PAGES = [
  "app/(auth)/forgot-password/page.tsx",
  "app/(auth)/reset-password/page.tsx",
  "app/change-password/page.tsx",
];

function containsMonogram(source: string): boolean {
  if (source.includes(">RF<")) return true;
  // "RF" as a string literal inside a bg-brand-500 div — match a bg-brand-500
  // class attribute followed (within a short window) by the "RF" text node.
  const bgBrandDivs = source.match(/<div[^>]*bg-brand-500[^>]*>[\s\S]{0,200}?<\/div>/g) ?? [];
  return bgBrandDivs.some((block) => /["']RF["']|>RF</.test(block) || />\s*RF\s*</.test(block));
}

describe("RF monogram removed from forgot/reset/change password pages — T2d (R8)", () => {
  it.each(MONOGRAM_PAGES)("%s no longer contains the RF monogram (T2d)", (relPath) => {
    const source = readAuthPage(relPath);
    expect(containsMonogram(source)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2f — components/auth/auth-copy.ts exports AUTH_STORY with the two
// audiences' exact copy.
// ---------------------------------------------------------------------------

const AUTH_COPY_PATH = path.join(WEB_ROOT, "components", "auth", "auth-copy.ts");

describe("components/auth/auth-copy.ts exports AUTH_STORY — T2f (R4)", () => {
  it("components/auth/auth-copy.ts exists (T2f)", () => {
    expect(fs.existsSync(AUTH_COPY_PATH)).toBe(true);
  });

  // The existence proxy lives in its own test above, so the six regex oracles
  // below are never shadowed by it: a missing file reads as "" and each one
  // still fails on the shape it names.
  it("exports AUTH_STORY with distributor/retailer kicker+heading+paragraph (T2f)", () => {
    const source = fs.existsSync(AUTH_COPY_PATH) ? fs.readFileSync(AUTH_COPY_PATH, "utf8") : "";
    expect(source).toContain("AUTH_STORY");
    expect(source).toMatch(/distributor\s*:/);
    expect(source).toMatch(/retailer\s*:/);
    expect(source).toMatch(/kicker\s*:/);
    expect(source).toMatch(/heading\s*:/);
    expect(source).toMatch(/paragraph\s*:/);
  });

  // No existsSync short-circuit: a missing module reads as {} so each case fails on
  // its own string oracle (`expected "…" received undefined`), which is the substance
  // of R4, not on a shared file-missing proxy.
  function authCopy(): {
    AUTH_STORY?: { distributor?: { heading?: string }; retailer?: { heading?: string } };
  } {
    return fs.existsSync(AUTH_COPY_PATH) ? require(AUTH_COPY_PATH) : {};
  }

  it('AUTH_STORY.distributor.heading === "A clearer picture of your business." (T2f)', () => {
    expect(authCopy().AUTH_STORY?.distributor?.heading).toBe("A clearer picture of your business.");
  });

  it('AUTH_STORY.retailer.heading === "Stock your shelves. Stay in control." (T2f)', () => {
    expect(authCopy().AUTH_STORY?.retailer?.heading).toBe("Stock your shelves. Stay in control.");
  });
});

// ---------------------------------------------------------------------------
// T2g — audience prop matches the page's route family: app/buyer/** uses
// audience="retailer"; every other auth page (app/(auth)/** plus the operator
// app/change-password and app/verify-email) uses audience="distributor".
// ---------------------------------------------------------------------------

function audienceOf(source: string): string | null {
  const match = source.match(/<AuthShell\b[^>]*\baudience="([^"]*)"/);
  return match ? match[1] : null;
}

describe("AuthShell audience prop matches route family — T2g (R2)", () => {
  it.each(AUTH_PAGE_PATHS.filter((p) => p.startsWith("app/buyer/")))(
    '%s uses audience="retailer" (T2g)',
    (relPath) => {
      expect(audienceOf(readAuthPage(relPath))).toBe("retailer");
    },
  );

  it.each(AUTH_PAGE_PATHS.filter((p) => !p.startsWith("app/buyer/")))(
    '%s uses audience="distributor" (T2g)',
    (relPath) => {
      expect(audienceOf(readAuthPage(relPath))).toBe("distributor");
    },
  );
});

// ---------------------------------------------------------------------------
// T2h — primary submit buttons carry `className="rf-btn"`, secondary/Google
// buttons `rf-btn secondary`, and the pages whose brand-coloured pill
// anchors the shell replaced no longer carry those Tailwind background classes.
// ---------------------------------------------------------------------------

describe("primary and secondary buttons use rf-btn — T2h (R7)", () => {
  it('every page with a submit button carries className="rf-btn" (T2h)', () => {
    const missing = AUTH_PAGE_PATHS.filter((relPath) => {
      const source = readAuthPage(relPath);
      if (!source.includes('type="submit"')) return false;
      // `(?! secondary)` so a page's Google button (`rf-btn secondary`) cannot
      // stand in for the primary submit button's own `rf-btn`.
      return !/className="rf-btn(?! secondary)[\s"]/.test(source);
    });
    expect(missing).toEqual([]);
  });

  it('every page with a Google button carries "rf-btn secondary" (T2h)', () => {
    const missing = AUTH_PAGE_PATHS.filter((relPath) => {
      const source = readAuthPage(relPath);
      if (!source.includes("GoogleIcon") && !source.includes("Continue with Google")) return false;
      return !source.includes("rf-btn secondary");
    });
    expect(missing).toEqual([]);
  });

  it.each([
    ["app/buyer/invite/[token]/page.tsx", "bg-buyer-600"],
    ["app/buyer/verify-merge/page.tsx", "bg-brand-600"],
    ["app/verify-email/page.tsx", "bg-brand-600"],
  ])("%s no longer carries %s (T2h)", (relPath, banned) => {
    expect(readAuthPage(relPath)).not.toContain(banned);
  });
});

// ---------------------------------------------------------------------------
// T2j — AuthShell owns the single <h1>: no reskinned page declares its own.
// ---------------------------------------------------------------------------

describe("AuthShell owns the single h1 — T2j (R2)", () => {
  it.each(AUTH_PAGE_PATHS)("%s declares no <h1> of its own (T2j)", (relPath) => {
    expect(/<h1[\s>]/.test(readAuthPage(relPath))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2i — every page that owns a success/done state carries `rf-auth-success` on
// that container, so it picks up the mint panel. The states themselves need a
// live token or email, so they are impractical signed-out in Playwright (the
// reason R13 is fenced here rather than in e2e/46-auth-redesign.spec.ts).
// ---------------------------------------------------------------------------

const SUCCESS_STATE_PAGES = [
  "app/(auth)/forgot-password/page.tsx",
  "app/(auth)/reset-password/page.tsx",
  "app/(auth)/signup/check-email/page.tsx",
  "app/buyer/forgot-password/page.tsx",
  "app/buyer/reset-password/page.tsx",
  "app/buyer/verify-email/page.tsx",
  "app/buyer/verify-merge/page.tsx",
  "app/buyer/change-password/page.tsx",
  "app/buyer/invite/[token]/page.tsx",
  "app/verify-email/page.tsx",
];

describe("success/done blocks carry rf-auth-success — T2i (R13)", () => {
  it.each(SUCCESS_STATE_PAGES)('%s contains "rf-auth-success" (T2i)', (relPath) => {
    expect(readAuthPage(relPath)).toContain("rf-auth-success");
  });
});

// ---------------------------------------------------------------------------
// D10(a) — the five D1 pages (fix-round-2.md) pass a computed `title` to
// <AuthShell>, not a fixed string literal, and each state string the ruling
// names appears in the file exactly once (never twice — i.e. not left over
// as a demoted <h2> AND rendered as the h1). E1 (Opus) owns D1 on these
// files and is landing it in parallel with this file's D3/D4/D5/D6/D7/D8 —
// a failure here while D1 is mid-flight is expected, not a regression; see
// the E2 close-out report in fix-round-2.md.
// ---------------------------------------------------------------------------

const D1_PAGES_WITH_STATES: Array<{ path: string; states: string[] }> = [
  { path: "app/buyer/invite/[token]/page.tsx", states: ["Invalid Invite", "Invite Accepted!"] },
  {
    path: "app/verify-email/page.tsx",
    states: ["Verifying your email…", "Email verified!", "Verification failed"],
  },
  {
    path: "app/buyer/verify-merge/page.tsx",
    states: ["Verifying...", "Account Verified!", "Verification Failed"],
  },
  // Both reset-password pages' only state string the ruling pins exactly is
  // the fenced valid-state heading (D2); the invalid-token heading was never
  // distinct text in the pre-redesign page (R1 MED-1 — the old h1 was FIXED
  // across every state), so there is no old string to pin it to here.
  { path: "app/(auth)/reset-password/page.tsx", states: ["Choose a new password"] },
  { path: "app/buyer/reset-password/page.tsx", states: ["Choose a new password"] },
];

function authShellTitleAttr(source: string): string | null {
  // `[^>]*` spans the multi-line prop list up to the opening tag's own `>`;
  // captures the character right after `title=` to tell a literal ("/') from
  // an expression ({).
  const match = source.match(/<AuthShell\b[^>]*\btitle=(\{|"|')/);
  return match ? match[1] : null;
}

// D11 (fix-round-2.md) — only these three pages' h1 actually varies by state;
// the two reset-password pages never had a state-dependent heading (their old
// h1 was the fixed `Choose a new password` in every state, per D2/D10d), so
// their title stays a literal string and is excluded from the non-literal
// check below. Do not fold this back into D1_PAGES_WITH_STATES — that array
// still drives the "state string appears once" check for all five pages.
const D1_NON_LITERAL_TITLE_PAGES = [
  "app/buyer/invite/[token]/page.tsx",
  "app/verify-email/page.tsx",
  "app/buyer/verify-merge/page.tsx",
];

describe("D1 pages compute their title, not a fixed string — D10(a)", () => {
  it.each(D1_NON_LITERAL_TITLE_PAGES)(
    "%s passes AuthShell a non-literal `title` (D10a)",
    (relPath) => {
      const attr = authShellTitleAttr(readAuthPage(relPath));
      expect(attr).toBe("{");
    },
  );

  it.each(D1_PAGES_WITH_STATES.flatMap(({ path, states }) => states.map((state) => [path, state])))(
    "%s contains %j exactly once (D10a)",
    (relPath, state) => {
      const source = readAuthPage(relPath);
      const escaped = state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match only a complete quoted string literal — a raw substring search
      // would also hit an unrelated longer message that happens to start with
      // the same words (e.g. verify-email's "Verification failed. The link
      // may have expired." error text vs. the bare "Verification failed" title).
      const literalPattern = new RegExp(`["'\`]${escaped}["'\`]`, "g");
      const occurrences = source.match(literalPattern) ?? [];
      expect(occurrences.length).toBe(1);

      // The literal-count check above only counts quoted string literals, so
      // it can't see a restored JSX heading (e.g. `<h1>{state}</h1>`) that
      // duplicates the state text outside a string. Assert directly that the
      // state never appears as JSX text content (`>state<`) anywhere in the
      // page — a reintroduced heading must turn this red.
      const jsxTextPattern = new RegExp(`>${escaped}<`, "g");
      const jsxTextOccurrences = source.match(jsxTextPattern) ?? [];
      expect(jsxTextOccurrences.length).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// D10(b) — every ruleset in auth-shell.css (top-level or nested inside a
// @media block) is scoped under `.rf-auth`; @keyframes' own percentage/
// from/to selectors are exempt (D4).
// ---------------------------------------------------------------------------

describe("auth-shell.css scopes every ruleset to .rf-auth — D10(b)", () => {
  it("no selector list starts with anything other than .rf-auth (D10b)", () => {
    const css = fs.existsSync(AUTH_SHELL_CSS_PATH)
      ? fs.readFileSync(AUTH_SHELL_CSS_PATH, "utf8")
      : "";
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    // Drop @keyframes blocks wholesale — their own selectors (0%, 50%, from,
    // to) are exempt and would otherwise false-positive below.
    const noKeyframes = noComments.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    // For every `{`, the run of non-brace text immediately before it is
    // either an at-rule prelude (starts with `@` — e.g. `@media (...)`) or a
    // selector list. This walks correctly through nesting because a prior
    // `}` or `{` is simply skipped, never captured.
    const preludeRe = /([^{}]+)\{/g;
    const preludes: string[] = [];
    let preludeMatch: RegExpExecArray | null;
    while ((preludeMatch = preludeRe.exec(noKeyframes))) {
      preludes.push(preludeMatch[1].trim());
    }
    const offenders = preludes
      .filter((prelude) => prelude.length > 0 && !prelude.startsWith("@"))
      .flatMap((selectorList) => selectorList.split(",").map((s: string) => s.trim()))
      .filter((selector) => !selector.startsWith(".rf-auth"));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D10(c) — no buyer auth page's <a>/<Link> carries the low-contrast emerald
// (`buyer-600`/`buyer-700`, #059669, 3.77:1) utility any more; every real
// link uses the operator link utility instead (D5). Icons/decoration keep
// `text-buyer-600` — the check is scoped to anchor/Link tags only.
// ---------------------------------------------------------------------------

const BUYER_LOW_CONTRAST_LINK_RE = /\b(?:emerald|buyer)-[67]00\b/;

function linkTagsWithLowContrastClass(source: string): string[] {
  // Non-greedy across the tag's own attribute list (may span lines); stops at
  // the tag's closing `>` — these are simple JSX tags with no embedded `>`.
  const tagRe = /<(?:a|Link)\b[\s\S]*?>/g;
  const hits: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(source))) {
    if (BUYER_LOW_CONTRAST_LINK_RE.test(match[0])) hits.push(match[0]);
  }
  return hits;
}

describe("no low-contrast emerald utility on a buyer auth link — D10(c)", () => {
  it.each(AUTH_PAGE_PATHS.filter((p) => p.startsWith("app/buyer/")))(
    "%s has no <a>/<Link> carrying buyer-600/700 (D10c)",
    (relPath) => {
      expect(linkTagsWithLowContrastClass(readAuthPage(relPath))).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// D10(d) — the fenced headings stay literal, no trailing period: check-email
// and both reset-password pages' valid-state heading.
// ---------------------------------------------------------------------------

describe("fenced headings carry no trailing period — D10(d)", () => {
  it('app/(auth)/signup/check-email/page.tsx contains "Check your inbox" with no trailing period (D10d)', () => {
    const source = readAuthPage("app/(auth)/signup/check-email/page.tsx");
    expect(source).toContain("Check your inbox");
    expect(source).not.toContain("Check your inbox.");
  });

  it.each(["app/(auth)/reset-password/page.tsx", "app/buyer/reset-password/page.tsx"])(
    '%s contains "Choose a new password" with no trailing period (D10d)',
    (relPath) => {
      const source = readAuthPage(relPath);
      expect(source).toContain("Choose a new password");
      expect(source).not.toContain("Choose a new password.");
    },
  );
});
