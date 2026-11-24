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

/** `file|literal` (interpolations shown as `${}`, cut at 80 characters) -> why it may stay. */
const ALLOWED: Readonly<Record<string, string>> = {
  'billing/proration.service.ts|Unknown plan "${}"':
    "echoes a key the caller sent that no published plan holds; there is no name to show",
  'billing/subscription-mutation.service.ts|Unknown plan "${}"':
    "echoes a key the caller sent that no published plan holds; there is no name to show",
  'platform-admin/platform-admin.service.ts|Plan "${}" is not in the published plan catalog — publish it before assigning te':
    "super-admin console text (platform-admin routes); operators work in plan keys",
  'platform-admin/platform-admin.service.ts|Unknown plan key "${}"':
    "super-admin console text (platform-admin routes); operators work in plan keys",
  "platform-admin/platform-admin.service.ts|Plan ${} not found in the current catalog version":
    "super-admin console text (platform-admin routes); operators work in plan keys",
};

/** Offenders that are named follow-ups (not fixed here). Each needs its own reworded text. */
const KNOWN_OPEN: Readonly<Record<string, string>> = {
  "billing/platform-pricing.service.ts|No monthly price is resolvable for tenant ${} on plan ${}.":
    "operator wording (names the tenant id too) that a custom-plan checkout can surface; reword with the P-45 screens",
  "billing/platform-pricing.service.ts|No price is resolvable for tenant ${} on plan ${}.":
    "operator wording (names the tenant id too) that a custom-plan checkout can surface; reword with the P-45 screens",
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

/** Every literal in `text` that prints a plan-key expression not passed through a name helper. */
function rawPlanKeyLiterals(text: string): string[] {
  const out: string[] = [];
  for (const literal of text.match(TEMPLATE_LITERAL) ?? []) {
    const raw = interpolations(literal).some((e) => PLAN_KEY_EXPR.test(e) && !NAMED_EXPR.test(e));
    if (raw) out.push(literalId(literal));
  }
  return out;
}

/** The scanner over one file's text; exported shape kept local so the fixtures below prove it. */
function scanSource(rel: string, source: string): string[] {
  const found = new Set<string>();
  if (rel.endsWith(".templates.ts")) {
    for (const id of rawPlanKeyLiterals(source)) found.add(`${rel}|${id}`);
  }
  for (const m of source.matchAll(EXCEPTION_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    for (const id of rawPlanKeyLiterals(callText(source, open))) found.add(`${rel}|${id}`);
  }
  return [...found];
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
  const offenders = scanTree();

  it("every exception message and email template names a plan through planDisplayName", () => {
    const unexplained = offenders.filter((id) => !(id in ALLOWED) && !(id in KNOWN_OPEN));
    expect(unexplained).toEqual([]);
  });

  it("the ledger only shrinks: every ALLOWED and KNOWN_OPEN entry still matches a line", () => {
    const stale = [...Object.keys(ALLOWED), ...Object.keys(KNOWN_OPEN)].filter(
      (id) => !offenders.includes(id),
    );
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
