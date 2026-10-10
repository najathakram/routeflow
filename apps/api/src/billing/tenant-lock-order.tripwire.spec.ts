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
/** `$transaction(` / `tenantTransaction(` with an (async or not) arrow callback and a block body. */
const TX_OPEN =
  /(?:\$transaction|\btenantTransaction)\(\s*(?:async\s*)?(?:\(\s*(\w+)\b[^)]*\)|(\w+))\s*(?::[^=]+)?=>\s*\{/g;
const WRITES = "update|updateMany|upsert|create|createMany|delete|deleteMany";
/** Raw SQL that writes or row-locks the subscription row (searched in template contents). */
const RAW_SUB_TAKE =
  /\b(?:UPDATE|INSERT\s+INTO)\s+(?:"public"\.)?"TenantSubscription"|\bSELECT\b[^`]*?\bFROM\s+(?:"public"\.)?"TenantSubscription"[^`]*?\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/;
/** Named functions/methods: `name(` at line start (the parameter list is parsed from the paren). */
const DECL =
  /^\s*(?:export\s+)?(?:(?:private|public|protected)\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*\(/gm;
/** Arrow-const helpers: `const name = async (`. */
const ARROW = /\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
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

/**
 * One pass over the source, indices preserved:
 *  - `code`:   comments blanked (string/template/regex contents kept — raw SQL lives in templates);
 *  - `masked`: comments AND string/template/regex contents blanked (code structure only).
 * Regex literals are recognised by the preceding token, so a quote inside one never desyncs the
 * string scanner (#2581).
 */
function scan(src: string): { code: string; masked: string } {
  const code = src.split("");
  const masked = src.split("");
  const blank = (arr: string[], i: number) => {
    if (arr[i] !== "\n") arr[i] = " ";
  };
  const regexAllowedAfter = (i: number) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (j < 0) return true;
    if ("(,=:[!&|?{};+-*%<>~^".includes(src[j])) return true;
    const word = /(\w+)$/.exec(src.slice(Math.max(0, j - 10), j + 1));
    return !!word && ["return", "typeof", "case", "in", "of", "void"].includes(word[1]);
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        const step = src[i] === "\\" ? 2 : 1;
        for (let k = 0; k < step; k++) blank(masked, i + k);
        i += step;
      }
      i++;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") (blank(code, i), blank(masked, i), i++);
    } else if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/"))
        (blank(code, i), blank(masked, i), i++);
      for (const k of [i, i + 1]) (blank(code, k), blank(masked, k));
      i += 2;
    } else if (c === "/" && regexAllowedAfter(i)) {
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n" && (inClass || src[i] !== "/")) {
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        const step = src[i] === "\\" ? 2 : 1;
        for (let k = 0; k < step; k++) blank(masked, i + k);
        i += step;
      }
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
    } else i++;
  }
  return { code: code.join(""), masked: masked.join("") };
}

/** The `{…}` body opening at `open` (the index just past the `{`); braces counted on `masked`. */
function blockEnd(masked: string, open: number): number {
  let i = open;
  let depth = 1;
  while (i < masked.length && depth > 0) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") depth--;
    i++;
  }
  return i - 1;
}

const subWriteVia = (v: string) =>
  new RegExp(`\\b${esc(v)}\\.tenantSubscription\\.(?:${WRITES})\\s*\\(`);
/**
 * #2614: the top-level comma-separated pieces between the paren at `open` (index just past `(`) and
 * its match, on `masked` (so commas and parens inside strings are already blanked).
 */
function splitArgs(masked: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let start = open;
  let i = open;
  for (; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(masked.slice(start, i));
      start = i + 1;
    }
  }
  const last = masked.slice(start, i);
  if (last.trim() || args.length) args.push(last);
  return { args, end: i };
}

/** A declared parameter's name: `client: Tx`, `c = x`, `...rest`, `opt?: T` ⇒ its identifier. */
const paramName = (piece: string) => /^\s*(?:\.\.\.)?(\w+)/.exec(piece)?.[1];

/**
 * #2614: the first index in `body` where a call to helper `h` passes `v` at one of the argument
 * positions `h` writes the subscription row through (`this.h(…)` or `h(…)`), else -1.
 */
function helperCallAt(body: string, h: string, positions: Set<number>, v: string): number {
  const re = new RegExp(`\\b(?:this\\.)?${esc(h)}\\(`, "g");
  for (const m of body.matchAll(re)) {
    const { args } = splitArgs(body, m.index! + m[0].length);
    for (const at of positions) if (args[at]?.trim() === v) return m.index!;
  }
  return -1;
}

type Scanned = { rel: string; code: string; masked: string };

/** Functions/methods/arrow-consts that write the subscription row through one of their parameters
 *  — directly, by raw SQL, or through another such helper (resolved to a fixpoint: multi-level).
 *  #2614: keyed by name → the parameter POSITIONS that write, so a tx passed as a non-first argument
 *  is seen, and a tx passed in a position the helper does not write through is not. */
