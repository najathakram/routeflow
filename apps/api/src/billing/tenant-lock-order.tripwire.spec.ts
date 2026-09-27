/**
 * #2551 / SA-505a — source tripwire for the house lock order (tenant row → subscription row → ledger).
 *
 * Every `$transaction(async (<tx>) => { … })` under src/ that writes the subscription row must take
 * the Tenant row lock — `lockTenantForLedger(<tx>, …)` or the raw `FROM "Tenant" WHERE id = ${…} FOR
 * UPDATE` — BEFORE its first subscription write. A writer that holds the subscription row and then
 * needs the Tenant row (its own tenant update, or an FK insert: BillingEvent/AuditLog ⇒ KEY SHARE)
 * deadlocks (40P01) against a Tenant-first writer (reconcile, Pricing, updatePlan, add-ons).
 *
 * #2560 hardening (the lead's review): comments are stripped first (a lock in a comment is not a
 * lock); the tx parameter may have any name; a subscription write is `<tx>.tenantSubscription.<write>(`,
 * a raw `UPDATE`/`INSERT INTO "TenantSubscription"`, or a call passing `<tx>` to a helper that itself
 * writes the subscription row through a parameter.
 *
 * Exempt by rule: a tx that CREATES the tenant row itself (nobody else can hold a lock on it).
 * Known exceptions are a CLOSED list below, each with its reason; a new violation is a red build, and
 * an entry that no longer violates is red too (the list cannot rot).
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");
const TX_OPEN = /\$transaction\(\s*async\s*\(\s*(\w+)\b[^)]*\)\s*(?::[^=]+)?=>\s*\{/g;
const WRITES = "update|updateMany|upsert|create|createMany|delete|deleteMany";
const RAW_SUB_WRITE = /\b(?:UPDATE|INSERT\s+INTO)\s+(?:"public"\.)?"TenantSubscription"/;
const DECL =
  /^\s*(?:export\s+)?(?:(?:private|public|protected)\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*\(\s*(\w+)?/gm;
const NOT_A_NAME = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "await",
  "function",
]);
/** Enclosing class method / top-level function, for the violation key. */
const METHOD =
  /^(?: {2}(?:(?:private|public|protected)\s+)?(?:static\s+)?async\s+|(?:export\s+)?async\s+function\s+)(\w+)\s*\(/gm;

/** `file#method` keys of known violations — CLOSED: each needs a reason and an owner. */
const KNOWN: Record<string, string> = {};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace every comment with spaces (indices preserved), skipping string and template literals. */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/"))
        ((out[i] = src[i] === "\n" ? "\n" : " "), i++);
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
    } else i++;
  }
  return out.join("");
}

/** The `{…}` body opening at `open` (the index just past the `{`). */
function blockFrom(src: string, open: number): string {
  let i = open;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(open, i - 1);
}

const subWriteVia = (v: string) =>
  new RegExp(`\\b${esc(v)}\\.tenantSubscription\\.(?:${WRITES})\\s*\\(`);

/** Named functions/methods that write the subscription row through their FIRST parameter. */
function helperWriters(files: { src: string }[]): Set<string> {
  const names = new Set<string>();
  for (const { src } of files) {
    for (const d of src.matchAll(DECL)) {
      const [, name, param] = d;
      if (!param || NOT_A_NAME.has(name)) continue;
      const open = src.indexOf("{", d.index! + d[0].length);
      if (open < 0) continue;
      const body = blockFrom(src, open + 1);
      if (subWriteVia(param).test(body)) names.add(name);
    }
  }
  return names;
}

function firstIndex(body: string, patterns: RegExp[]): number {
  const hits = patterns.map((p) => body.search(p)).filter((x) => x >= 0);
  return hits.length ? Math.min(...hits) : -1;
}

function findViolations(raw: { rel: string; src: string }[]): string[] {
  const files = raw.map((f) => ({ rel: f.rel, src: stripComments(f.src) }));
  const helpers = helperWriters(files);
  const out: string[] = [];
  for (const { rel, src } of files) {
    const decls = [...src.matchAll(METHOD)].map((d) => ({ at: d.index!, name: d[1] }));
    for (const m of src.matchAll(TX_OPEN)) {
      const tx = esc(m[1]);
      const body = blockFrom(src, m.index! + m[0].length);
      const write = firstIndex(body, [
        subWriteVia(m[1]),
        RAW_SUB_WRITE,
        ...[...helpers].map((h) => new RegExp(`\\b(?:this\\.)?${esc(h)}\\(\\s*${tx}\\b`)),
      ]);
      if (write < 0) continue;
      const create = body.search(new RegExp(`\\b${tx}\\.tenant\\.create\\s*\\(`));
      if (create >= 0 && create < write) continue;
      const lock = firstIndex(body, [
        new RegExp(`\\blockTenantForLedger\\(\\s*${tx}\\b`),
        /FROM "Tenant" WHERE id = \$\{[^}]+\} FOR UPDATE/,
      ]);
      if (lock >= 0 && lock < write) continue;
      const method = decls.filter((x) => x.at < m.index!).pop()?.name ?? "?";
      out.push(`${rel}#${method}`);
    }
  }
  return out;
}

function sources(): { rel: string; src: string }[] {
  const files: { rel: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".spec.ts"))
        files.push({
          rel: path.relative(SRC, p).split(path.sep).join("/"),
          src: fs.readFileSync(p, "utf8"),
        });
    }
  };
  walk(SRC);
  return files;
}

