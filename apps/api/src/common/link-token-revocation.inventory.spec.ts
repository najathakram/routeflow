/**
 * Inventory guard: every writer of a `User` / `BuyerAccount` row calls the account link-revocation
 * helper (`revoke-user-link-tokens.ts`), or is on the written allow-list below.
 *
 * WHY: a client's outstanding set-password / reset / verification links must stop working when its
 * standing changes (a non-ACTIVE status, a deletion tombstone, a role change, an email change). A
 * writer that forgets the helper leaves a live link on a deactivated account. A new writer is the
 * moment that regression is introduced, so it fails here until it either calls the helper or is
 * listed with a reason.
 *
 * SCOPE: every `user.` / `buyerAccount.` `update | updateMany | upsert` in a non-spec file under
 * `apps/api/src` (through `prisma.`, `tx.`, `forTenant().`, a delegate adapter or an alias —
 * the match is on the delegate name, so a reference that is not called counts too). `create` is
 * out of scope (a new account has no links yet) and so is `delete` / `deleteMany`: the token
 * tables cascade on account deletion, which removes the links with the row.
 *
 * COVERAGE UNIT: the enclosing method / function. A site is covered when that unit also calls
 * `revokeUserLinkTokens(` or `revokeBuyerLinkTokens(` (the per-writer unit specs prove each call
 * runs in the same transaction as the write and only for a non-ACTIVE status / role / email change).
 * An allow-list entry names the unit, the exact number of sites it may contain (so a second writer
 * added to an allow-listed method still fails) and why none of its writes changes the standing.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

// ─── The allow-list ────────────────────────────────────────────────────────────────────────────

interface Allowed {
  /** Path under apps/api/src. */
  file: string;
  /** Enclosing method / function name. */
  fn: string;
  /** Exact number of guarded call sites the unit may contain. */
  sites: number;
  /** Why none of these writes changes status, role, email or deletedAt. */
  reason: string;
}