function helperWriters(files: Scanned[]): Map<string, Set<number>> {
  const candidates: { name: string; params: string[]; code: string; masked: string }[] = [];
  for (const { code, masked } of files) {
    const add = (name: string, paren: number) => {
      if (NOT_A_NAME.has(name)) return;
      const { args, end: close } = splitArgs(masked, paren);
      const params = args.map((p) => paramName(p) ?? "");
      if (!params.some(Boolean)) return;
      const arrow = masked.indexOf("=>", close);
      const brace = masked.indexOf("{", close);
      if (brace < 0) return;
      // For an arrow const, the body is the block after `=>` (skip a block in the return type).
      const open =
        arrow >= 0 && arrow < brace + 200 && masked.indexOf("{", arrow) >= 0
          ? masked.indexOf("{", arrow) + 1
          : brace + 1;
      const end = blockEnd(masked, open);
      candidates.push({
        name,
        params,
        code: code.slice(open, end),
        masked: masked.slice(open, end),
      });
    };
    for (const d of masked.matchAll(DECL)) add(d[1], d.index! + d[0].length);
    for (const d of masked.matchAll(ARROW)) add(d[1], d.index! + d[0].length);
  }
  const helpers = new Map<string, Set<number>>();
  for (let changed = true; changed;) {
    changed = false;
    for (const c of candidates) {
      c.params.forEach((param, at) => {
        if (!param || helpers.get(c.name)?.has(at)) return;
        const writes =
          subWriteVia(param).test(c.masked) ||
          (RAW_SUB_TAKE.test(c.code) && new RegExp(`\\b${esc(param)}\\.\\$`).test(c.masked)) ||
          [...helpers].some(([h, pos]) => helperCallAt(c.masked, h, pos, param) >= 0);
        if (writes) {
          if (!helpers.has(c.name)) helpers.set(c.name, new Set());
          helpers.get(c.name)!.add(at);
          changed = true;
        }
      });
    }
  }
  return helpers;
}

function firstIndex(body: string, patterns: RegExp[], accept = (_i: number) => true): number {
  let best = -1;
  for (const p of patterns) {
    const g = new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g");
    for (const m of body.matchAll(g)) {
      if (!accept(m.index!)) continue;
      if (best < 0 || m.index! < best) best = m.index!;
      break;
    }
  }
  return best;
}

/** A lock counts only as an unconditional statement at the tx body's top level. */
function topLevelStatement(masked: string, at: number): boolean {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") depth--;
  }
  if (depth !== 0) return false;
  const start = Math.max(
    masked.lastIndexOf(";", at),
    masked.lastIndexOf("{", at),
    masked.lastIndexOf("}", at),
  );
  return !/\bif\s*\(|\?|&&|\|\|/.test(masked.slice(start + 1, at));
}

function findViolations(raw: { rel: string; src: string }[]): string[] {
  const files: Scanned[] = raw.map((f) => ({ rel: f.rel, ...scan(f.src) }));
  const helpers = helperWriters(files);
  const out: string[] = [];
  for (const { rel, code, masked } of files) {
    const decls = [...masked.matchAll(METHOD)].map((d) => ({ at: d.index!, name: d[1] }));
    for (const m of masked.matchAll(TX_OPEN)) {
      const txName = m[1] ?? m[2];
      const tx = esc(txName);
      const open = m.index! + m[0].length;
      const end = blockEnd(masked, open);
      const body = masked.slice(open, end);
      const bodyCode = code.slice(open, end);
      const write = Math.min(
        ...[
          firstIndex(body, [subWriteVia(txName)]),
          ...[...helpers].map(([h, pos]) => helperCallAt(body, h, pos, txName)),
          firstIndex(bodyCode, [RAW_SUB_TAKE]),
        ].map((x) => (x < 0 ? Infinity : x)),
      );
      if (write === Infinity) continue;
      const create = body.search(new RegExp(`\\b${tx}\\.tenant\\.create\\s*\\(`));
      if (create >= 0 && create < write) continue;
      const top = (i: number) => topLevelStatement(body, i);
      const lock = Math.min(
        ...[
          firstIndex(body, [new RegExp(`\\blockTenantForLedger\\(\\s*${tx}\\b`)], top),
          firstIndex(
            bodyCode,
            [
              new RegExp(
                `\\b${tx}\\.\\$(?:queryRaw|executeRaw)\\s*\`[^\`]*FROM "Tenant" WHERE id = \\$\\{[^}]+\\} FOR UPDATE`,
              ),
            ],
            top,
          ),
        ].map((x) => (x < 0 ? Infinity : x)),
      );
      if (lock < write) continue;
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
      // #2614 (the lead's review of #2609): a tx passed as a NON-FIRST argument
      nonFirstMethod:
        wrap(
          "nonFirstMethod",
          "      await this.writeSubAt(tenantId, tx);\n      await lockTenantForLedger(tx, tenantId);",
        ) +
        "class W {\n  private async writeSubAt(id: string, client: any) {\n    await client.tenantSubscription.update({ where: { tenantId: id } });\n  }\n}\n",
      nonFirstArrow:
        wrap(
          "nonFirstArrow",
          "      await writeSubArrowAt(tenantId, tx);\n      await lockTenantForLedger(tx, tenantId);",
        ) +
        "const writeSubArrowAt = async (id: string, c: any) => {\n  await c.tenantSubscription.upsert({});\n};\n",
      nonFirstGood: wrap(
        "nonFirstGood",
        "      await lockTenantForLedger(tx, tenantId);\n      await this.writeSubAt(tenantId, tx);",
      ),
      // precision: tx in a position the helper does NOT write through is not a subscription write
      nonWritingPosition: wrap(
        "nonWritingPosition",
        "      await this.writeSubAt(tx, tenantId);\n      await lockTenantForLedger(tx, tenantId);",
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
      "nonFirstMethod#nonFirstMethod",
      "nonFirstArrow#nonFirstArrow",
    ]);
  });
});
