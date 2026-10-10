/**
 * SA-733r7 PR-B3 structural pins (source scans, no I/O):
 *   1. the ONE path back to ACTIVE: no Tenant write in billing / platform-admin spells `status: "ACTIVE"` in its
 *      `data` outside transition-to-active.ts (SA-733r2 N5);
 *   2. every plan-mutation entry point (subscribe / upgrade / downgrade / resume / checkout) calls the
 *      PAYMENT_OVERDUE guard first;
 *   3. Stripe's pause_collection is only ever written by the dunning pause module;
 *   4. the dunning crons are @LeaderCron with the named jobs (and nothing in the dunning modules uses a bare @Cron);
 *   5. the blast-radius report is genuinely read-only.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");
const API = path.resolve(SRC, "..");

const read = (p: string) => fs.readFileSync(p, "utf8");

/** Source with block and line comments blanked (strings kept), so prose never counts. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(full, out);
    } else if (e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

/** The text between the bracket at `open` (which must be `(` or `{`) and its match. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}" };
  const o = src[open];
  const c = pairs[o];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

describe("SA-733r7 PR-B3 structural pins", () => {
  describe("the ONE path back to ACTIVE (transitionToActiveTx)", () => {
    const files = [...walk(path.join(SRC, "billing")), ...walk(path.join(SRC, "platform-admin"))];
    const ALLOWED = new Set([path.join(SRC, "billing", "transition-to-active.ts")]);

    it("scans a real file set", () => {
      expect(files.length).toBeGreaterThan(30);
      expect([...ALLOWED].every((f) => fs.existsSync(f))).toBe(true);
    });

    /**
     * Every `status:` value a Tenant write can put in its data. A string literal that is not ACTIVE is fine. Anything
     * that MENTIONS ACTIVE (`"ACTIVE"`, `'ACTIVE'`, `TenantStatus.ACTIVE`, `"ACTIVE" as const`) or is a non-literal
     * expression is an offender unless it is one of the reviewed sites below (each one is guarded so that it can never
     * carry ACTIVE). Raw SQL that sets a Tenant status to ACTIVE is an offender with no exception.
     */
    const REVIEWED_NON_LITERALS: { file: RegExp; expr: string; guard: RegExp }[] = [
      {
        // transitionAndEmit's non-ACTIVE branch: the ACTIVE branch above it goes through the helper
        file: /billing[\\/]billing\.service\.ts$/,
        expr: "toStatus",
        guard: /if \(toStatus === "ACTIVE"\) \{[\s\S]*?transitionToActiveTx\([\s\S]*?\} else \{/,
      },
      {
        // admin updateStatus: the ACTIVE target is written by the helper; only other targets reach this update
        file: /platform-admin[\\/]platform-admin\.service\.ts$/,
        expr: "dto.status",
        guard: /dto\.status === "ACTIVE"\s*\?\s*\{ \.\.\.before/,
      },
    ];

    it("no Tenant write outside the helper can write ACTIVE: literal, TenantStatus.ACTIVE, an unreviewed expression, or raw SQL", () => {
      const offenders: string[] = [];
      for (const f of files) {
        if (ALLOWED.has(f)) continue;
        const raw = read(f);
        const src = code(raw);
        const rel = path.relative(SRC, f);
        const re = /\.tenant\.(update|updateMany|upsert|create|createMany)\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          const args = balanced(src, m.index + m[0].length - 1);
          const dm = /\bdata\s*:\s*(\{)?/.exec(args);
          const shorthand = /\bdata\s*[,}]/.test(args) && !dm;
          if (shorthand || (dm && !dm[1])) {
            offenders.push(`${rel}: Tenant write with a non-literal data object`);
            continue;
          }
          if (!dm) continue;
          const data = balanced(args, dm.index + dm[0].length - 1);
          const vre = /\bstatus\s*:\s*([^,}\n]+)/g;
          let v: RegExpExecArray | null;
          while ((v = vre.exec(data))) {
            const expr = v[1].trim();
            if (/^["'`](?!ACTIVE["'`])\w+["'`]$/.test(expr)) continue; // another status, spelled out
            const reviewed = REVIEWED_NON_LITERALS.find(
              (r) => r.file.test(f) && r.expr === expr && r.guard.test(src),
            );
            if (!reviewed) offenders.push(`${rel}: status: ${expr}`);
          }
        }
        // raw SQL: UPDATE "Tenant" ... SET ... status ... ACTIVE
        for (const t of raw.matchAll(/UPDATE\s+(?:"public"\.)?"Tenant"[\s\S]{0,400}/g)) {
          if (/status[\s\S]{0,80}ACTIVE/i.test(t[0].split(/WHERE/i)[0])) {
            offenders.push(`${rel}: raw SQL sets Tenant.status = ACTIVE`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it("the pin itself is not vacuous: it flags each spelling of an ACTIVE write", () => {
      const flagged = (snippet: string) => {
        const src = code(snippet);
        const args = balanced(src, src.indexOf("("));
        const dm = /\bdata\s*:\s*(\{)?/.exec(args)!;
        const data = balanced(args, dm.index + dm[0].length - 1);
        const v = /\bstatus\s*:\s*([^,}\n]+)/.exec(data);
        return !!v && !/^["'`](?!ACTIVE["'`])\w+["'`]$/.test(v[1].trim());
      };
      expect(flagged('tx.tenant.updateMany({ where: {}, data: { status: "ACTIVE" } })')).toBe(true);
      expect(
        flagged("tx.tenant.update({ where: {}, data: { status: TenantStatus.ACTIVE } })"),
      ).toBe(true);
      expect(flagged("tx.tenant.update({ where: {}, data: { status: dto.status } })")).toBe(true);
      expect(flagged('tx.tenant.update({ where: {}, data: { status: "ACTIVE" as const } })')).toBe(
        true,
      );
      expect(flagged('tx.tenant.update({ where: {}, data: { status: "TRIAL" } })')).toBe(false);
    });

    it("transitionAndEmit routes toStatus === ACTIVE through transitionToActiveTx", () => {
      const src = code(read(path.join(SRC, "billing", "billing.service.ts")));
      const i = src.indexOf("async transitionAndEmit(");
      const body = src.slice(i, i + 3500);
      expect(body).toMatch(/if \(toStatus === "ACTIVE"\)[\s\S]*transitionToActiveTx\(/);
    });

    it("the helper clears pastDueSince, pastDueInvoiceId and pausedAt and nulls readOnlyReason", () => {
      const src = code(read(path.join(SRC, "billing", "transition-to-active.ts")));
      expect(src).toMatch(/pastDueSince:\s*null/);
      expect(src).toMatch(/pastDueInvoiceId:\s*null/);
      expect(src).toMatch(/pausedAt:\s*null/);
      expect(src).toMatch(/readOnlyReason:\s*null/);
    });
  });

  describe("PAYMENT_OVERDUE guard on every plan-mutation entry point", () => {
    const mutation = code(read(path.join(SRC, "billing", "subscription-mutation.service.ts")));
    const firstLines = (signature: RegExp) => {
      const m = signature.exec(mutation);
      expect(m).not.toBeNull();
      const body = mutation.slice(m!.index, m!.index + 900);
      const open = body.indexOf("{", body.indexOf(")"));
      return body.slice(open + 1, open + 260);
    };

    it.each([
      ["subscribe", /async subscribe\(/],
      ["upgrade", /private async upgradeLocked\(/],
      ["downgrade", /async downgrade\(/],
      ["resume", /async resume\(/],
    ])("%s calls the guard as its first statement, naming itself", (name, sig) => {
      expect(firstLines(sig as RegExp)).toContain(
        `await this.assertNotOverdue(tenantId, "${name}")`,
      );
    });

    // The pin LISTS every call site. A new plan-mutation entry point that does not call the one helper (or a
    // call site that is dropped) is a red build: the set of entry-point names is closed.
    const EXPECTED_ENTRY_POINTS = [
      "admin_plan_change",
      "checkout",
      "downgrade",
      "resume",
      "subscribe",
      "upgrade",
    ];
    const callSites = () => {
      const found: string[] = [];
      for (const f of walk(SRC)) {
        const src = code(read(f));
        for (const m of src.matchAll(/assertNotOverdue\(\s*tenantId,\s*"(\w+)"\s*\)/g))
          found.push(m[1]);
        for (const m of src.matchAll(
          /assertTenantNotPaymentOverdue\(\s*\{[^}]*\},\s*\w+,\s*"(\w+)"/g,
        ))
          found.push(m[1]);
      }
      return found.sort();
    };

    it("the closed list of entry points (each exactly once): subscribe / upgrade / downgrade / resume / checkout / the B1 admin plan change", () => {
      expect(callSites()).toEqual(EXPECTED_ENTRY_POINTS);
    });

    it("checkout (BillingService.createCheckoutSession) and the admin plan change (updatePlanLocked) call the same helper", () => {
      const billing = code(read(path.join(SRC, "billing", "billing.service.ts")));
      const i = billing.indexOf("async createCheckoutSession(");
      expect(billing.slice(i, i + 4500)).toMatch(/await assertTenantNotPaymentOverdue\(/);
      const admin = code(read(path.join(SRC, "platform-admin", "platform-admin.service.ts")));
      const j = admin.indexOf("private async updatePlanLocked(");
      expect(admin.slice(j, j + 1200)).toMatch(
        /await assertTenantNotPaymentOverdue\([\s\S]*"admin_plan_change"/,
      );
    });

    it("the guard answers with API_ERROR_CODES, never a bare string, and dark logs a would-refuse line", () => {
      const src = code(read(path.join(SRC, "billing", "payment-overdue.ts")));
      expect(src).toMatch(/API_ERROR_CODES\.PAYMENT_OVERDUE/);
      expect(src).toMatch(/API_ERROR_CODES\.PAYMENT_STATE_UNKNOWN/);
      expect(src).toMatch(/hosted_invoice_url/);
      expect(src).toMatch(
        /billing\.dunning\.would_refuse code=\$\{API_ERROR_CODES\.PAYMENT_OVERDUE\}/,
      );
    });
  });

  describe("Stripe pause_collection", () => {
    it("is written only by dunning-pause.ts", () => {
      const offenders = walk(SRC)
        .filter((f) => /\bpause_collection\s*:/.test(code(read(f))))
        .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
        .filter((f) => f !== "billing/dunning-pause.ts");
      expect(offenders).toEqual([]);
    });

    it("every call carries an idempotency key naming (tenant, pause | unpause | reconcile, instant)", () => {
      const src = code(read(path.join(SRC, "billing", "dunning-pause.ts")));
      expect(src).toMatch(/\$\{target\.tenantId\}:pause:\$\{pausedAt\.toISOString\(\)\}/);
      expect(src).toMatch(/\$\{exit\.tenantId\}:unpause:\$\{exit\.exitAt\.toISOString\(\)\}/);
      expect(src).toMatch(/\$\{r\.tenantId\}:reconcile:\$\{runAt\.toISOString\(\)\}/);
      expect((src.match(/updateSubscription\(/g) ?? []).length).toBe(3);
      expect((src.match(/idempotencyKey/g) ?? []).length).toBe(3);
    });
  });

  describe("scheduled jobs", () => {
    const svc = code(read(path.join(SRC, "billing", "dunning.service.ts")));

    it("the sweep and the reconcilers are @LeaderCron with the gate's job names", () => {
      expect(svc).toMatch(/@LeaderCron\(CronExpression\.EVERY_HOUR, "billing\.dunningSweep"\)/);
      expect(svc).toMatch(/@LeaderCron\(CronExpression\.EVERY_HOUR, "billing\.pauseReconcile"\)/);
      expect(svc).toMatch(/@LeaderCron\("0 4 \* \* \*", "billing\.dunningDiscovery"\)/);
      expect(svc).toMatch(/@LeaderCron\("0 11 1 \* \*", "billing\.pauseReconcileFirst"\)/);
    });

    it("no dunning module uses a bare @Cron", () => {
      for (const f of walk(path.join(SRC, "billing")).filter((p) =>
        /dunning|payment-overdue/.test(p),
      )) {
        expect(code(read(f))).not.toMatch(/@Cron\(/);
      }
    });
  });

  describe("report-billing-pause-blast-radius.mjs is read-only", () => {
    const script = read(path.join(API, "scripts", "report-billing-pause-blast-radius.mjs"));
    const sql = code(script);

    it("sets the session read-only before any other statement", () => {
      const ro = sql.indexOf("SET default_transaction_read_only = on");
      const firstQuery = sql.search(/\bq\(\s*`|client\.query\(\s*`(?!SET)/);
      expect(ro).toBeGreaterThan(-1);
      expect(firstQuery).toBeGreaterThan(ro);
      expect(sql).toMatch(/statement_timeout/);
    });

    it("contains no write or DDL statement", () => {
      const templates = (sql.match(/`[^`]*`/g) ?? []).join("\n");
      expect(templates).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i,
      );
    });

    it("states what it cannot see and names the log signals (it never calls Stripe)", () => {
      expect(script).toMatch(/discoveryPopulation/);
      expect(script).toMatch(/billing\.dunning\.would_unpause/);
      expect(script).toMatch(/billing\.dunning\.would_refuse/);
      expect(script).toMatch(/cannot call Stripe/);
      expect(script).not.toMatch(/require\(["']stripe/i);
    });

    it("never hardcodes a tenant or a connection string", () => {
      expect(script).not.toMatch(/postgres(ql)?:\/\//i);
      expect(script).toMatch(/resolveReportDbUrl\("report-billing-pause-blast-radius"\)/);
    });
  });

  describe("environment", () => {
    it("BILLING_PAUSE_MODE is documented in .env.example (name only)", () => {
      const env = read(path.join(API, ".env.example"));
      expect(env).toMatch(/^BILLING_PAUSE_MODE=$/m);
    });
  });
});
