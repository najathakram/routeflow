/**
 * DB lane — the portal-invite census (`report-portal-invite-census.mjs`) and the rotation
 * (`rotate-portal-invites.mjs`) executed against a REAL Postgres, so the paths that touch data are proven.
 *
 * The sibling `portal-invite-census-script.spec.ts` covers the pure parts and the SQL's shape with no database. What
 * only a database can show: the census counts exactly the live invites whose code an audit row holds (not an expired
 * one, not one only the route template names), the rotation's dry run writes nothing, its apply clears exactly the
 * planned links and nothing else, and every refusal leaves every row as it was.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); run through `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY. Every row carries a random suffix inside throwaway tenants: `e2e-invite-*` (an approved test tenant) and
 * `acme-*` (NOT approved, to prove the live-tenant gate). The CLIs scan the WHOLE database, so assertions are made on
 * deltas that only this file's rows can produce, and teardown deletes exactly those rows in FK order.
 */
import { execFileSync, spawnSync } from "child_process";
import { createHash, randomBytes, randomUUID } from "crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

const API_DIR = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_DIR, "../..");
const CENSUS = path.resolve(API_DIR, "scripts/report-portal-invite-census.mjs");
const ROTATE = path.resolve(API_DIR, "scripts/rotate-portal-invites.mjs");

const SUFFIX = randomUUID().slice(0, 8);
const TEST_TENANT = { id: randomUUID(), slug: `e2e-invite-${SUFFIX}` };
const LIVE_TENANT = { id: randomUUID(), slug: `acme-${SUFFIX}` };
const OTHER_TENANT = { id: randomUUID(), slug: `e2e-invite-other-${SUFFIX}` };
const tok = () => randomBytes(32).toString("hex");
const HOUR = 3_600_000;

type LinkSeed = {
  id: string;
  tenantId: string;
  token: string | null;
  expires: Date | null;
  status: string;
};
const links: Record<string, LinkSeed> = {};
const customerIds: string[] = [];
const userIds: string[] = [];

const GUARD_SHA = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

function run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync("node", [script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout };
}

