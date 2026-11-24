/**
 * SA-1254 V7 / SA-1261 rule 9 (P-45): no customer text prints a raw plan key. A business reads
 * "Essentials", never "CORE"; "Pro", never "ALL_IN". Customer text names a plan through
 * `planDisplayName` (@routeflow/pricing).
 *
 * This walks apps/api/src (not specs) and flags every template literal that interpolates a
 * plan-key expression (`${input.planKey}`, `${params.requestedPlanKey}`) inside an HTTP exception
 * (`new BadRequestException(...)`, the text an API error carries to the screen) or anywhere in an
 * email template file (`*.templates.ts`). An interpolation that already goes through
 * `planDisplayName(` or `planLabel(` passes. Logger lines are not customer text and are not scanned.
 *
 * ALLOWED holds the reviewed exceptions, each with its reason. KNOWN_OPEN holds offenders that are
 * named follow-ups, not fixed in this diff. Both may only shrink: an entry that no longer matches
 * an offender fails, so a fixed line leaves the ledger in the same diff. Red on master: the three
 * invitation-only errors, the "not a recognized plan key" error and the checkout email print the
 * raw key.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

/**
 * A ledger row: how many sites print this text, and why each may stay. The count is exact, so a
 * new copy of an allowed line (the same text at another site) fails until someone reviews it
 * (R-58 F2a: one `file|literal` row used to cover every site with that text).
 */
interface LedgerRow {
  sites: number;
  reason: string;
}

/** `file|literal` (interpolations shown as `${}`, cut at 80 characters) -> its reviewed row. */
const ALLOWED: Readonly<Record<string, LedgerRow>> = {
  'billing/proration.service.ts|Unknown plan "${}"': {
    sites: 1,
    reason: "after `if (!def)`: echoes a key the caller sent that no published plan holds",
  },
  'billing/subscription-mutation.service.ts|Unknown plan "${}"': {
    sites: 3,
    reason:
      "subscribe, upgrade and downgrade, each after `if (!def)`: echoes a key the caller sent that no published plan holds. The off-ladder case (a published key outside PLAN_KEYS) reads OFF_LADDER_PLAN_MESSAGE",
  },
  'platform-admin/platform-admin.service.ts|Plan "${}" is not in the published plan catalog — publish it before assigning te':
    {
      sites: 1,
      reason: "super-admin console text (platform-admin routes); operators work in plan keys",
    },
  'platform-admin/platform-admin.service.ts|Unknown plan key "${}"': {
    sites: 1,
    reason: "super-admin console text (platform-admin routes); operators work in plan keys",
  },
  "platform-admin/platform-admin.service.ts|Plan ${} not found in the current catalog version": {
    sites: 1,
    reason: "super-admin console text (platform-admin routes); operators work in plan keys",
  },
};

/** Offenders that are named follow-ups (not fixed here). Each needs its own reworded text. */
const KNOWN_OPEN: Readonly<Record<string, LedgerRow>> = {
  "billing/platform-pricing.service.ts|No monthly price is resolvable for tenant ${} on plan ${}.":
    {
      sites: 1,
      reason:
        "W-1341: operator wording (names the tenant id too) that a custom-plan checkout can surface",
    },
  "billing/platform-pricing.service.ts|No price is resolvable for tenant ${} on plan ${}.": {
    sites: 1,
    reason:
      "W-1341: operator wording (names the tenant id too) that a custom-plan checkout can surface",
  },
};

