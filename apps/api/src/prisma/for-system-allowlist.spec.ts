/**
 * SA-619 PR-1 - static guard: every `forSystem(` call site is on a reviewed allow-list, with its
 * reason. `forSystem(reason)` is the ONE explicit unscoped Prisma door; a new one is a red verify
 * that needs review (the same pattern as no-bare-cron and the addon-gate registry).
 *
 * Rules, per call site in apps/api/src (spec files and the definitions excluded; comments stripped):
 *   1. the argument is a plain string LITERAL (never a variable or template), so the reason is
 *      greppable and reviewable;
 *   2. (file, reason) is in ALLOWED_SITES, with the expected count;
 *   3. nothing else calls it.
 * `forSystem` queries on tenant-owned models must carry an explicit tenantId in `where` except the
 * allow-listed platform reads: that part is reviewed per entry (`why`), not scanned.
 */
import * as fs from "fs";
import * as path from "path";
import { stripComments } from "../common/testing/unscoped-write-scan";

const SRC_ROOT = path.resolve(__dirname, "..");
const DEFINITIONS = new Set(["prisma/prisma.service.ts", "tenant/tenant-context-guard.ts"]);

/** file -> reason literal -> { count, why }. Empty until the audited callers are converted. */
const ALLOWED_SITES: Record<string, Record<string, { count: number; why: string }>> = {};

export type ForSystemSite = { reason: string | null };

