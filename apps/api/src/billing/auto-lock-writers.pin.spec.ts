/**
 * SA-775 ruling 6 - the STRUCTURAL PIN over every writer of a tenant lock.
 *
 * Built by predicate, not by a hand-kept list of call sites: every function in `apps/api/src` (spec files
 * excluded) that writes `Tenant.status` to anything but ACTIVE / TRIAL, writes a non-null `readOnlyReason`, or
 * hands such a target to a status-transition helper (`transitionAndEmit` / `deps.transition`), must be CLASSED
 * in WRITERS below:
 *
 *   AUTOMATIC       a cron / webhook locks on its own. Must call `autoLockAllowed` BEFORE its first write
 *                   (checked by source order inside the same function).
 *   TENANT_ACTION   a tenant's own click locks at once. Gated the same way.
 *   MANUAL_ADMIN    a super admin's deliberate act. An allow-list (`updateStatus`, `deleteTenant`); must NOT be gated.
 *   NOT_A_NEW_LOCK  writes a status/reason that is not a new automatic lock (generic primitive, ACTIVE-only,
 *                   reason-only). Needs a written reason.
 *
 * An UNCLASSED writer fails the build until a person classes it; a stale table entry fails too. The scanner
 * is proven on injected sources (the negative self-controls at the bottom).
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

type Cls = "AUTOMATIC" | "TENANT_ACTION" | "MANUAL_ADMIN" | "NOT_A_NEW_LOCK";
interface Entry {
  cls: Cls;
  reason?: string;
}

/** `file::function` -> its class. Complete for the tree at 5a938f0a2 plus this change. */
const WRITERS: Record<string, Entry> = {
  // ─── AUTOMATIC: must ask autoLockAllowed first ───────────────────────────────
  "billing/billing-cron.service.ts::expireTrials": { cls: "AUTOMATIC" },
  "billing/billing-cron.service.ts::applyScheduledCancellations": { cls: "AUTOMATIC" },
  "billing/billing.service.ts::suspendOverdueTenants": { cls: "AUTOMATIC" },
  "billing/billing.service.ts::cancelFromStripe": { cls: "AUTOMATIC" },
  "billing/dunning-pause.ts::pauseTenantTx": { cls: "AUTOMATIC" },
  // ─── TENANT ACTION: gated the same way ───────────────────────────────────────
  "billing/subscription-mutation.service.ts::cancel": { cls: "TENANT_ACTION" },
  // ─── MANUAL ADMIN: a super admin's own act, never paused ─────────────────────
  "platform-admin/platform-admin.service.ts::updateStatus": { cls: "MANUAL_ADMIN" },
  "platform-admin/platform-admin.service.ts::deleteTenant": { cls: "MANUAL_ADMIN" },
  // ─── NOT A NEW LOCK ──────────────────────────────────────────────────────────
  "billing/billing.service.ts::transitionAndEmit": {
    cls: "NOT_A_NEW_LOCK",
    reason:
      "the generic compare-and-swap primitive: it writes whatever target its caller names, and every lock caller (suspendOverdueTenants, cancelFromStripe, pauseTenantTx) is classed and gated above",
  },
  "billing/transition-to-active.ts::transitionToActiveTx": {
    cls: "NOT_A_NEW_LOCK",
    reason: "writes status ACTIVE only (the one way back to ACTIVE); it can never lock a tenant",
  },
  "billing/dunning.service.ts::markCancelledWhilePaused": {
    cls: "NOT_A_NEW_LOCK",
    reason:
      "rewrites readOnlyReason on a tenant that is ALREADY READ_ONLY(payment_overdue); the status never changes",
  },
};

const MANUAL_ADMIN_ALLOW = new Set([
  "platform-admin/platform-admin.service.ts::updateStatus",
  "platform-admin/platform-admin.service.ts::deleteTenant",
]);

// ─── the scanner ───────────────────────────────────────────────────────────────

interface Fn {
  name: string;
  /** Source text of the whole function, header line included. */
  text: string;
  /** Offset in `text` where the header line ends (call-shaped hits on the header itself are not writes). */
  headerEnd: number;
}
interface Writer {
  key: string;
  fn: Fn;
  /** Offset (in fn.text) of the first lock-capable write. */
  firstWrite: number;
  gateAt: number;
}

const NOT_FUNCTION = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "constructor",
  "function",
  "await",
  "super",
  "new",
  "typeof",
  "do",
  "try",
]);