const PLAN_KEY_EXPR = /plankey/i;
const NAMED_EXPR = /^\s*(planDisplayName|planLabel)\(/;
const EXCEPTION_CALL = /new\s+\w+Exception\s*\(/g;
const TEMPLATE_LITERAL = /`(?:[^`\\]|\\.)*`/g;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/** The text of a call from its opening parenthesis to the matching close (bounded). */
function callText(source: string, openParen: number): string {
  let depth = 0;
  const end = Math.min(source.length, openParen + 4000);
  for (let i = openParen; i < end; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen, end);
}

/** The `${...}` expressions of a template literal (one level; enough for message text). */
function interpolations(literal: string): string[] {
  const out: string[] = [];
  const re = /\$\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(literal))) out.push(m[1]);
  return out;
}

function literalId(literal: string): string {
  const body = literal
    .slice(1, -1)
    .replace(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g, "${}")
    .replace(/\s+/g, " ")
    .trim();
  return body.slice(0, 80);
}

/**
 * Every literal in `text` that prints a plan-key expression not passed through a name helper, as
 * [its offset in the file, its id]. The offset lets two scans of one literal count once.
 */
function rawPlanKeyLiterals(text: string, base: number): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const m of text.matchAll(TEMPLATE_LITERAL)) {
    const literal = m[0];
    const raw = interpolations(literal).some((e) => PLAN_KEY_EXPR.test(e) && !NAMED_EXPR.test(e));
    if (raw) out.push([base + (m.index ?? 0), literalId(literal)]);
  }
  return out;
}

/** The scanner over one file's text: one id per site (the same text at two sites gives two). */
function scanSource(rel: string, source: string): string[] {
  const sites = new Map<number, string>();
  if (rel.endsWith(".templates.ts")) {
    for (const [at, id] of rawPlanKeyLiterals(source, 0)) sites.set(at, `${rel}|${id}`);
  }
  for (const m of source.matchAll(EXCEPTION_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    for (const [at, id] of rawPlanKeyLiterals(callText(source, open), open)) {
      sites.set(at, `${rel}|${id}`);
    }
  }
  return [...sites.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
}

function countIds(ids: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

function scanTree(): string[] {
  const found: string[] = [];
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    found.push(...scanSource(rel, fs.readFileSync(file, "utf8")));
  }
  return found.sort();
}

describe("SA-1254 V7: no customer text prints a raw plan key (P-45)", () => {
  const found = countIds(scanTree());
  const ledger: Record<string, number> = {};
  for (const [id, row] of [...Object.entries(ALLOWED), ...Object.entries(KNOWN_OPEN)]) {
    ledger[id] = row.sites;
  }

  it("every exception message and email template names a plan through planDisplayName", () => {
    const unexplained = Object.entries(found)
      .filter(([id, n]) => n > (ledger[id] ?? 0))
      .map(([id, n]) => `${id} (${n} sites, ledger ${ledger[id] ?? 0})`);
    expect(unexplained).toEqual([]);
  });

  it("the ledger only shrinks: every ALLOWED and KNOWN_OPEN row matches its exact site count", () => {
    const stale = Object.entries(ledger)
      .filter(([id, n]) => (found[id] ?? 0) < n)
      .map(([id, n]) => `${id} (${found[id] ?? 0} sites, ledger ${n})`);
    expect(stale).toEqual([]);
  });

  it("KNOWN_OPEN holds no more than the two named follow-ups", () => {
    expect(Object.keys(KNOWN_OPEN).length).toBeLessThanOrEqual(2);
  });

  describe("the scanner", () => {
    it("flags a raw key in an exception, across lines", () => {
      const src = [
        "throw new BadRequestException(",
        '  `Plan "${input.planKey}" is available by invitation only — contact us.`,',
        ");",
      ].join("\n");
      expect(scanSource("a.ts", src)).toEqual([
        'a.ts|Plan "${}" is available by invitation only — contact us.',
      ]);
    });

    it("counts the same text at two sites twice (R-58 F2a)", () => {
      const src = [
        'if (!def) throw new BadRequestException(`Unknown plan "${planKey}"`);',
        'if (!toKey) throw new BadRequestException(`Unknown plan "${planKey}"`);',
      ].join("\n");
      expect(scanSource("c.ts", src)).toEqual([
        'c.ts|Unknown plan "${}"',
        'c.ts|Unknown plan "${}"',
      ]);
    });

    it("flags a raw key anywhere in an email template file", () => {
      const src = "const text = `We received your payment for ${params.requestedPlanKey}.`;";
      expect(scanSource("x.templates.ts", src)).toEqual([
        "x.templates.ts|We received your payment for ${}.",
      ]);
      expect(scanSource("x.service.ts", src)).toEqual([]);
    });

    it("passes a key named through planDisplayName or planLabel, and a logger line", () => {
      const src = [
        'throw new ForbiddenException(`The ${planDisplayName(key) ?? "requested"} plan`);',
        "throw new ForbiddenException(`Moved to ${planLabel(sub.planKey)}.`);",
        "this.logger.warn(`tenant ${tenantId} plan ${planKey}`);",
      ].join("\n");
      expect(scanSource("b.ts", src)).toEqual([]);
    });
  });
});