const ALLOWED: Allowed[] = [
  // ── staff sign-in / credential flows ──
  {
    file: "auth/auth.service.ts",
    fn: "validateUser",
    sites: 1,
    reason: "resets failedLoginAttempts / lockedUntil after a successful credential check",
  },
  {
    file: "auth/auth.service.ts",
    fn: "touchLastLogin",
    sites: 1,
    reason: "stamps lastLoginAt only; no standing column is written",
  },
  {
    file: "auth/auth.service.ts",
    fn: "recordFailedLogin",
    sites: 1,
    reason: "writes the failed-attempt counter and the temporary lock only",
  },
  {
    file: "auth/auth.service.ts",
    fn: "verifyEmailAndLogin",
    sites: 1,
    reason:
      "activation claim: writes status ACTIVE only (INACTIVE -> ACTIVE); a reactivation restores nothing and burns nothing",
  },
  {
    file: "auth/auth.service.ts",
    fn: "resetPassword",
    sites: 1,
    reason:
      "the password change itself, in the transaction that marks the consumed link used; status, role, email and deletedAt are untouched",
  },
  {
    file: "auth/auth.service.ts",
    fn: "changePassword",
    sites: 1,
    reason:
      "the signed-in user's own password change (it burns the user's other links itself); status, role, email and deletedAt are untouched",
  },
  {
    file: "auth/auth.service.ts",
    fn: "setPassword",
    sites: 1,
    reason:
      "first password for a signed-in account (it burns the user's other links itself); status, role, email and deletedAt are untouched",
  },
  // ── staff / buyer provider linking ──
  {
    file: "auth/google-oauth.service.ts",
    fn: "linkGoogleAccount",
    sites: 1,
    reason:
      "compare-and-set link of googleId for the signed-in user; no status, role, email or deletedAt write",
  },
  {
    file: "auth/google-oauth.service.ts",
    fn: "handlePlatformAuth",
    sites: 1,
    reason:
      "compare-and-set link of googleId on an ACTIVE platform user; no status, role, email or deletedAt write",
  },
  {
    file: "auth/google-oauth.service.ts",
    fn: "handleTenantAuth",
    sites: 1,
    reason:
      "compare-and-set link of googleId on an ACTIVE staff user; no status, role, email or deletedAt write",
  },
  {
    file: "auth/google-oauth.service.ts",
    fn: "handleBuyerPortalAuth",
    sites: 4,
    reason:
      "links googleId and/or sets emailVerified and neutralises a never-verified password when Google attests the mailbox; no status, email or deletedAt write",
  },
  {
    file: "auth/google-oauth.service.ts",
    fn: "issueUserTokenPair",
    sites: 1,
    reason: "stamps lastLoginAt only; no standing column is written",
  },
  {
    file: "auth/apple-oauth.service.ts",
    fn: "handleStaffAuth",
    sites: 1,
    reason:
      "compare-and-set link of appleId (+ forcePasswordChange false) on an ACTIVE staff user; no status, role, email or deletedAt write",
  },
  {
    file: "auth/apple-oauth.service.ts",
    fn: "handleBuyerAuth",
    sites: 3,
    reason:
      "links appleId and/or sets emailVerified and neutralises a never-verified password when Apple attests the mailbox; no status, email or deletedAt write",
  },
  {
    file: "auth/apple-oauth.service.ts",
    fn: "linkAppleAccount",
    sites: 1,
    reason:
      "compare-and-set link of appleId for the signed-in user; no status, role, email or deletedAt write",
  },
  {
    file: "auth/apple-oauth.service.ts",
    fn: "exchangeAndStoreRefreshToken",
    sites: 1,
    reason: "stores the encrypted Apple refresh token only",
  },
  {
    file: "auth/apple-oauth.service.ts",
    fn: "applyNotificationEvent",
    sites: 2,
    reason:
      "clears appleId (and the stored Apple refresh token) on a provider revocation notice; the account keeps its status, role and email",
  },
  {
    file: "auth/apple-oauth.service.ts",
    fn: "issueUserTokenPair",
    sites: 1,
    reason: "stamps lastLoginAt only; no standing column is written",
  },
  {
    file: "tenants/tenant-google-oauth.service.ts",
    fn: "exchangeCode",
    sites: 1,
    reason:
      "links googleId to an existing ACTIVE-checked staff user; no status, role, email or deletedAt write",
  },
  // ── buyer sign-in / credential flows ──
  {
    file: "buyer/buyer-auth.service.ts",
    fn: "verifyEmail",
    sites: 1,
    reason:
      "the verification consume itself: sets emailVerified true in the transaction that marks the link used",
  },
  {
    file: "buyer/buyer-auth.service.ts",
    fn: "login",
    sites: 1,
    reason: "resets the failed-attempt counter and lock after a successful credential check",
  },
  {
    file: "buyer/buyer-auth.service.ts",
    fn: "changePassword",
    sites: 1,
    reason: "the buyer's own password change; status, email and deletedAt are untouched",
  },
  {
    file: "buyer/buyer-auth.service.ts",
    fn: "setPassword",
    sites: 1,
    reason:
      "first password for a Google/Apple-created buyer; status, email and deletedAt are untouched",
  },
  {
    file: "buyer/buyer-auth.service.ts",
    fn: "resetPassword",
    sites: 1,
    reason:
      "the reset consume itself: the password change in the transaction that marks the consumed link used",
  },
  {
    file: "buyer/buyer-auth.service.ts",
    fn: "updateProfile",
    sites: 1,
    reason:
      "profile fields only (name, phone, mobile): the DTO is a whitelist that excludes email, status and every credential column",
  },
  {
    file: "buyer/buyer-auth.service.ts",
    fn: "recordFailedLogin",
    sites: 1,
    reason: "writes the failed-attempt counter and the temporary lock only",
  },
  // ── platform / tenant tooling ──
  {
    file: "platform-admin/platform-admin.service.ts",
    fn: "resetTenantAdminPassword",
    sites: 1,
    reason:
      "admin-triggered password reset of an ACTIVE tenant admin (password + forcePasswordChange only)",
  },
  {
    file: "import/import.service.ts",
    fn: "adoptOrphanedContacts",
    sites: 1,
    reason:
      "assigns tenantId to orphaned imported users; status, role, email and deletedAt are untouched",
  },
  {
    file: "drivers/drivers.service.ts",
    fn: "remove",
    sites: 1,
    reason:
      "clears the canActAsDriver capability flag of a dual-role account; status, role, email and deletedAt are untouched",
  },
  {
    file: "users/users.service.ts",
    fn: "unlockUser",
    sites: 1,
    reason: "clears failedLoginAttempts / lockedUntil only; no standing column is written",
  },
  {
    file: "users/users.service.ts",
    fn: "resetPassword",
    sites: 1,
    reason:
      "admin-triggered temporary password + forcePasswordChange; it issues a fresh link itself and never changes status, role, email or deletedAt",
  },
  {
    file: "users/users.service.ts",
    fn: "toggleAdmin",
    sites: 1,
    reason: "flips the isAdmin permission flag only (the role column is untouched)",
  },
  {
    file: "users/users.service.ts",
    fn: "toggleDriverPermit",
    sites: 1,
    reason: "flips the canActAsDriver capability flag only (the role column is untouched)",
  },
];