/** Splits a TS source into top-level functions and 2-space-indented class methods (prettier layout). */
export function findFunctions(text: string): Fn[] {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  const out: Fn[] = [];
  const topRe = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
  const methodRe =
    /^ {2}(?:(?:public|private|protected|static|override|readonly)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name: string | null = null;
    let closeRe: RegExp | null = null;
    const top = topRe.exec(line);
    if (top) {
      name = top[1];
      closeRe = /^\}/;
    } else {
      const m = methodRe.exec(line);
      if (m && !NOT_FUNCTION.has(m[1])) {
        name = m[1];
        closeRe = /^ {2}\}/;
      }
    }
    if (!name || !closeRe) continue;
    let j = i;
    // a one-line body (`{ ... }` closed on the header line) ends there
    if (!/\{\s*$/.test(line) && /\}\s*$/.test(line) && !/\(\s*$/.test(line)) {
      j = i;
    } else {
      for (j = i + 1; j < lines.length; j++) if (closeRe.test(lines[j])) break;
    }
    const end = Math.min(j, lines.length - 1);
    const body = lines.slice(i, end + 1).join("\n");
    out.push({ name, text: body, headerEnd: lines[i].length });
  }
  return out;
}

/** The balanced `(...)` text starting at the `(` found at `open`, skipping strings and comments. */
export function balancedCall(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i = i + 1; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** Top-level comma split of the inside of a call's parentheses. */
export function splitArgs(call: string): string[] {
  const inner = call.slice(1, call.endsWith(")") ? -1 : undefined);
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      for (i = i + 1; i < inner.length && inner[i] !== c; i++) if (inner[i] === "\\") i++;
      cur += inner.slice(start, i + 1);
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** The `data: ...` value of a Prisma write call text: its `{...}` text, or the bare identifier. */
function dataArg(call: string): { kind: "object" | "ident" | "none"; text: string } {
  const m = /\bdata\s*:\s*/.exec(call);
  if (!m) return { kind: "none", text: "" };
  const start = m.index + m[0].length;
  if (call[start] === "{") {
    let depth = 0;
    for (let i = start; i < call.length; i++) {
      if (call[i] === "{") depth++;
      else if (call[i] === "}" && --depth === 0)
        return { kind: "object", text: call.slice(start, i + 1) };
    }
    return { kind: "object", text: call.slice(start) };
  }
  return { kind: "ident", text: call.slice(start).split(/[,}\s]/)[0] };
}

const isSafeStatusValue = (v: string) =>
  /^["']?(ACTIVE|TRIAL)["']?(\s+as\s+const)?$/.test(v.trim());

/** Offsets of lock-capable writes inside a function body. */
function lockWrites(fn: Fn): number[] {
  const hits: number[] = [];
  const body = fn.text;
  const prismaWrite = /\.tenant\.(?:update|updateMany|upsert)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = prismaWrite.exec(body))) {
    const call = balancedCall(body, m.index + m[0].length - 1);
    const data = dataArg(call);
    if (data.kind === "ident") {
      hits.push(m.index); // `data: someVariable` - cannot be proven safe
    } else if (data.kind === "object") {
      const status = /\bstatus\s*:\s*([^,}\n]+)/.exec(data.text);
      const reason = /\breadOnlyReason\s*:\s*([^,}\n]+)/.exec(data.text);
      if ((status && !isSafeStatusValue(status[1])) || (reason && reason[1].trim() !== "null")) {
        hits.push(m.index);
      }
    }
  }
  const rawSql = /UPDATE\s+"?Tenant"?\s+SET/gi;
  while ((m = rawSql.exec(body))) hits.push(m.index);
  const helper = /\b(?:transitionAndEmit|deps\.transition)\s*\(/g;
  while ((m = helper.exec(body))) {
    if (m.index < fn.headerEnd) continue; // the method's own declaration
    const args = splitArgs(balancedCall(body, m.index + m[0].length - 1));
    if (args[0]?.startsWith("...")) continue; // a pass-through binding, not a call with a target
    if (args[2] === undefined || !isSafeStatusValue(args[2])) hits.push(m.index);
  }
  return hits.sort((a, b) => a - b);
}

/**
 * Blanks line and block comments (same length, newlines kept) so a word in a comment can neither fake a write
 * nor fake the gate call. String and template contents are left alone.
 */
