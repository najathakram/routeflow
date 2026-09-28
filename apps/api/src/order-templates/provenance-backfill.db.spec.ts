/**
 * F-05 (#2093, owner ruling 2026-09-25) — the provenance backfill's `--exclude-tenant`, executed against REAL Postgres
 * end to end (dry run, then the id-pinned apply): a matched NULL-provenance template of a normal tenant is written; the
 * same shape of template in an EXCLUDED tenant never enters the plan and stays NULL through the apply. Collected only
 * by `jest.db.config.js`; every tenant is a throwaway `qa-*` slug and afterAll deletes exactly what it made.
 */
import { execFileSync } from "child_process";
import * as path from "path";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("provenance backfill --exclude-tenant — real Postgres", () => {
  const SCRIPT = path.resolve(__dirname, "../../scripts/backfill-order-template-provenance.mjs");
  const REPO_ROOT = path.resolve(__dirname, "../../../..");
  const RUN = randomUUID().slice(0, 8);
  let prisma: PrismaService;
  const tenants: { kept?: string; excluded?: string } = {};
  const templates: { kept?: string; excluded?: string } = {};

  const run = (args: string[]) =>
    execFileSync(process.execPath, [SCRIPT, "--local", ...args], {
      encoding: "utf8",
      env: { ...process.env },
      cwd: REPO_ROOT,
    });

  async function seed(label: "kept" | "excluded") {
    const slug = assertTestTenant(`qa-f05prov-${RUN}-${label}`, "provenance-backfill.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `F05 ${slug}` } });
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: {
        email: `${tenantId}-c@example.invalid`,
        username: `${tenantId}-c`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `Cust ${label}`, contactName: label, tenantId },
    });
    const tpl = await prisma.orderTemplate.create({
      data: { tenantId, customerId: customer.id, name: `T ${label}`, daysOfWeek: [1] },
    });
    // the interceptor's row for this creation: same tenant, the customer's own login, seconds from the template
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId: user.id,
        action: "POST /order-templates",
        entityType: "order-templates",
        createdAt: new Date(tpl.createdAt.getTime() + 2000),
      },
    });
    return { tenantId, templateId: tpl.id };
  }

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    const k = await seed("kept");
    const x = await seed("excluded");
    tenants.kept = k.tenantId;
    templates.kept = k.templateId;
    tenants.excluded = x.tenantId;
    templates.excluded = x.templateId;
  });

  afterAll(async () => {
    for (const tenantId of [tenants.kept, tenants.excluded].filter(Boolean) as string[]) {
      for (const del of [
        () => prisma.auditLog.deleteMany({ where: { tenantId } }),
        () => prisma.orderTemplate.deleteMany({ where: { tenantId } }),
        () => prisma.customerAddress.deleteMany({ where: { tenantId } }),
        () => prisma.customer.deleteMany({ where: { tenantId } }),
        () => prisma.user.deleteMany({ where: { tenantId } }),
        () => prisma.tenant.delete({ where: { id: tenantId } }),
      ])
        await del().catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  it("an excluded tenant's NULL-provenance template never enters the plan and stays NULL through the apply", async () => {
    const out = run(["--exclude-tenant", tenants.excluded!]);
    expect(out).toMatch(/EXCLUDED:\s+1 template\(s\) in 1 tenant\(s\)/);
    const file = /plan: (.+)\n/.exec(out)![1].trim();
    const hash = /plan hash: (\w+)/.exec(out)![1];
    const plan = JSON.parse(require("fs").readFileSync(file, "utf8"));
    expect(plan.excludedTenantIds).toEqual([tenants.excluded!.toLowerCase()]);
    const planned = plan.apply.map((a: { templateId: string }) => a.templateId);
    expect(planned).toContain(templates.kept);
    expect(planned).not.toContain(templates.excluded);

    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    run([
      "--apply",
      "--plan",
      file,
      "--confirm-plan",
      hash,
      "--guard-sha",
      sha,
      "--i-have-a-fresh-backup",
    ]);

    const kept = await prisma.orderTemplate.findUnique({ where: { id: templates.kept! } });
    const excluded = await prisma.orderTemplate.findUnique({ where: { id: templates.excluded! } });
    expect(kept?.createdByRole).toBe("CUSTOMER"); // the ordinary tenant is backfilled
    expect(excluded?.createdByRole).toBeNull(); // the excluded tenant is untouched
    expect(excluded?.createdByUserId).toBeNull();
  });

  it("an apply that is handed a plan containing an excluded tenant's row refuses and writes nothing", async () => {
    const fs = require("fs");
    const out = run([]); // a plan WITH the kept tenant's row, before anything is excluded
    const file = /plan: (.+)\n/.exec(out)![1].trim();
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    // hand-forge: pretend the excluded tenant was planned, then apply excluding it
    const forged = {
      ...saved,
      apply: [
        {
          ...(saved.apply[0] ?? {}),
          tenantId: tenants.excluded,
          templateId: templates.excluded,
          role: "CUSTOMER",
          userId: "u",
          auditKey: "k",
        },
      ],
    };
    delete forged.planHash;
    const crypto = require("crypto");
    const { review: _r, ...rest } = forged;
    const hash = crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    fs.writeFileSync(file, JSON.stringify({ ...rest, planHash: hash }));
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    let status = 0;
    try {
      run([
        "--apply",
        "--plan",
        file,
        "--confirm-plan",
        hash,
        "--guard-sha",
        sha,
        "--i-have-a-fresh-backup",
        "--exclude-tenant",
        tenants.excluded!,
      ]);
    } catch (e: any) {
      status = e.status;
    }
    expect(status).toBe(1);
    const excluded = await prisma.orderTemplate.findUnique({ where: { id: templates.excluded! } });
    expect(excluded?.createdByRole).toBeNull();
  });
});