// ─── The scanner ───────────────────────────────────────────────────────────────────────────────

const SITE = /\b(user|buyerAccount)\s*\??\.\s*(updateMany|update|upsert)\b/g;
const HELPER_CALL = /\brevoke(?:User|Buyer)LinkTokens\s*\(/;

/** Blanks comments, string literals and template literals (keeping offsets and newlines). */
export function blank(src: string): string {
  const out = src.split("");
  let i = 0;
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      wipe(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      wipe(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      wipe(i, k + 1);
      i = k + 1;
    } else if (c === "`") {
      // template literal: blank the text, keep `${ ... }` expressions scannable only coarsely
      let k = i + 1;
      let depth = 0;
      while (k < src.length) {
        if (src[k] === "\\") {
          k += 2;
          continue;
        }
        if (depth === 0 && src[k] === "`") break;
        if (src[k] === "$" && src[k + 1] === "{") depth++;
        else if (depth > 0 && src[k] === "}") depth--;
        k++;
      }
      wipe(i, k + 1);
      i = k + 1;
    } else i++;
  }
  return out.join("");
}

interface Range {
  open: number;
  close: number;
}

function braceRanges(text: string): Range[] {
  const stack: number[] = [];
  const ranges: Range[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") stack.push(i);
    else if (text[i] === "}") {
      const open = stack.pop();
      if (open !== undefined) ranges.push({ open, close: i });
    }
  }
  return ranges;
}

const CLASS_HEADER =
  /\bclass\s+[A-Za-z_$][\w$]*(?:\s*<[^>{]*>)?(?:\s+extends\s+[^{]+?)?(?:\s+implements\s+[^{]+?)?\s*$/;

function unitName(text: string, open: number): string {
  const lines = text.slice(0, open).split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 60; i--) {
    const m =
      /^ {0,2}(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|async|readonly|abstract|override)\s+)*(?:function\s*\*?\s+)?(?:(?:get|set)\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*[(=]/.exec(
        lines[i],
      );
    if (m && !["if", "for", "while", "switch", "catch", "return"].includes(m[1])) return m[1];
  }
  return "<anonymous>";
}

export interface Site {
  file: string;
  line: number;
  model: string;
  op: string;
  fn: string;
  unitCallsHelper: boolean;
}

export function scanSource(file: string, source: string): Site[] {
  const text = blank(source);
  const ranges = braceRanges(text);
  const sites: Site[] = [];
  const re = new RegExp(SITE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const pos = m.index;
    const enclosing = ranges
      .filter((r) => r.open < pos && pos < r.close)
      .sort((a, b) => a.open - b.open);
    const classIdx = enclosing.findIndex((r) =>
      CLASS_HEADER.test(text.slice(Math.max(0, r.open - 300), r.open)),
    );
    const unit = classIdx >= 0 ? enclosing[classIdx + 1] : enclosing[0];
    const unitText = unit ? text.slice(unit.open, unit.close + 1) : "";
    sites.push({
      file,
      line: text.slice(0, pos).split("\n").length,
      model: m[1],
      op: m[2],
      fn: unit ? unitName(text, unit.open) : "<module scope>",
      unitCallsHelper: HELPER_CALL.test(unitText),
    });
  }
  return sites;
}

/** Everything wrong with `sites` against `allowed` (empty = the inventory holds). */
export function violations(sites: Site[], allowed: Allowed[]): string[] {
  const out: string[] = [];
  const groups = new Map<string, Site[]>();
  for (const s of sites) {
    const key = `${s.file}#${s.fn}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const allowedByKey = new Map(allowed.map((a) => [`${a.file}#${a.fn}`, a]));

  for (const [key, group] of groups) {
    const where = group.map((s) => `${s.model}.${s.op}@${s.line}`).join(", ");
    const entry = allowedByKey.get(key);
    const calls = group.every((s) => s.unitCallsHelper);
    if (calls) {
      if (entry) out.push(`${key}: calls the helper but is still allow-listed — drop the entry`);
      continue;
    }
    if (!entry) {
      out.push(
        `${key}: writes ${where} without calling revokeUserLinkTokens / revokeBuyerLinkTokens ` +
          `and is not allow-listed (call the helper in the same transaction, or list it with a reason)`,
      );
    } else if (entry.sites !== group.length) {
      out.push(
        `${key}: allow-list expects ${entry.sites} site(s) but found ${group.length} (${where})`,
      );
    }
  }
  for (const a of allowed) {
    if (!groups.has(`${a.file}#${a.fn}`)) {
      out.push(`${a.file}#${a.fn}: stale allow-list entry (no such writer any more)`);
    }
    if (a.reason.trim().length < 25) out.push(`${a.file}#${a.fn}: allow-list reason is too thin`);
  }
  return out;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const REAL_SITES: Site[] = collectSourceFiles(SRC_ROOT).flatMap((full) =>
  scanSource(path.relative(SRC_ROOT, full).replace(/\\/g, "/"), fs.readFileSync(full, "utf8")),
);

// ─── The guard ─────────────────────────────────────────────────────────────────────────────────

describe("account link revocation — writer inventory", () => {
  it("scans a non-trivial tree and finds the known writers (an empty scan must not report green)", () => {
    expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
    expect(REAL_SITES.length).toBeGreaterThan(30);
    const files = new Set(REAL_SITES.map((s) => s.file));
    for (const f of [
      "users/users.service.ts",
      "billing/billing-cron.service.ts",
      "customers/customers.service.ts",
      "buyer/buyer-admin.service.ts",
      "buyer/buyer-merge.service.ts",
      "buyer/buyer-auth.service.ts",
    ]) {
      expect(files).toContain(f);
    }
    // every site resolved to a named unit (a failed parse would hide it in "<anonymous>")
    expect(REAL_SITES.filter((s) => s.fn.startsWith("<"))).toEqual([]);
  });

  it("every User / BuyerAccount update | updateMany | upsert calls the helper or is allow-listed", () => {
    expect(violations(REAL_SITES, ALLOWED)).toEqual([]);
  });

  it("the writers that change standing are covered by the helper, never by an allow-list entry", () => {
    const MUST_CALL = [
      "users/users.service.ts#changeStatus",
      "users/users.service.ts#updateUser",
      "billing/billing-cron.service.ts#applyScheduledDowngrades",
      "customers/customer-login-status.ts#setCustomerLoginStatus",
      "customers/customers.service.ts#restoreCustomer",
      "customers/customers.service.ts#deleteCustomer",
      "buyer/buyer-admin.service.ts#setBuyerStatus",
      "buyer/buyer-admin.service.ts#updateBuyer",
      "buyer/buyer-merge.service.ts#executeMerge",
      "buyer/buyer-auth.service.ts#deleteAccount",
    ];
    const byKey = new Map<string, Site[]>();
    for (const s of REAL_SITES) {
      byKey.set(`${s.file}#${s.fn}`, [...(byKey.get(`${s.file}#${s.fn}`) ?? []), s]);
    }
    const allowListed = new Set(ALLOWED.map((a) => `${a.file}#${a.fn}`));
    for (const key of MUST_CALL) {
      expect(byKey.has(key)).toBe(true);
      expect(allowListed.has(key)).toBe(false);
      expect(byKey.get(key)!.every((s) => s.unitCallsHelper)).toBe(true);
    }
  });

  it("allow-list entries are unique and each carries a written reason", () => {
    const keys = ALLOWED.map((a) => `${a.file}#${a.fn}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of ALLOWED) expect(a.reason.trim().length).toBeGreaterThanOrEqual(25);
  });
});

// ─── Plant-and-fail: the guard must bite ───────────────────────────────────────────────────────

describe("the inventory guard bites (planted sources)", () => {
  const planted = (body: string) =>
    scanSource(
      "planted/planted.service.ts",
      `export class PlantedService {\n  constructor(private readonly prisma: any) {}\n${body}\n}\n`,
    );

  it("fails on a new, unlisted status writer", () => {
    const sites = planted(`
  async suspend(id: string) {
    await this.prisma.user.update({ where: { id }, data: { status: "SUSPENDED" } });
  }`);
    const found = violations(sites, []);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/planted\.service\.ts#suspend: writes user\.update/);
  });

  it("fails on every write shape: tx., forTenant(), upsert, updateMany and buyerAccount", () => {
    const sites = planted(`
  async a(tx: any) { await tx.user.updateMany({ where: {}, data: {} }); }
  async b() { await this.prisma.forTenant().user.upsert({} as any); }
  async c() { await this.prisma.buyerAccount.update({} as any); }
  async d() { const w = this.prisma.user.update; return w; }`);
    expect(violations(sites, [])).toHaveLength(4);
  });

  it("passes when the same unit calls the helper (and a comment mentioning it does not count)", () => {
    const covered = planted(`
  async suspend(id: string) {
    await this.prisma.tenantTransaction(async (tx: any) => {
      await tx.user.update({ where: { id }, data: { status: "SUSPENDED" } });
      await revokeUserLinkTokens(tx, id);
    });
  }`);
    expect(violations(covered, [])).toEqual([]);

    const onlyAComment = planted(`
  async suspend(id: string) {
    // TODO call revokeUserLinkTokens(tx, id) here
    const s = "revokeBuyerLinkTokens(";
    await this.prisma.user.update({ where: { id }, data: { status: "SUSPENDED" } });
  }`);
    expect(violations(onlyAComment, [])).toHaveLength(1);
  });

  it("passes an allow-listed unit, but fails a SECOND writer added to it", () => {
    const allow: Allowed[] = [
      {
        file: "planted/planted.service.ts",
        fn: "touch",
        sites: 1,
        reason: "writes lastLoginAt only, nothing about standing",
      },
    ];
    const one = planted(`
  async touch(id: string) {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }`);
    expect(violations(one, allow)).toEqual([]);

    const two = planted(`
  async touch(id: string) {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
    await this.prisma.user.update({ where: { id }, data: { status: "INACTIVE" } });
  }`);
    expect(violations(two, allow)[0]).toMatch(/allow-list expects 1 site\(s\) but found 2/);
  });

  it("flags a stale allow-list entry, a thin reason, and an entry made redundant by a helper call", () => {
    const sites = planted(`
  async ok(tx: any, id: string) {
    await tx.user.update({ where: { id }, data: {} });
    await revokeUserLinkTokens(tx, id);
  }`);
    const stale: Allowed = {
      file: "planted/planted.service.ts",
      fn: "gone",
      sites: 1,
      reason: "x".repeat(30),
    };
    const thin: Allowed = {
      file: "planted/planted.service.ts",
      fn: "ok",
      sites: 1,
      reason: "fine",
    };
    const found = violations(sites, [stale, thin]);
    expect(found.some((v) => /gone: stale allow-list entry/.test(v))).toBe(true);
    expect(found.some((v) => /ok: calls the helper but is still allow-listed/.test(v))).toBe(true);
    expect(found.some((v) => /ok: allow-list reason is too thin/.test(v))).toBe(true);
  });

  it("names the unit correctly for class methods, arrow properties and top-level functions", () => {
    const sites = scanSource(
      "planted/mixed.ts",
      [
        "export async function topLevel(tx: any) {",
        "  await tx.user.update({});",
        "}",
        "export class C {",
        "  readonly arrow = async (tx: any) => {",
        "    await tx.buyerAccount.update({});",
        "  };",
        "  private async wrapped(",
        "    a: string,",
        "    b: string,",
        "  ): Promise<{ x: number }> {",
        "    return this.prisma.user.updateMany({});",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(sites.map((s) => s.fn)).toEqual(["topLevel", "arrow", "wrapped"]);
  });
});