export function blankComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      i--;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
      i--;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      for (i = i + 1; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
      continue;
    }
    out += c;
  }
  return out;
}

export function scanSource(file: string, rawText: string): Writer[] {
  const text = blankComments(rawText);
  const out: Writer[] = [];
  for (const fn of findFunctions(text)) {
    const hits = lockWrites(fn);
    if (!hits.length) continue;
    out.push({
      key: `${file}::${fn.name}`,
      fn,
      firstWrite: hits[0],
      gateAt: fn.text.indexOf("autoLockAllowed("),
    });
  }
  return out;
}

export interface Verdict {
  unclassed: string[];
  stale: string[];
  ungated: string[];
  gatedManual: string[];
  badManualAllow: string[];
  noReason: string[];
}

export function judge(writers: Writer[], table: Record<string, Entry>): Verdict {
  const v: Verdict = {
    unclassed: [],
    stale: [],
    ungated: [],
    gatedManual: [],
    badManualAllow: [],
    noReason: [],
  };
  const seen = new Set<string>();
  for (const w of writers) {
    seen.add(w.key);
    const e = table[w.key];
    if (!e) {
      v.unclassed.push(w.key);
      continue;
    }
    if (e.cls === "AUTOMATIC" || e.cls === "TENANT_ACTION") {
      if (w.gateAt < 0 || w.gateAt > w.firstWrite) v.ungated.push(w.key);
    } else if (e.cls === "MANUAL_ADMIN") {
      if (!MANUAL_ADMIN_ALLOW.has(w.key)) v.badManualAllow.push(w.key);
      if (w.gateAt >= 0) v.gatedManual.push(w.key);
    } else if (!e.reason || e.reason.length < 20) v.noReason.push(w.key);
  }
  for (const k of Object.keys(table)) if (!seen.has(k)) v.stale.push(k);
  return v;
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") collect(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const SOURCES = collect(SRC_ROOT).map((file) => ({
  file: path.relative(SRC_ROOT, file).replace(/\\/g, "/"),
  text: fs.readFileSync(file, "utf8"),
}));
const WRITERS_FOUND = SOURCES.flatMap((s) => scanSource(s.file, s.text));