/** Every `.<door>(` call in `src` (comments ignored): its literal reason, or null when not a plain literal. */
export function scanDoor(src: string, door: string): ForSystemSite[] {
  const code = stripComments(src);
  const out: ForSystemSite[] = [];
  for (const m of code.matchAll(new RegExp(`\\.\\s*${door}\\s*\\(\\s*`, "g"))) {
    const rest = code.slice(m.index! + m[0].length);
    const lit = /^(["'])((?:(?!\1)[^\\\n]|\\.)*)\1\s*[,)]/.exec(rest);
    out.push({ reason: lit ? lit[2] : null });
  }
  // Every other way to reach it (bracket call, destructuring, a bound/aliased reference) hides the
  // reason from review: flagged as a non-literal use. A plain `.forSystem(` call was counted above.
  const plain = (code.match(new RegExp(`\\.\\s*${door}\\s*\\(`, "g")) ?? []).length;
  const anyUse = (code.match(new RegExp(door, "g")) ?? []).length;
  for (let i = 0; i < anyUse - plain; i++) out.push({ reason: null });
  return out;
}

export const scanForSystem = (src: string) => scanDoor(src, "forSystem");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("forSystem allow-list (SA-619)", () => {
  const files = walk(SRC_ROOT);
  const found: Record<string, Record<string, number>> = {};
  const nonLiteral: string[] = [];
  for (const f of files) {
    const rel = path.relative(SRC_ROOT, f).split(path.sep).join("/");
    if (DEFINITIONS.has(rel)) continue;
    for (const site of scanForSystem(fs.readFileSync(f, "utf8"))) {
      if (site.reason === null) nonLiteral.push(rel);
      else {
        found[rel] ??= {};
        found[rel][site.reason] = (found[rel][site.reason] ?? 0) + 1;
      }
    }
  }

  it("the scan walks the API source (a wrong root would pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("every forSystem reason is a string literal", () => {
    expect(nonLiteral).toEqual([]);
  });

  it("every forSystem call site is allow-listed with its reason and count, and nothing else", () => {
    const expected = Object.fromEntries(
      Object.entries(ALLOWED_SITES).map(([f, rs]) => [
        f,
        Object.fromEntries(Object.entries(rs).map(([r, v]) => [r, v.count])),
      ]),
    );
    expect(found).toEqual(expected);
  });

  it("the allow-list is EMPTY by ruling in PR-1 (the per-entry checks below are then vacuous on purpose)", () => {
    expect(Object.keys(ALLOWED_SITES)).toEqual([]);
  });

  it("every allow-list entry states why it is cross-tenant", () => {
    for (const [file, rs] of Object.entries(ALLOWED_SITES))
      for (const [reason, v] of Object.entries(rs)) {
        expect(reason.length).toBeGreaterThan(10);
        expect(v.why.length).toBeGreaterThan(10);
        expect(fs.existsSync(path.join(SRC_ROOT, file))).toBe(true);
      }
  });
});

describe("scanForSystem mutants (SA-619)", () => {
  it.each([
    [
      "a plain call",
      'this.prisma.forSystem("billing-cron: cross-tenant trial expiry").tenant.findMany()',
      "billing-cron: cross-tenant trial expiry",
    ],
    [
      "a call split across lines",
      'this.prisma\n  .forSystem(\n    "webhook: resolve tenant from the external id",\n  )',
      "webhook: resolve tenant from the external id",
    ],
    ["single quotes", "this.prisma.forSystem('public lookup by token')", "public lookup by token"],
  ])("sees %s", (_n, src, reason) => {
    expect(scanForSystem(src)).toEqual([{ reason }]);
  });

  it.each([
    ["a variable", "this.prisma.forSystem(reason)"],
    ["a template literal", "this.prisma.forSystem(`x ${y}`)"],
    ["a concatenation", 'this.prisma.forSystem("a" + b)'],
  ])("flags a non-literal reason: %s", (_n, src) => {
    expect(scanForSystem(src)).toEqual([{ reason: null }]);
  });

  it.each([
    ["the bracket form", 'this.prisma["forSystem"]("x reason here")'],
    ["destructuring (which also loses `this`)", "const { forSystem } = this.prisma;"],
    ["a bound alias", "const f = this.prisma.forSystem.bind(this.prisma);"],
  ])("flags %s as a non-literal use", (_n, src) => {
    expect(scanForSystem(src).length).toBeGreaterThan(0);
    expect(scanForSystem(src).every((s) => s.reason === null)).toBe(true);
  });

  it("ignores commented-out calls", () => {
    expect(scanForSystem('// this.prisma.forSystem("x")\n/* .forSystem("y") */')).toEqual([]);
  });
});

/**
 * PR-2b/auth: `systemTransaction(reason, fn)` is the transaction twin of forSystem: the same rules
 * (literal reason, allow-listed with a count), its own list. The first callers are the anonymous token flows that used the array-form
 * `$transaction`, which bypasses the tenant guard.
 */
const ALLOWED_TX_SITES: Record<string, Record<string, { count: number; why: string }>> = {
  "auth/auth.service.ts": {
    "auth.resetPassword": {
      count: 1,
      why: "anonymous caller: the emailed reset token is the credential; the user row is found by it",
    },
  },
  "buyer/buyer-auth.service.ts": {
    "buyer-auth.verifyEmail": {
      count: 1,
      why: "anonymous buyer: the emailed verification token is the credential; BuyerAccount is a platform model",
    },
    "buyer-auth.resetPassword": {
      count: 1,
      why: "anonymous buyer: the emailed reset token is the credential; BuyerAccount is a platform model",
    },
  },
};

describe("systemTransaction allow-list (SA-619 PR-2b)", () => {
  const files = walk(SRC_ROOT);
  const found: Record<string, Record<string, number>> = {};
  const nonLiteral: string[] = [];
  for (const f of files) {
    const rel = path.relative(SRC_ROOT, f).split(path.sep).join("/");
    if (DEFINITIONS.has(rel) || rel === "testing/prisma-mock.ts") continue; // the definitions and the test double
    for (const site of scanDoor(fs.readFileSync(f, "utf8"), "systemTransaction")) {
      if (site.reason === null) nonLiteral.push(rel);
      else {
        found[rel] ??= {};
        found[rel][site.reason] = (found[rel][site.reason] ?? 0) + 1;
      }
    }
  }

  it("every systemTransaction reason is a string literal", () => {
    expect(nonLiteral).toEqual([]);
  });

  it("every call site is allow-listed with its reason and count, and nothing else", () => {
    const expected = Object.fromEntries(
      Object.entries(ALLOWED_TX_SITES).map(([f, rs]) => [
        f,
        Object.fromEntries(Object.entries(rs).map(([r, v]) => [r, v.count])),
      ]),
    );
    expect(found).toEqual(expected);
  });

  it("every entry states why, and its file exists", () => {
    for (const [file, rs] of Object.entries(ALLOWED_TX_SITES))
      for (const [reason, v] of Object.entries(rs)) {
        expect(reason.length).toBeGreaterThan(10);
        expect(v.why.length).toBeGreaterThan(10);
        expect(fs.existsSync(path.join(SRC_ROOT, file))).toBe(true);
      }
  });

  it.each([
    [
      "a plain call",
      'this.prisma.systemTransaction("cron: expire trials", async (tx) => 1)',
      "cron: expire trials",
    ],
    [
      "split across lines",
      'this.prisma\n  .systemTransaction(\n    "webhook: apply payment",\n    fn)',
      "webhook: apply payment",
    ],
  ])("sees %s", (_n, src, reason) => {
    expect(scanDoor(src, "systemTransaction")).toEqual([{ reason }]);
  });

  it.each([
    ["a variable", "this.prisma.systemTransaction(reason, fn)"],
    ["a template", "this.prisma.systemTransaction(`x ${y}`, fn)"],
    ["a bound alias", "const f = this.prisma.systemTransaction.bind(this.prisma);"],
  ])("flags a non-literal use: %s", (_n, src) => {
    expect(scanDoor(src, "systemTransaction").every((x) => x.reason === null)).toBe(true);
    expect(scanDoor(src, "systemTransaction").length).toBeGreaterThan(0);
  });
});
