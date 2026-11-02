/**
 * F03 slice 2 (SA-1096), writer-inventory pin: every writer that makes a staff user non-active, deletes it softly,
 * or changes its role or email must burn the account's live one-time links (`link-token-revocation.ts`) in the same
 * method, or sit in EXEMPT with a reason. A new writer that forgets is a red spec here, not a live link on a
 * deactivated account found later.
 *
 * A hard `user.delete` needs nothing: PasswordResetToken and UserEmailVerificationToken cascade on the user FK.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");
const WATCHED_KEYS = ["status", "deletedAt", "role", "email", "isAdmin"];
const REVOKE = /\b(revokeUserLinkTokens|revokeLinkTokensWhere)\(/;

export interface Writer {
  file: string;
  method: string;
  keys: string[];
  revokes: boolean;
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
function watchedIn(block: string): string[] {
  return WATCHED_KEYS.filter((k) =>
    new RegExp(String.raw`(?:\b${k}\s*:|[{,]\s*${k}\s*[,}])`).test(block),
  );
}

export function findUserWriters(file: string, raw: string): Writer[] {
  const src = stripComments(raw);
  const out: Writer[] = [];
  const re = /\buser\.(update|updateMany)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // The call's own argument object, then its `data` entry: `data: { ... }` read in place, a shorthand
    // `data,` read at its `const data = { ... }` declaration just above.
    const argOpen = src.indexOf("{", m.index);
    if (argOpen < 0) continue;
    const args = braceBlock(src, argOpen);
    const inline = /\bdata\s*:\s*\{/.exec(args);
    const shorthand = /[{,]\s*data\s*[,}]/.test(args);
    if (!inline && !shorthand) continue;
    let watched: string[];
    if (inline) watched = watchedIn(braceBlock(args, inline.index + inline[0].length - 1));
    else {
      const from = Math.max(0, m.index - 1500);
      const decl = /const data\s*=\s*\{/.exec(src.slice(from, m.index));
      watched = decl ? watchedIn(braceBlock(src, from + decl.index + decl[0].length - 1)) : [];
    }
    if (!watched.length) continue;
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
      method: last ? last[1]! : "(module)",
      keys: watched,
      revokes: REVOKE.test(src.slice(start, end)),
    });
  }
  return out;
}

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

  const all = walk(SRC).flatMap((f) =>
    findUserWriters(path.relative(SRC, f).replace(/\\/g, "/"), fs.readFileSync(f, "utf8")),
  );

  it("not vacuous: finds the known status, role/email and soft-delete writers", () => {
    const names = all.map((w) => `${w.file}:${w.method}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "users/users.service.ts:changeStatus",
        "users/users.service.ts:updateUser",
        "customers/customers.service.ts:deleteCustomer",
      ]),
    );
  });

  it("every watched writer revokes in the same method, or is exempt with a reason", () => {
    const bare = all
      .filter((w) => !w.revokes && !EXEMPT[w.file]?.[w.method])
      .map(
        (w) => `${w.file}: ${w.method} writes ${w.keys.join(", ")} without revoking link tokens`,
      );
    expect(bare).toEqual([]);
  });

  it("every EXEMPT entry names a writer that still exists", () => {
    const names = new Set(all.map((w) => `${w.file}:${w.method}`));
    for (const [file, methods] of Object.entries(EXEMPT)) {
      for (const m of Object.keys(methods)) expect(names).toContain(`${file}:${m}`);
    }
  });
});
