/**
 * #2551 / SA-505a — source tripwire for the house lock order (tenant row → subscription row → ledger).
 *
 * Every `$transaction(async (tx) => { … })` under src/ that writes `tx.tenantSubscription` must take
 * the Tenant row lock — `lockTenantForLedger(tx, …)` or the raw `FROM "Tenant" WHERE id = ${…} FOR
 * UPDATE` — BEFORE its first subscription write. A writer that holds the subscription row and then
 * needs the Tenant row (its own tenant update, or an FK insert: BillingEvent/AuditLog ⇒ KEY SHARE)
 * deadlocks (40P01) against a Tenant-first writer (reconcile, Pricing, updatePlan, add-ons).
 *
 * Exempt by rule: a tx that CREATES the tenant row itself (nobody else can hold a lock on it).
 * Known exceptions are a CLOSED list below, each with its reason; a new violation is a red build.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");
const TX_OPEN = /\$transaction\(\s*async\s*\(\s*tx\b[^)]*\)\s*(?::[^=]+)?=>\s*\{/g;
const SUB_WRITE =
  /\btx\.tenantSubscription\.(update|updateMany|upsert|create|createMany|delete|deleteMany)\s*\(/;
const TENANT_LOCK = /lockTenantForLedger\(\s*tx\b|FROM "Tenant" WHERE id = \$\{[^}]+\} FOR UPDATE/;
const TENANT_CREATE = /\btx\.tenant\.create\s*\(/;
const METHOD = /^ {2}(?:(?:private|public|protected)\s+)?(?:static\s+)?async\s+(\w+)\s*\(/gm;

/** `file#method` keys of known violations — CLOSED: each needs a reason and an owner. */
const KNOWN: Record<string, string> = {
  // updatePlan's instant path: #2519 (SA-485b i) adds the Tenant lock after the hook — delete this
  // entry when #2519 lands (the tripwire stays green either way).
  "platform-admin/platform-admin.service.ts#updatePlan":
    "#2519 adds the Tenant lock after the hook",
  // Stripe checkout apply (snapshot flag on): upserts the subscription, then writes an AuditLog row
  // (Tenant FK) — the same inversion class; filed as #2560 rather than widened into #2551.
  "billing/billing.service.ts#onCheckoutCompleted": "#2560 (follow-up from #2551)",
};

function findViolations(files: { rel: string; src: string }[]): string[] {
  const out: string[] = [];
  for (const { rel, src } of files) {
    const methods = [...src.matchAll(METHOD)].map((m) => ({ at: m.index!, name: m[1] }));
    for (const m of src.matchAll(TX_OPEN)) {
      let i = m.index! + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      const body = src.slice(m.index! + m[0].length, i - 1);
      const write = body.search(SUB_WRITE);
      if (write < 0) continue;
      const create = body.search(TENANT_CREATE);
      if (create >= 0 && create < write) continue;
      const lock = body.search(TENANT_LOCK);
      if (lock >= 0 && lock < write) continue;
      const method = methods.filter((x) => x.at < m.index!).pop()?.name ?? "?";
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
  it("every src/ subscription-writing tx takes the Tenant lock first (or is a known exception)", () => {
    const unexpected = findViolations(sources()).filter((k) => !(k in KNOWN));
    expect(unexpected).toEqual([]);
  });

  it("self-test: a synthetic violation is caught; the lock-first and tenant-create shapes are not", () => {
    const wrap = (name: string, body: string) =>
      `class X {\n  async ${name}() {\n    await this.prisma.$transaction(async (tx) => {\n${body}\n    });\n  }\n}\n`;
    const bad = wrap(
      "bad",
      "      await tx.tenantSubscription.update({ where: { tenantId } });\n      await tx.tenant.update({});",
    );
    const good = wrap(
      "good",
      "      await lockTenantForLedger(tx, tenantId);\n      await tx.tenantSubscription.update({});",
    );
    const raw = wrap(
      "raw",
      '      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;\n      await tx.tenantSubscription.upsert({});',
    );
    const created = wrap(
      "created",
      "      const t = await tx.tenant.create({});\n      await tx.tenantSubscription.create({});",
    );
    const lockAfter = wrap(
      "lockAfter",
      "      await tx.tenantSubscription.updateMany({});\n      await lockTenantForLedger(tx, tenantId);",
    );
    expect(
      findViolations([
        { rel: "a.ts", src: bad },
        { rel: "b.ts", src: good },
        { rel: "c.ts", src: raw },
        { rel: "d.ts", src: created },
        { rel: "e.ts", src: lockAfter },
      ]),
    ).toEqual(["a.ts#bad", "e.ts#lockAfter"]);
  });
});