describeDb("portal invite census and rotation (real Postgres)", () => {
  let db: Client;
  const url = requireLocalDatabaseUrl();

  async function seedTenant(t: { id: string; slug: string }) {
    await db.query(
      `INSERT INTO "Tenant" ("id","slug","name","createdAt","updatedAt") VALUES ($1,$2,$3, now(), now())`,
      [t.id, t.slug, `Invite spec ${SUFFIX}`],
    );
  }

  async function seedLink(key: string, tenantId: string, over: Partial<LinkSeed> = {}) {
    const userId = randomUUID();
    const customerId = randomUUID();
    userIds.push(userId);
    customerIds.push(customerId);
    await db.query(
      `INSERT INTO "User" ("id","email","username","role","updatedAt")
       VALUES ($1,$2,$3,'CUSTOMER'::"UserRole", now())`,
      [userId, `${key}-${SUFFIX}@example.test`, `${key}-${SUFFIX}`],
    );
    await db.query(
      `INSERT INTO "Customer" ("id","userId","tenantId","businessName","contactName","updatedAt")
       VALUES ($1,$2,$3,$4,$5, now())`,
      [customerId, userId, tenantId, `Acme ${key}`, "Pat Example"],
    );
    const seed: LinkSeed = {
      id: randomUUID(),
      tenantId,
      token: tok(),
      expires: new Date(Date.now() + 24 * HOUR),
      status: "INVITED",
      ...over,
    };
    await db.query(
      `INSERT INTO "CustomerLink" ("id","customerId","tenantId","status","inviteToken","inviteExpiresAt","updatedAt")
       VALUES ($1,$2,$3,$4::"CustomerLinkStatus",$5,$6, now())`,
      [seed.id, customerId, tenantId, seed.status, seed.token, seed.expires],
    );
    links[key] = seed;
    return seed;
  }

  const audit = (tenantId: string, action: string) =>
    db.query(
      `INSERT INTO "AuditLog" ("id","tenantId","action","entityType") VALUES ($1,$2,$3,'buyer')`,
      [randomUUID(), tenantId, action],
    );

  const linkRow = async (key: string) =>
    (
      await db.query(
        `SELECT "inviteToken","inviteExpiresAt",status::text AS status FROM "CustomerLink" WHERE id = $1`,
        [links[key].id],
      )
    ).rows[0];

  const censusJson = () => JSON.parse(run(CENSUS, ["--json"], { DATABASE_URL: url }).stdout);
  let base: ReturnType<typeof censusJson>;
  let appliedPlan: { file: string; hash: string };

  async function dryRun(tenants: string[]) {
    const r = run(ROTATE, [...tenants.flatMap((t) => ["--tenant", t]), "--local"], {
      DATABASE_URL: url,
    });
    const file = /^plan: (.+)$/m.exec(r.out)?.[1]?.trim();
    const hash = /^plan hash: (\w+)$/m.exec(r.out)?.[1];
    return { ...r, file, hash };
  }

  const applyArgs = (file: string, hash: string, tenants: string[], extra: string[] = []) => [
    "--apply",
    "--plan",
    file,
    "--confirm-plan",
    hash,
    "--guard-sha",
    GUARD_SHA,
    "--backup-taken",
    ...tenants.flatMap((t) => ["--tenant", t]),
    "--local",
    ...extra,
  ];

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    base = censusJson();
    for (const t of [TEST_TENANT, LIVE_TENANT, OTHER_TENANT]) await seedTenant(t);
    // Test tenant: three live invites and one expired.
    await seedLink("recorded1", TEST_TENANT.id);
    await seedLink("recorded2", TEST_TENANT.id);
    await seedLink("unrecorded", TEST_TENANT.id);
    await seedLink("expired", TEST_TENANT.id, { expires: new Date(Date.now() - HOUR) });
    await seedLink("templated", TEST_TENANT.id);
    await audit(TEST_TENANT.id, `POST /buyer/invites/${links.recorded1.token}/accept`);
    await audit(TEST_TENANT.id, `POST /api/v1/buyer/invites/${links.recorded1.token}/accept?x=1`);
    await audit(TEST_TENANT.id, `POST /buyer/invites/${links.recorded2.token}/accept`);
    await audit(TEST_TENANT.id, `POST /buyer/invites/${links.expired.token}/accept`);
    await audit(TEST_TENANT.id, "POST /buyer/invites/:token/accept"); // the template: holds no code
    // A tenant the owner does not name, and a live (non-approved) tenant.
    await seedLink("other", OTHER_TENANT.id);
    await audit(OTHER_TENANT.id, `POST /buyer/invites/${links.other.token}/accept`);
    await seedLink("live1", LIVE_TENANT.id);
    await audit(LIVE_TENANT.id, `POST /buyer/invites/${links.live1.token}/accept`);
  });

  afterAll(async () => {
    const tenants = [TEST_TENANT.id, LIVE_TENANT.id, OTHER_TENANT.id];
    await db.query(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [tenants]);
    await db.query(`DELETE FROM "CustomerLink" WHERE "tenantId" = ANY($1::text[])`, [tenants]);
    await db.query(`DELETE FROM "Customer" WHERE id = ANY($1::text[])`, [customerIds]);
    await db.query(`DELETE FROM "User" WHERE id = ANY($1::text[])`, [userIds]);
    await db.query(`DELETE FROM "Tenant" WHERE id = ANY($1::text[])`, [tenants]);
    await db.end();
  });

  it("C1: the census counts exactly the live invites an audit row holds, and writes nothing", async () => {
    const before = (await db.query(`SELECT count(*)::int AS n FROM "AuditLog"`)).rows[0].n;
    const report = censusJson();
    // recorded1 (two audit rows), recorded2, other, live1; NOT unrecorded, expired or templated.
    expect(report.recordedInvites - base.recordedInvites).toBe(4);
    expect(report.auditRowsHoldingALiveCode - base.auditRowsHoldingALiveCode).toBe(5);
    expect(report.tenantsAffected - base.tenantsAffected).toBe(3);
    expect(report.liveInvites - base.liveInvites).toBe(6); // the expired one is not live
    expect((report.byStatus.INVITED ?? 0) - (base.byStatus.INVITED ?? 0)).toBe(4);
    expect((await db.query(`SELECT count(*)::int AS n FROM "AuditLog"`)).rows[0].n).toBe(before);
  });

  it("C2: the census output never carries a code, an id or a name", async () => {
    const r = run(CENSUS, ["--json"], { DATABASE_URL: url });
    for (const l of Object.values(links)) {
      expect(r.out).not.toContain(l.token as string);
      expect(r.out).not.toContain(l.id);
    }
    expect(r.out).not.toContain(TEST_TENANT.slug);
    expect(r.out).not.toContain(TEST_TENANT.id);
  });

  it("C3: --by-tenant names the tenants, still with no code", async () => {
    const r = run(CENSUS, ["--by-tenant"], { DATABASE_URL: url });
    expect(r.out).toContain(TEST_TENANT.slug);
    for (const l of Object.values(links)) expect(r.out).not.toContain(l.token as string);
  });

  it("C4: running the census in every mode changes no row anywhere it reads (row versions and counts, real Postgres)", async () => {
    // xmin moves on any insert, update or row lock, so an unchanged fingerprint is a zero-write proof.
    const fingerprint = async () =>
      (
        await db.query(
          `SELECT
             (SELECT md5(coalesce(string_agg(l.id || ':' || l.xmin::text, ',' ORDER BY l.id), '')) FROM "CustomerLink" l) AS links,
             (SELECT count(*)::int FROM "AuditLog") AS audit_rows,
             (SELECT md5(coalesce(string_agg(a.id || ':' || a.xmin::text, ',' ORDER BY a.id), '')) FROM "AuditLog" a) AS audit,
             (SELECT md5(coalesce(string_agg(t.id || ':' || t.xmin::text, ',' ORDER BY t.id), '')) FROM "Tenant" t) AS tenants`,
        )
      ).rows[0];
    const before = await fingerprint();
    for (const args of [[], ["--json"], ["--by-tenant"], ["--json", "--by-tenant"]]) {
      expect(run(CENSUS, args, { DATABASE_URL: url }).code).toBe(0);
    }
    expect(await fingerprint()).toEqual(before);
  });

  it("R1: the rotation refuses to run with no tenant named", async () => {
    const r = run(ROTATE, ["--local"], { DATABASE_URL: url });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/name at least one tenant/);
  });

  it("R2: the dry run plans only the named tenant, holds back the rest, stores no code, and writes nothing", async () => {
    const r = await dryRun([TEST_TENANT.id]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 live invite\(s\) to retire in 1 named tenant/);
    expect(Number(/held back: (\d+) recorded/.exec(r.out)?.[1])).toBeGreaterThanOrEqual(2);
    const plan = JSON.parse(readFileSync(r.file as string, "utf8"));
    expect(plan.rotate.map((x: { linkId: string }) => x.linkId).sort()).toEqual(
      [links.recorded1.id, links.recorded2.id].sort(),
    );
    const text = JSON.stringify(plan) + r.out;
    for (const l of Object.values(links)) expect(text).not.toContain(l.token as string);
    expect((await linkRow("recorded1")).inviteToken).toBe(links.recorded1.token);
  });

  it("R3: a tampered plan hash is refused and nothing is written", async () => {
    const r = await dryRun([TEST_TENANT.id]);
    const tampered = JSON.parse(readFileSync(r.file as string, "utf8"));
    tampered.rotate.push({
      linkId: links.other.id,
      tenantId: OTHER_TENANT.id,
      status: "INVITED",
      tokenSha256: "00",
      auditRows: 1,
    });
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "rot-")), "plan.json");
    writeFileSync(f, JSON.stringify(tampered));
    const a = run(ROTATE, applyArgs(f, r.hash as string, [TEST_TENANT.id]), { DATABASE_URL: url });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/does not match the plan file/);
    expect((await linkRow("other")).inviteToken).toBe(links.other.token);
    expect((await linkRow("recorded1")).inviteToken).toBe(links.recorded1.token);
  });

  it("R4: a plan whose tenant is not named on the apply command line is refused", async () => {
    const r = await dryRun([TEST_TENANT.id]);
    const a = run(ROTATE, applyArgs(r.file as string, r.hash as string, [OTHER_TENANT.id]), {
      DATABASE_URL: url,
    });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/not named with --tenant/);
    expect((await linkRow("recorded1")).inviteToken).toBe(links.recorded1.token);
  });

  it("R5: apply without the backup attestation is refused", async () => {
    const r = await dryRun([TEST_TENANT.id]);
    const args = applyArgs(r.file as string, r.hash as string, [TEST_TENANT.id]).filter(
      (x) => x !== "--backup-taken",
    );
    const a = run(ROTATE, args, { DATABASE_URL: url });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/--apply needs/);
    expect((await linkRow("recorded1")).inviteToken).toBe(links.recorded1.token);
  });

  it("R6: if one planned link changed since the dry run, NOTHING is written (one transaction)", async () => {
    const r = await dryRun([TEST_TENANT.id]);
    const changed = tok();
    await db.query(`UPDATE "CustomerLink" SET "inviteToken" = $1 WHERE id = $2`, [
      changed,
      links.recorded2.id,
    ]);
    const a = run(ROTATE, applyArgs(r.file as string, r.hash as string, [TEST_TENANT.id]), {
      DATABASE_URL: url,
    });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/has changed since the dry run/);
    expect((await linkRow("recorded1")).inviteToken).toBe(links.recorded1.token); // the unchanged one stayed too
    // put it back for the cases below
    await db.query(`UPDATE "CustomerLink" SET "inviteToken" = $1 WHERE id = $2`, [
      links.recorded2.token,
      links.recorded2.id,
    ]);
  });

  it("R7: a LIVE (non-approved) tenant needs the override and the typed phrase; without them nothing is written", async () => {
    const r = await dryRun([LIVE_TENANT.id]);
    expect(r.out).toMatch(/1 live invite\(s\) to retire in 1 named tenant/);
    const a = run(ROTATE, applyArgs(r.file as string, r.hash as string, [LIVE_TENANT.id]), {
      DATABASE_URL: url,
    });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/LIVE tenant/);
    const wrong = run(
      ROTATE,
      applyArgs(
        r.file as string,
        r.hash as string,
        [LIVE_TENANT.id],
        ["--live-tenant-override", "--confirm", "ROTATE 9 INVITES"],
      ),
      { DATABASE_URL: url },
    );
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/LIVE tenant/);
    expect((await linkRow("live1")).inviteToken).toBe(links.live1.token);
  });

  it("R8: a PROTECTED tenant cannot be rotated without its own override at a real terminal", async () => {
    const r = await dryRun([LIVE_TENANT.id]);
    const a = run(
      ROTATE,
      applyArgs(
        r.file as string,
        r.hash as string,
        [LIVE_TENANT.id],
        [
          "--allow-protected",
          LIVE_TENANT.id,
          "--live-tenant-override",
          "--confirm",
          "ROTATE 1 INVITES",
        ],
      ),
      { DATABASE_URL: url, PROTECTED_TENANT_SLUGS: LIVE_TENANT.slug },
    );
    expect(a.code).toBe(1); // no TTY: the typed phrase cannot be given
    expect(a.out).toMatch(/is protected: override refused/);
    expect((await linkRow("live1")).inviteToken).toBe(links.live1.token);
  });

  it("R11: the dry run, the refused apply and the plan output carry ids and counts only (no code, no code hash, no email, no name)", async () => {
    const r = await dryRun([TEST_TENANT.id]);
    const refused = run(
      ROTATE,
      applyArgs(r.file as string, r.hash as string, [TEST_TENANT.id]).filter(
        (x) => x !== "--backup-taken",
      ),
      { DATABASE_URL: url },
    );
    const printed = r.out + refused.out;
    expect(printed.length).toBeGreaterThan(0);
    for (const l of Object.values(links)) {
      expect(printed).not.toContain(l.token as string);
      expect(printed).not.toContain(
        createHash("sha256")
          .update(l.token as string)
          .digest("hex"),
      );
    }
    expect(printed).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/); // no email (the redacted URL's ***@host is not one)
    expect(printed).not.toMatch(/Acme|Pat Example/); // no customer name
  });

  it("R12: two tenants in one run are refused before any connection, so one yes covers one tenant", async () => {
    const two = [TEST_TENANT.id, OTHER_TENANT.id];
    const plan = await dryRun([TEST_TENANT.id]);
    const dry = run(ROTATE, [...two.flatMap((t) => ["--tenant", t]), "--local"], {
      DATABASE_URL: url,
    });
    expect(dry.code).toBe(1);
    expect(dry.out).toMatch(/one tenant per run/);
    const apply = run(ROTATE, applyArgs(plan.file as string, plan.hash as string, two), {
      DATABASE_URL: url,
    });
    expect(apply.code).toBe(1);
    expect(apply.out).toMatch(/one tenant per run/);
  });

  it("R13: a hand-made plan that names two tenants is refused even when its hash is right", async () => {
    const r = await dryRun([TEST_TENANT.id]);
    const plan = JSON.parse(readFileSync(r.file as string, "utf8"));
    delete plan.planHash;
    plan.tenantIds = [TEST_TENANT.id, OTHER_TENANT.id];
    const hash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const file = (r.file as string).replace(/\.json$/, "-two.json");
    writeFileSync(file, JSON.stringify({ ...plan, planHash: hash }, null, 2));
    const a = run(ROTATE, applyArgs(file, hash, [TEST_TENANT.id]), { DATABASE_URL: url });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/one tenant per run/);
    expect((await linkRow("recorded1")).inviteToken).toBe(links.recorded1.token);
  });

  /** A hand-made plan (hash recomputed) holding exactly these rows: the write's own predicates are all that is left to stop it. */
  async function handPlan(rows: object[]) {
    const r = await dryRun([TEST_TENANT.id]);
    const plan = JSON.parse(readFileSync(r.file as string, "utf8"));
    delete plan.planHash;
    plan.rotate = rows;
    const hash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const file = (r.file as string).replace(/.json$/, `-hand-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ ...plan, planHash: hash }, null, 2));
    return { file, hash };
  }
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");

  it("R14: the write is bound to the tenant: a plan row naming the test tenant for another tenant's link writes nothing", async () => {
    const p = await handPlan([
      {
        linkId: links.other.id,
        tenantId: TEST_TENANT.id,
        status: "INVITED",
        tokenSha256: sha(links.other.token as string),
        auditRows: 1,
      },
    ]);
    const a = run(ROTATE, applyArgs(p.file, p.hash, [TEST_TENANT.id]), { DATABASE_URL: url });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/has changed since the dry run/);
    expect((await linkRow("other")).inviteToken).toBe(links.other.token);
  });

  it("R15: an invite that has expired since the dry run is not rotated: the write needs a live link", async () => {
    const p = await handPlan([
      {
        linkId: links.expired.id,
        tenantId: TEST_TENANT.id,
        status: "INVITED",
        tokenSha256: sha(links.expired.token as string),
        auditRows: 1,
      },
    ]);
    const a = run(ROTATE, applyArgs(p.file, p.hash, [TEST_TENANT.id]), { DATABASE_URL: url });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/has changed since the dry run/);
    expect((await linkRow("expired")).inviteToken).toBe(links.expired.token);
  });

  it("R9: apply on the test tenant clears exactly the planned links and nothing else", async () => {
    const r = await dryRun([TEST_TENANT.id]);
    const a = run(ROTATE, applyArgs(r.file as string, r.hash as string, [TEST_TENANT.id]), {
      DATABASE_URL: url,
    });
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/committed — 2 invite\(s\) retired/);
    for (const k of ["recorded1", "recorded2"]) {
      const row = await linkRow(k);
      expect(row.inviteToken).toBeNull();
      expect(row.inviteExpiresAt).toBeNull();
      expect(row.status).toBe("INVITED"); // the invite row stays; the seller sends it again
    }
    expect((await linkRow("unrecorded")).inviteToken).toBe(links.unrecorded.token);
    expect((await linkRow("expired")).inviteToken).toBe(links.expired.token);
    expect((await linkRow("other")).inviteToken).toBe(links.other.token);
    expect((await linkRow("live1")).inviteToken).toBe(links.live1.token);
    // no historical audit row was rewritten
    const rows = (
      await db.query(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1`, [
        TEST_TENANT.id,
      ])
    ).rows[0].n;
    expect(rows).toBe(5);
    // and the census no longer counts them
    expect(censusJson().recordedInvites - base.recordedInvites).toBe(2); // other + live1
    appliedPlan = { file: r.file as string, hash: r.hash as string };
  });

  it("R10: replaying the applied plan is refused (the links no longer hold that code) and writes nothing", async () => {
    const a = run(ROTATE, applyArgs(appliedPlan.file, appliedPlan.hash, [TEST_TENANT.id]), {
      DATABASE_URL: url,
    });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/has changed since the dry run/);
    expect((await linkRow("unrecorded")).inviteToken).toBe(links.unrecorded.token);
  });
});
