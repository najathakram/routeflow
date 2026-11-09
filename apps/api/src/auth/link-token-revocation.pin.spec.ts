/**
 * F03 slice 2 (SA-1096), writer-inventory pin: every writer that makes a staff user or a buyer account non-active,
 * deletes it softly, or changes its role or email must burn the account's live one-time links
 * (`link-token-revocation.ts`) in the same method, or sit in EXEMPT with a reason. A new writer that forgets is a red
 * spec here, not a live link on a deactivated account found later.
 *
 * The pin fails closed: a write whose `data` it cannot read (`data: patch`, a ternary, a call result) is a red row
 * until it is rewritten as an object literal or named in EXEMPT, and `upsert` counts as a write. The DB spec
 * `link-revocation-writers.db.spec.ts` drives each writer on a real database; this file only keeps the list honest.
 *
 * A hard `user.delete` needs nothing: the token tables cascade on the account FK.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");

type Model = "user" | "buyerAccount";

const WATCHED_KEYS: Record<Model, string[]> = {
  user: ["status", "deletedAt", "role", "email", "isAdmin"],
  buyerAccount: ["status", "deletedAt", "email"],
};
const REVOKE: Record<Model, RegExp> = {
  user: /\brevokeUserLinkTokens\(/,
  buyerAccount: /\brevokeBuyerLinkTokens\(/,
};

export interface Writer {
  file: string;
  model: Model;
  method: string;
  keys: string[];
  revokes: boolean;
  /** the write's `data` is not an object literal this pin can read */
  unreadable: boolean;
}

/** Source with comments blanked (same length, so offsets and line numbers hold). */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** The `{ ... }` starting at `open` (an index of `{`), brace-matched. */
function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Watched columns written by an object-literal text: `key:` or a shorthand `{ key }`/`, key,`. */
function watchedIn(keys: string[], block: string): string[] {
  return keys.filter((k) => new RegExp(String.raw`(?:\b${k}\s*:|[{,]\s*${k}\s*[,}])`).test(block));
}