describe("SA-775 structural pin: every writer of a tenant lock is classed", () => {
  it("scans a non-trivial tree (an empty scan would report green)", () => {
    expect(SOURCES.length).toBeGreaterThan(300);
    expect(WRITERS_FOUND.length).toBeGreaterThanOrEqual(8);
  });

  it("every detected writer is in the table, every table entry is still a detected writer", () => {
    const v = judge(WRITERS_FOUND, WRITERS);
    expect({ unclassed: v.unclassed, stale: v.stale }).toEqual({ unclassed: [], stale: [] });
  });

  it("AUTOMATIC and TENANT ACTION writers call autoLockAllowed BEFORE their first write", () => {
    expect(judge(WRITERS_FOUND, WRITERS).ungated).toEqual([]);
  });

  it("MANUAL ADMIN is exactly updateStatus + deleteTenant, and neither is gated", () => {
    const v = judge(WRITERS_FOUND, WRITERS);
    expect(v.badManualAllow).toEqual([]);
    expect(v.gatedManual).toEqual([]);
    expect(
      Object.entries(WRITERS)
        .filter(([, e]) => e.cls === "MANUAL_ADMIN")
        .map(([k]) => k)
        .sort(),
    ).toEqual([...MANUAL_ADMIN_ALLOW].sort());
  });

  it("every NOT-A-NEW-LOCK entry says why", () => {
    expect(judge(WRITERS_FOUND, WRITERS).noReason).toEqual([]);
  });

  // ─── negative self-controls: the scanner must catch what it exists to catch ───

  const wrap = (body: string) => `export class X {\n  async lockIt(t: any) {\n${body}\n  }\n}\n`;

  it("SELF-CONTROL: an injected unclassed writer (direct status write) is reported", () => {
    const src = wrap(
      `    await this.prisma.tenant.update({ where: { id: 1 }, data: { status: "SUSPENDED" } });`,
    );
    const found = scanSource("billing/new-writer.ts", src);
    expect(found.map((w) => w.key)).toEqual(["billing/new-writer.ts::lockIt"]);
    expect(judge(found, WRITERS).unclassed).toEqual(["billing/new-writer.ts::lockIt"]);
  });

  it("SELF-CONTROL: unclassed writers through a helper call, a dynamic status and a variable data are reported", () => {
    const viaHelper = wrap(
      `    await this.transitionAndEmit(id, { status: "ACTIVE" }, "CANCELLED", -1, ev, {});`,
    );
    const dynamic = wrap(
      `    await tx.tenant.updateMany({ where: { id }, data: { status: dto.status } });`,
    );
    const ident = wrap(`    await tx.tenant.updateMany({ where: { id }, data: patch });`);
    const reason = wrap(
      `    await tx.tenant.update({ where: { id }, data: { readOnlyReason: "x" } });`,
    );
    for (const src of [viaHelper, dynamic, ident, reason]) {
      expect(judge(scanSource("billing/w.ts", src), WRITERS).unclassed).toEqual([
        "billing/w.ts::lockIt",
      ]);
    }
  });

  it("SELF-CONTROL: writes that are NOT locks are not flagged", () => {
    const safe = [
      wrap(`    await tx.tenant.update({ where: { id }, data: { plan: "X" } });`),
      wrap(
        `    await tx.tenant.updateMany({ where: { id, status: "TRIAL" }, data: { status: "ACTIVE", readOnlyReason: null } });`,
      ),
      wrap(
        `    await tx.tenant.updateMany({ where: { id }, data: { status: "TRIAL", readOnlyReason: null } });`,
      ),
      wrap(`    await this.transitionAndEmit(id, { status: "READ_ONLY" }, "ACTIVE", 1, ev, {});`),
      wrap(`    this.dunning?.bindTransition((...args) => this.transitionAndEmit(...args));`),
    ];
    for (const src of safe) expect(scanSource("billing/s.ts", src)).toEqual([]);
  });

  it("SELF-CONTROL: an AUTOMATIC writer WITHOUT the gate call fails", () => {
    const src = wrap(
      `    await this.prisma.tenant.update({ where: { id: 1 }, data: { status: "READ_ONLY" } });`,
    );
    const found = scanSource("billing/auto.ts", src);
    const table = { "billing/auto.ts::lockIt": { cls: "AUTOMATIC" as const } };
    expect(judge(found, table).ungated).toEqual(["billing/auto.ts::lockIt"]);
  });

  it("SELF-CONTROL: an AUTOMATIC writer that gates AFTER its write fails; gating BEFORE passes", () => {
    const after = wrap(
      `    await this.prisma.tenant.update({ where: { id: 1 }, data: { status: "READ_ONLY" } });\n    await autoLockAllowed(sw, t, "trial_expired");`,
    );
    const before = wrap(
      `    if (!(await autoLockAllowed(sw, t, "trial_expired"))) return;\n    await this.prisma.tenant.update({ where: { id: 1 }, data: { status: "READ_ONLY" } });`,
    );
    const table = { "billing/auto.ts::lockIt": { cls: "AUTOMATIC" as const } };
    expect(judge(scanSource("billing/auto.ts", after), table).ungated).toHaveLength(1);
    expect(judge(scanSource("billing/auto.ts", before), table).ungated).toEqual([]);
  });

  it("SELF-CONTROL: a stale table entry, a gated manual admin and a reasonless NOT-A-NEW-LOCK fail", () => {
    expect(judge([], { "billing/gone.ts::x": { cls: "AUTOMATIC" } }).stale).toEqual([
      "billing/gone.ts::x",
    ]);
    const gatedManual = wrap(
      `    await autoLockAllowed(sw, t, "trial_expired");\n    await this.prisma.tenant.update({ where: { id: 1 }, data: { status: "SUSPENDED" } });`,
    );
    const manualTable = { "billing/m.ts::lockIt": { cls: "MANUAL_ADMIN" as const } };
    const v = judge(scanSource("billing/m.ts", gatedManual), manualTable);
    expect(v.badManualAllow).toEqual(["billing/m.ts::lockIt"]);
    expect(v.gatedManual).toEqual(["billing/m.ts::lockIt"]);
    const plain = wrap(
      `    await this.prisma.tenant.update({ where: { id: 1 }, data: { status: "SUSPENDED" } });`,
    );
    expect(
      judge(scanSource("billing/n.ts", plain), {
        "billing/n.ts::lockIt": { cls: "NOT_A_NEW_LOCK" },
      }).noReason,
    ).toEqual(["billing/n.ts::lockIt"]);
  });
});
