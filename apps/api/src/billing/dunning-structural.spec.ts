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

    /** The scanner, parameterised on a file list so the vacuity check can run it over PLANTED files. */
    function scanActiveWrites(
      fileList: string[],
      base: string,
      allowed = new Set<string>(),
    ): string[] {
      const offenders: string[] = [];
      for (const f of fileList) {
        if (allowed.has(f)) continue;
        const raw = read(f);
        const src = code(raw);
        const rel = path.relative(base, f);
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
      return offenders;
    }

    it("no Tenant write outside the helper can write ACTIVE: literal, TenantStatus.ACTIVE, an unreviewed expression, or raw SQL", () => {
      expect(scanActiveWrites(files, SRC, ALLOWED)).toEqual([]);
    });

    it("the pin is not vacuous: the SAME file walker and scanner flag each planted spelling and skip spec files", () => {
      const os = require("os") as typeof import("os");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "active-pin-"));
      try {
        const dir = path.join(root, "billing");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "planted.ts"),
          [
            'await tx.tenant.updateMany({ where: { id }, data: { status: "ACTIVE" } });',
            "await tx.tenant.update({ where: { id }, data: { status: TenantStatus.ACTIVE } });",
            "await tx.tenant.update({ where: { id }, data: { status: dto.status } });",
            'await tx.tenant.update({ where: { id }, data: { status: "ACTIVE" as const } });',
            "await tx.tenant.update({ where: { id }, data });",
            'await tx.$executeRaw`UPDATE "Tenant" SET "status" = \'ACTIVE\' WHERE id = ${id}`;',
            'await tx.tenant.update({ where: { id }, data: { status: "TRIAL" } });', // fine
          ].join("\n"),
        );
        fs.writeFileSync(
          path.join(dir, "planted.spec.ts"),
          'await tx.tenant.update({ where: {}, data: { status: "ACTIVE" } });',
        );
        const walked = walk(root);
        expect(walked.map((f) => path.basename(f))).toEqual(["planted.ts"]); // the walker skips specs
        const found = scanActiveWrites(walked, root);
        expect(found).toEqual(
          [
            'billing/planted.ts: status: "ACTIVE"',
            "billing/planted.ts: status: TenantStatus.ACTIVE",
            "billing/planted.ts: status: dto.status",
            'billing/planted.ts: status: "ACTIVE" as const',
            "billing/planted.ts: Tenant write with a non-literal data object",
            "billing/planted.ts: raw SQL sets Tenant.status = ACTIVE",
          ].map((x) => x.replace(/\//g, path.sep === "\\" ? "\\" : "/")),
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      // and the real tree is not empty-scanned
      expect(walk(path.join(SRC, "billing")).some((f) => f.endsWith("billing.service.ts"))).toBe(
        true,
      );
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

  describe("deliberately UNGUARDED plan/price paths (explicit exclusion list)", () => {
    // These change a plan or price but are SYSTEM or PRICE actions on ACTIVE tenants, not a tenant (or admin) buying its
    // way out of an overdue invoice. Adding the overdue guard to one of them must be a deliberate edit of THIS list.
    const UNGUARDED = [
      {
        file: "billing/billing-cron.service.ts",
        method: "async applyScheduledDowngrades(",
        reason: "cron: applies a downgrade the tenant scheduled earlier, on ACTIVE tenants only",
      },
      {
        file: "billing/scheduled-price-change.ts",
        method: "async applyDue(",
        reason: "cron: pushes an already-scheduled lower price to Stripe before the renewal",
      },
      {
        file: "platform-admin/platform-admin.service.ts",
        method: "async updateTenantPriceOverride(",
        reason:
          "a negotiated PRICE for the next cycle, not a plan change; owners need it to settle disputes",
      },
    ];

    it.each(UNGUARDED.map((u) => [u.file, u.method, u.reason]))(
      "%s %s stays unguarded: %s",
      (file, method) => {
        const src = code(read(path.join(SRC, file)));
        const i = src.indexOf(method);
        expect(i).toBeGreaterThan(-1); // a rename must re-point this list, not silently drop out of it
        const body = src.slice(i, i + 2500);
        expect(body).not.toMatch(/assertNotOverdue|assertTenantNotPaymentOverdue/);
      },
    );
  });

  describe("one definition of OWED, one shape of notice key", () => {
    const dunningFiles = () =>
      walk(path.join(SRC, "billing")).filter((f) =>
        /[\\/](dunning|payment-overdue)[^\\/]*\.ts$/.test(f),
      );

    it("only dunning-core.ts decides 'status is open': no other dunning file (or the 409 guard) compares an invoice status to open", () => {
      const offenders = dunningFiles()
        .filter((f) => !f.endsWith("dunning-core.ts"))
        .filter((f) => /\bstatus\s*[!=]==?\s*["']open["']/.test(code(read(f))))
        .map((f) => path.relative(SRC, f));
      expect(offenders).toEqual([]);
    });

    it("the 409 guard calls isOwed (not its own copy of the rule)", () => {
      const src = code(read(path.join(SRC, "billing", "payment-overdue.ts")));
      expect(src).toMatch(/import \{[^}]*\bisOwed\b[^}]*\} from "\.\/dunning-core"/);
      expect(src).toMatch(/\bisOwed\(facts\)/);
    });

    it("every dunning notice key is an episode key: no call passes a bare invoice id as the key", () => {
      for (const f of ["dunning-milestones.ts", "dunning.service.ts"]) {
        const src = code(read(path.join(SRC, "billing", f)));
        expect(src).not.toMatch(/notifyDunning\(\s*[^,]+,\s*[^,]+,\s*invoiceId\s*,/);
        expect(src).not.toMatch(/recordDunningMilestone\(\s*[^,]+,\s*[^,]+,\s*invoiceId\s*\)/);
        expect(src).toMatch(/episodeKey\(/);
      }
    });

    it("ONE owed rule: only dunning-core defines it (age OR attempted); no other file has an age filter or a second predicate", () => {
      const files = dunningFiles().map((f) => [path.basename(f), code(read(f))] as const);
      const core = files.find(([n]) => n === "dunning-core.ts")![1];
      expect(core).toMatch(/export function isOwedInvoice\(/);
      expect(core).toMatch(/export function isOwed\(/);
      const offenders = (re: RegExp) =>
        files.filter(([n, c]) => n !== "dunning-core.ts" && re.test(c)).map(([n]) => n);
      expect(offenders(/DISCOVERY_MIN_AGE_HOURS/)).toEqual([]);
      expect(offenders(/function\s+isOwed\w*\s*\(/)).toEqual([]);
      expect(files.map(([, c]) => c).join("\n")).not.toMatch(/isAgedOwedInvoice/);
      // the list-row predicate is what resolve (resume + move) and discovery (stamp + phase 2 move) call
      for (const f of ["dunning-resolve.ts", "dunning-discovery.ts"]) {
        const src = files.find(([n]) => n === f)![1];
        expect(src).toMatch(/\bisOwedInvoice\(/);
      }
    });

    it("the pause CAS is pinned to the episode (pastDueSince), so a same-invoice re-stamp cannot pause under a newer episode", () => {
      const src = code(read(path.join(SRC, "billing", "dunning-pause.ts")));
      expect(src).toMatch(/pastDueInvoiceId:\s*invoiceId,\s*pastDueSince/);
    });

    it("a clock is never given `now` as a stand-in start: no `pastDueSince ?? now`", () => {
      const all = dunningFiles()
        .map((f) => code(read(f)))
        .join("\n");
      expect(all).not.toMatch(/pastDueSince\s*\?\?\s*now/);
    });

    it("PAUSED_STILL_OWED is sent by dunning-milestones only, and only through the episode key", () => {
      const users = dunningFiles()
        .filter((f) => /PAUSED_STILL_OWED/.test(code(read(f))))
        .map((f) => path.basename(f))
        .filter((n) => n !== "dunning-config.ts");
      expect(users).toEqual(["dunning-milestones.ts"]);
    });

    it("dunning notice money goes through fromCents (SA-733 D9), never a hand-rolled cents / 100", () => {
      const src = code(read(path.join(SRC, "billing", "billing-notification.templates.ts")));
      expect(src).toMatch(/import \{[^}]*\bfromCents\b[^}]*\} from "@routeflow\/pricing"/);
      const fn = src.slice(
        src.indexOf("function formatDunningAmount"),
        src.indexOf("export function dunningTemplate"),
      );
      expect(fn).toContain("fromCents(");
      expect(fn).not.toMatch(/\/\s*100\b/);
    });

    it("A1: ONE switch (dunningEmailsFor) decides which dunning email path sends; no sender bypasses it", () => {
      const sendsDunning = walk(path.join(SRC, "billing")).filter((f) =>
        /\bnotifyDunning\(|\bsendPaymentFailedEmail\(/.test(code(read(f))),
      );
      const names = sendsDunning.map((f) => path.basename(f)).sort();
      expect(names).toEqual(
        [
          "billing-notification.service.ts",
          "billing.service.ts",
          "dunning-milestones.ts",
          "dunning.service.ts",
        ].sort(),
      );
      for (const f of sendsDunning) {
        if (path.basename(f) === "billing-notification.service.ts") continue; // the sender itself (callers gate)
        expect(code(read(f))).toMatch(/\bdunningEmailsFor\(/);
      }
    });

    it("A1: the failed-payment email (master #2440) is sent only on the legacy path", () => {
      const src = code(read(path.join(SRC, "billing", "billing.service.ts")));
      expect(src).toMatch(
        /dunningEmailsFor\([^)]*\)\s*===\s*"legacy_failed_payment"[\s\S]{0,200}sendPaymentFailedEmail\(/,
      );
    });

    it("the d0-sentAt lookup is gone (a stamp is always the stamp time)", () => {
      const all = dunningFiles()
        .map((f) => code(read(f)))
        .join("\n");
      expect(all).not.toMatch(/clockStartFor/);
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

    it("reads pastDueSince as UTC (TIMESTAMP(3) has no zone) and builds the episode key through the shared helper", () => {
      expect(script).toMatch(/from "\.\/lib\/pause-report-keys\.mjs"/);
      expect(script).toMatch(/new Client\(\{[^}]*\btypes:\s*utcTimestampTypes\(pgTypes\)/);
      // the remindersSent query must read the still-owed notice too, or those tenants show "none"
      expect(script).toMatch(/milestone IN \([^)]*'DUNNING_PAUSED_STILL_OWED'[^)]*\)/);
      // the raw `new Date(since).toISOString()` key shifted on a non-UTC machine
      expect(sql).not.toMatch(/\$\{new Date\(since\)\.toISOString\(\)\}/);
      expect(sql).toMatch(/episodeKey\(/);
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