describe("#2551 tripwire — no subscription write in a $transaction before the Tenant lock", () => {
  const found = findViolations(sources());

  it("every src/ subscription-writing tx takes the Tenant lock first (or is a known exception)", () => {
    expect(found.filter((k) => !(k in KNOWN))).toEqual([]);
  });

  it("every KNOWN exception still violates (a fixed writer must leave the list)", () => {
    expect(Object.keys(KNOWN).filter((k) => !found.includes(k))).toEqual([]);
  });

  it("self-test: synthetic violations are caught; the lock-first and tenant-create shapes are not", () => {
    const wrap = (name: string, body: string, param = "tx") =>
      `class X {\n  async ${name}() {\n    await this.prisma.$transaction(async (${param}) => {\n${body}\n    });\n  }\n}\n`;
    const cases: Record<string, string> = {
      bad: wrap(
        "bad",
        "      await tx.tenantSubscription.update({ where: { tenantId } });\n      await tx.tenant.update({});",
      ),
      good: wrap(
        "good",
        "      await lockTenantForLedger(tx, tenantId);\n      await tx.tenantSubscription.update({});",
      ),
      raw: wrap(
        "raw",
        '      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;\n      await tx.tenantSubscription.upsert({});',
      ),
      created: wrap(
        "created",
        "      const t = await tx.tenant.create({});\n      await tx.tenantSubscription.create({});",
      ),
      lockAfter: wrap(
        "lockAfter",
        "      await tx.tenantSubscription.updateMany({});\n      await lockTenantForLedger(tx, tenantId);",
      ),
      // #2560 hardening
      otherName: wrap("otherName", "      await db.tenantSubscription.update({});", "db"),
      otherNameGood: wrap(
        "otherNameGood",
        "      await lockTenantForLedger(db, tenantId);\n      await db.tenantSubscription.update({});",
        "db",
      ),
      rawUpdate: wrap(
        "rawUpdate",
        '      await tx.$executeRaw`UPDATE "TenantSubscription" SET "planKey" = ${k} WHERE "tenantId" = ${id}`;',
      ),
      commentLock: wrap(
        "commentLock",
        "      // await lockTenantForLedger(tx, tenantId);\n      /* lockTenantForLedger(tx, id) */\n      await tx.tenantSubscription.update({});",
      ),
      viaHelper:
        wrap(
          "viaHelper",
          "      await this.writeSub(tx, tenantId);\n      await lockTenantForLedger(tx, tenantId);",
        ) +
        "class Y {\n  private async writeSub(client: any, id: string) {\n    await client.tenantSubscription.update({ where: { tenantId: id } });\n  }\n}\n",
      viaHelperGood: wrap(
        "viaHelperGood",
        "      await lockTenantForLedger(tx, tenantId);\n      await this.writeSub(tx, tenantId);",
      ),
      // #2581 (the lead's #2578 review): the remaining evasions
      tenantTx: `class X {\n  async tenantTx() {\n    await this.prisma.tenantTransaction(async (tx) => {\n      await tx.tenantSubscription.update({});\n    });\n  }\n}\n`,
      nonAsync: `class X {\n  async nonAsync() {\n    await this.prisma.$transaction((tx) => {\n      return tx.tenantSubscription.update({});\n    });\n  }\n}\n`,
      arrowHelper:
        wrap(
          "arrowHelper",
          "      await writeSubArrow(tx, tenantId);\n      await lockTenantForLedger(tx, tenantId);",
        ) +
        "const writeSubArrow = async (c: any, id: string) => {\n  await c.tenantSubscription.update({ where: { tenantId: id } });\n};\n",
      multiLevel:
        wrap(
          "multiLevel",
          "      await this.outerWrite(tx, tenantId);\n      await lockTenantForLedger(tx, tenantId);",
        ) +
        "class Z {\n  private async outerWrite(c: any, id: string) {\n    await this.innerWrite(c, id);\n  }\n  private async innerWrite(d: any, id: string) {\n    await d.tenantSubscription.upsert({});\n  }\n}\n",
      lockInIf: wrap(
        "lockInIf",
        "      if (flag) {\n        await lockTenantForLedger(tx, tenantId);\n      }\n      await tx.tenantSubscription.update({});",
      ),
      lockInString: wrap(
        "lockInString",
        '      const note = "lockTenantForLedger(tx, tenantId)";\n      await tx.tenantSubscription.update({});',
      ),
      regexQuote: wrap(
        "regexQuote",
        '      const re = /"/;\n      // await lockTenantForLedger(tx, tenantId);\n      const q = "x";\n      await tx.tenantSubscription.update({});',
      ),
      rawSelectForUpdate: wrap(
        "rawSelectForUpdate",
        '      await tx.$queryRaw`SELECT 1 FROM "TenantSubscription" WHERE "tenantId" = ${id} FOR UPDATE`;\n      await lockTenantForLedger(tx, tenantId);',
      ),
    };
    expect(findViolations(Object.entries(cases).map(([rel, src]) => ({ rel, src })))).toEqual([
      "bad#bad",
      "lockAfter#lockAfter",
      "otherName#otherName",
      "rawUpdate#rawUpdate",
      "commentLock#commentLock",
      "viaHelper#viaHelper",
      "tenantTx#tenantTx",
      "nonAsync#nonAsync",
      "arrowHelper#arrowHelper",
      "multiLevel#multiLevel",
      "lockInIf#lockInIf",
      "lockInString#lockInString",
      "regexQuote#regexQuote",
      "rawSelectForUpdate#rawSelectForUpdate",
    ]);
  });
});