export function findWriters(
  file: string,
  raw: string,
  model: Model,
  keys: string[] = WATCHED_KEYS[model],
  revoke: RegExp = REVOKE[model],
): Writer[] {
  const src = stripComments(raw);
  const out: Writer[] = [];
  const re = new RegExp(String.raw`\b${model}\.(update|updateMany|upsert)\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const argOpen = src.indexOf("{", m.index);
    if (argOpen < 0) continue;
    const args = braceBlock(src, argOpen);
    // `data: { ... }` read in place; an upsert's `update: { ... }` the same; a shorthand `data,` read at its
    // `const data = { ... }` declaration just above. Anything else is unreadable.
    const entry = m[1] === "upsert" ? "update" : "data";
    const inline = new RegExp(String.raw`\b${entry}\s*:\s*\{`).exec(args);
    const shorthand = new RegExp(String.raw`[{,]\s*${entry}\s*[,}]`).test(args);
    const hasEntry = new RegExp(String.raw`\b${entry}\s*[:,}]`).test(args) || shorthand;
    let watched: string[] = [];
    let unreadable = false;
    if (inline) watched = watchedIn(keys, braceBlock(args, inline.index + inline[0].length - 1));
    else if (shorthand) {
      const from = Math.max(0, m.index - 1500);
      const decl = /const data(?:\s*:\s*[^=]+)?\s*=\s*\{/.exec(src.slice(from, m.index));
      if (decl) watched = watchedIn(keys, braceBlock(src, from + decl.index + decl[0].length - 1));
      else unreadable = true;
    } else if (hasEntry)
      unreadable = true; // `data: patch`, a ternary, a call result
    else continue; // no data entry at all: not a write this pin can classify
    if (!watched.length && !unreadable) continue;
    // the enclosing class method: nearest preceding 2-space-indented method header to the next one
    const before = src.slice(0, m.index);
    const headers = [
      ...before.matchAll(/^ {2}(?:async |private |public |static )*([A-Za-z_]\w*)\s*\(/gm),
    ];
    const last = headers[headers.length - 1];
    const start = last ? last.index! : 0;
    const after = src.slice(m.index);
    const nextHeader = /\n {2}(?:async |private |public |static )*[A-Za-z_]\w*\s*\(/.exec(after);
    const end = nextHeader ? m.index + nextHeader.index : src.length;
    out.push({
      file,
      model,
      method: last ? last[1]! : "(module)",
      keys: watched,
      revokes: revoke.test(src.slice(start, end)),
      unreadable,
    });
  }
  return out;
}

/** Back-compat name used by the detector rows below. */
export const findUserWriters = (file: string, raw: string) => findWriters(file, raw, "user");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "testing" || e.name === "node_modules") continue;
      walk(p, acc);
    } else if (p.endsWith(".ts") && !/\.(spec|test|db\.spec)\.ts$/.test(p)) acc.push(p);
  }
  return acc;
}

/** file (relative to src) -> method -> why a writer here needs no revoke */
const EXEMPT: Record<string, Record<string, string>> = {
  "auth/auth.service.ts": {
    verifyEmailAndLogin:
      "this IS the verify: it activates the signup admin the link was minted for, then signs them in",
    recordFailedLogin:
      "writes only the failed-attempt counter and lock time (a ternary the pin cannot read); no status, role or email",
  },
  "buyer/buyer-auth.service.ts": {
    recordFailedLogin:
      "writes only the failed-attempt counter and lock time (a ternary the pin cannot read); no status or email",
    updateProfile:
      "`data: dto` is the self-service profile (name, phone, mobile): UpdateBuyerProfileDto cannot carry status or email",
  },
  "customers/customers.service.ts": {
    restoreCustomer:
      "re-enables a login: its links were burned when the customer was removed or deactivated, so none is live",
  },
};

describe("writer inventory: an account change burns the account's live links (SA-1096)", () => {
  it("detector self-test: finds a status write, ignores a where-only status and a lastLoginAt write", () => {
    const sample = [
      "class S {",
      "  async a(id: string) {",
      "    await tx.user.update({ where: { id, status: 'ACTIVE' }, data: { lastLoginAt: new Date() } });",
      "  }",
      "  async b(id: string) {",
      "    await tx.user.update({ where: { id }, data: { status: 'INACTIVE' } });",
      "  }",
      "  async c(id: string) {",
      "    await tx.user.updateMany({ where: { id }, data: { role: 'OPERATOR' } });",
      "    await revokeUserLinkTokens(tx, id);",
      "  }",
      "}",
    ].join("\n");
    const found = findUserWriters("sample.ts", sample);
    expect(found.map((w) => [w.method, w.revokes])).toEqual([
      ["b", false],
      ["c", true],
    ]);
  });

  it("detector self-test: a commented-out call neither makes a writer nor satisfies one", () => {
    const sample = [
      "class S {",
      "  async d(id: string) {",
      "    // await revokeUserLinkTokens(tx, id);",
      "    await tx.user.update({ where: { id }, data: { email: 'x' } });",
      "  }",
      "}",
    ].join("\n");
    expect(findUserWriters("sample.ts", sample).map((w) => [w.method, w.revokes])).toEqual([
      ["d", false],
    ]);
  });

  it("detector self-test: a data entry it cannot read is reported, not skipped", () => {
    const sample = [
      "class S {",
      "  async e(id: string, patch: object) {",
      "    await tx.user.update({ where: { id }, data: patch });",
      "  }",
      "  async f(id: string, on: boolean) {",
      "    await tx.user.update({ where: { id }, data: on ? { status: 'A' } : { status: 'B' } });",
      "  }",
      "}",
    ].join("\n");
    expect(findUserWriters("sample.ts", sample).map((w) => [w.method, w.unreadable])).toEqual([
      ["e", true],
      ["f", true], // a ternary is not read: fail closed
    ]);
  });

  it("detector self-test: an upsert's update branch counts, a buyer revoke does not satisfy a user writer", () => {
    const sample = [
      "class S {",
      "  async g(id: string) {",
      "    await tx.user.upsert({ where: { id }, create: { id }, update: { status: 'INACTIVE' } });",
      "    await revokeBuyerLinkTokens(tx, id);",
      "  }",
      "  async h(id: string) {",
      "    await tx.buyerAccount.update({ where: { id }, data: { status: 'SUSPENDED' } });",
      "    await revokeBuyerLinkTokens(tx, id);",
      "  }",
      "}",
    ].join("\n");
    expect(findUserWriters("sample.ts", sample).map((w) => [w.method, w.revokes])).toEqual([
      ["g", false],
    ]);
    expect(
      findWriters("sample.ts", sample, "buyerAccount").map((w) => [w.method, w.revokes]),
    ).toEqual([["h", true]]);
  });

  it("detector self-test: a typed-annotation `const data: any = { status }` is read", () => {
    const sample = [
      "class S {",
      "  async i(id: string, status: string) {",
      "    const data: any = { status };",
      "    await this.prisma.buyerAccount.update({ where: { id }, data });",
      "  }",
      "}",
    ].join("\n");
    expect(
      findWriters("sample.ts", sample, "buyerAccount").map((w) => [w.method, w.keys, w.unreadable]),
    ).toEqual([["i", ["status"], false]]);
  });

  const files = walk(SRC).map((f) => ({
    rel: path.relative(SRC, f).replace(/\\/g, "/"),
    raw: fs.readFileSync(f, "utf8"),
  }));
  const all = files.flatMap((f) => [
    ...findWriters(f.rel, f.raw, "user"),
    ...findWriters(f.rel, f.raw, "buyerAccount"),
  ]);
  const id = (w: Writer) => `${w.file}:${w.method}`;

  it("not vacuous: finds the known staff and buyer writers", () => {
    const names = all.map((w) => `${w.model}:${id(w)}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "user:users/users.service.ts:changeStatus",
        "user:users/users.service.ts:updateUser",
        "user:users/users.service.ts:toggleAdmin",
        "user:customers/customers.service.ts:changeStatus",
        "buyerAccount:buyer/buyer-admin.service.ts:setBuyerStatus",
        "buyerAccount:buyer/buyer-admin.service.ts:updateBuyer",
        "buyerAccount:buyer/buyer-auth.service.ts:deleteAccount",
        "buyerAccount:buyer/buyer-merge.service.ts:executeMerge",
      ]),
    );
  });

  it("every watched writer revokes in the same method, or is exempt with a reason", () => {
    const bare = all
      .filter((w) => !w.unreadable && !w.revokes && !EXEMPT[w.file]?.[w.method])
      .map(
        (w) =>
          `${w.file}: ${w.method} writes ${w.keys.join(", ")} on ${w.model} without revoking link tokens`,
      );
    expect(bare).toEqual([]);
  });

  it("no writer hides its data from the pin (a non-literal `data` is exempt with a reason or rewritten)", () => {
    const hidden = all
      .filter((w) => w.unreadable && !w.revokes && !EXEMPT[w.file]?.[w.method])
      .map((w) => `${w.file}: ${w.method} writes ${w.model} with a data entry the pin cannot read`);
    expect(hidden).toEqual([]);
  });

  it("every EXEMPT entry names a writer that still exists", () => {
    const names = new Set(all.map(id));
    for (const [file, methods] of Object.entries(EXEMPT)) {
      for (const m of Object.keys(methods)) expect(names).toContain(`${file}:${m}`);
    }
  });

  // B461 (SA-1116): a login email is written in exactly two places by a person's edit. `updateUser` writes it for an
  // account that has never signed in; `confirmEmailChange` writes it once the NEW mailbox confirmed. Any third
  // editing writer would bypass the hold, so a new `email:` inside a `user.update*` data block is a red row here
  // until the ruling is amended. The pin names two more writers it found on master (SA-1116 counted two): a customer's
  // removal replaces the login email with a placeholder, and its restore puts the original back. Neither takes an
  // address from a person.
  it("B461: `email:` inside a user.update* data block appears in exactly two editing writers", () => {
    const customerRemoval = [
      "customers/customers.service.ts:deleteCustomer",
      "customers/customers.service.ts:restoreCustomer",
    ];
    const emailWriters = all
      .filter((w) => w.model === "user" && w.keys.includes("email"))
      .map(id)
      .sort();
    expect(emailWriters.filter((w) => !customerRemoval.includes(w))).toEqual([
      "auth/auth.service.ts:confirmEmailChange",
      "users/users.service.ts:updateUser",
    ]);
    // the two named exceptions are still there: a rename or removal of one is noticed, not silently kept
    expect(emailWriters.filter((w) => customerRemoval.includes(w))).toEqual(customerRemoval);
  });

  it("B461: revokeUserLinkTokens burns pending email changes through one helper, and the helper writes the row", () => {
    const src = stripComments(
      fs.readFileSync(path.join(SRC, "auth/link-token-revocation.ts"), "utf8"),
    );
    const body = (name: string) => {
      const start = src.indexOf(`export async function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      return braceBlock(src, src.indexOf("{", src.indexOf(")", start + 1) + 1));
    };
    expect(body("revokeUserLinkTokens")).toContain("await revokeUserEmailChanges(db, list);");
    expect(body("revokeUserEmailChanges")).toMatch(
      /UPDATE "UserEmailChange" SET "usedAt" = now\(\) WHERE "userId" = ANY\(\$\{list\}::text\[\]\) AND "usedAt" IS NULL/,
    );
  });

  // B461 (SA-1116): a password change on an EXISTING account ends the session that may have asked for an email change,
  // so a pending change must not outlive it. Derived, not listed: every `user.update*` in non-spec code whose data
  // block writes `password` must burn pending changes (`revokeUserEmailChanges`, or `revokeUserLinkTokens`, which
  // calls it) in the same method. A `user.create` is not an update and is out of scope. A `data` the pin cannot read
  // (a ternary, a variable) is skipped here; the writer inventory above reports those. Zero found is a red row (L-202).
  it("B461: every writer that changes an existing account's password burns pending email changes", () => {
    const burn = /\brevokeUserEmailChanges\(|\brevokeUserLinkTokens\(/;
    const writers = files
      .flatMap((f) => findWriters(f.rel, f.raw, "user", ["password"], burn))
      .filter((w) => !w.unreadable);
    expect(writers.length).toBeGreaterThan(0);
    const names = writers.map(id).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "auth/auth.service.ts:changePassword",
        "auth/auth.service.ts:resetPassword",
        "auth/auth.service.ts:setPassword",
        "platform-admin/platform-admin.service.ts:resetTenantAdminPassword",
        "users/users.service.ts:resetPassword",
      ]),
    );
    expect(writers.filter((w) => !w.revokes).map(id)).toEqual([]);
  });

  // SA-1126 (b): a change row for an account that is not ACTIVE is a link the confirm can never use (its CAS needs
  // ACTIVE). Every non-spec `issueEmailChange(` call sits in a method that refuses a non-ACTIVE account first, with
  // the coded 409. Census count 1 (`updateUser`); red on zero (a renamed helper) and on an unguarded site.
  const issueSites = (rel: string, raw: string) => {
    const src = stripComments(raw);
    const out: { file: string; method: string; guarded: boolean }[] = [];
    for (const m of src.matchAll(/\bissueEmailChange\(/g)) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 20), m.index!))) continue;
      const heads = [
        ...src.slice(0, m.index).matchAll(/^ {2}(?:async |private |public )*(\w+)\s*\(/gm),
      ];
      const last = heads[heads.length - 1];
      const before = src.slice(last ? last.index! : 0, m.index);
      out.push({
        file: rel,
        method: last ? last[1]! : "(module)",
        guarded:
          /status\s*!==\s*"ACTIVE"/.test(before) && /EMAIL_CHANGE_ACCOUNT_INACTIVE/.test(before),
      });
    }
    return out;
  };

  it("B461: every issueEmailChange call site is behind an ACTIVE check (census: exactly one)", () => {
    const sites = files
      .flatMap((f) => issueSites(f.rel, f.raw))
      .filter((s) => !/email-change\.ts$/.test(s.file));
    expect(sites.map((s) => `${s.file}:${s.method}`)).toEqual([
      "users/users.service.ts:updateUser",
    ]);
    expect(sites.filter((s) => !s.guarded)).toEqual([]);
  });

  it("detector self-test (issueEmailChange census): a guarded site passes, an unguarded one is reported, none is zero", () => {
    const guarded = [
      "class S {",
      "  async a(u: any) {",
      '    if (holdEmail && u.status !== "ACTIVE") throw new C({ code: API_ERROR_CODES.EMAIL_CHANGE_ACCOUNT_INACTIVE });',
      "    await issueEmailChange(tx, {});",
      "  }",
      "}",
    ].join("\n");
    const bare = [
      "class S {",
      "  async b(u: any) {",
      "    await issueEmailChange(tx, {});",
      "  }",
      "}",
    ].join("\n");
    expect(issueSites("s.ts", guarded).map((s) => s.guarded)).toEqual([true]);
    expect(issueSites("s.ts", bare).map((s) => [s.method, s.guarded])).toEqual([["b", false]]);
    expect(issueSites("s.ts", "class S {}")).toEqual([]);
  });

  it("detector self-test (password census): a password update without a burn is reported, one with it is not", () => {
    const sample = [
      "class S {",
      "  async a(id: string) {",
      "    await tx.user.update({ where: { id }, data: { password: 'x' } });",
      "  }",
      "  async b(id: string) {",
      "    await tx.user.update({ where: { id }, data: { password: 'x' } });",
      "    await revokeUserEmailChanges(tx, id);",
      "  }",
      "  async c(data: object) {",
      "    await tx.user.create({ data: { password: 'x' } });",
      "  }",
      "}",
    ].join("\n");
    expect(
      findWriters("sample.ts", sample, "user", ["password"], /\brevokeUserEmailChanges\(/).map(
        (w) => [w.method, w.revokes],
      ),
    ).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });
});
