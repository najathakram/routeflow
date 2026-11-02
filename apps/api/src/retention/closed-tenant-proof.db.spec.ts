/**
 * SA-1083 RT-3, RT-25: `proveClosedTenant` on real rows. Each case changes one thing on a tenant that would otherwise
 * prove, so a refusal can only come from that one thing. The whole matrix is in closed-tenant-proof.spec.ts.
 *
 * SAFETY: throwaway `qa-proof-<run>-*` tenants approved by `assertTestTenant`; `afterAll` deletes exactly those.
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { stripeGateBeforeTermination } from "../platform-admin/stripe-termination-gate";
import { ClosedTenantRefused, proveClosedTenant } from "./closed-tenant-proof";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const NOW = new Date("2026-11-02T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const NO_SUB = { stripeSubId: null };

describeDb("SA-1083: proveClosedTenant, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  const run = randomUUID().slice(0, 8);
  const ids: string[] = [];
  let seq = 0;

  /** Closed 40 days, notice at 35, approved yesterday. Writes the date past the trigger, on this one session only. */
  async function provableTenant(data: Record<string, unknown> = {}) {
    seq += 1;
    const slug = assertTestTenant(`qa-proof-${run}-${seq}`, "closed-tenant-proof.db.spec.ts");
    const { id } = await raw.tenant.create({
      data: { slug, name: `Acme ${slug}`, status: "CANCELLED" },
    });
    ids.push(id);
    await setClosedAt(id, daysAgo(40));
    await raw.tenant.update({
      where: { id },
      data: { purgeNoticeAt: daysAgo(35), purgeApprovedAt: daysAgo(1), ...data },
    });
    return id;
  }
  async function setClosedAt(id: string, at: Date) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`UPDATE "Tenant" SET "closedAt" = $2::timestamptz WHERE id = $1`, [
        id,
        at.toISOString(),
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }
  const prove = (id: string, stripeRead: { stripeSubId: string | null } = NO_SUB) =>
    prisma.$transaction((tx) => proveClosedTenant(tx, id, NOW, stripeRead));
  const refusal = (id: string, stripeRead?: { stripeSubId: string | null }) =>
    prove(id, stripeRead).then(
      () => "PROVEN",
      (e: unknown) => {
        if (e instanceof ClosedTenantRefused) return e.reason;
        throw e;
      },
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
  }, 60_000);

  afterAll(async () => {
    try {
      await raw.tenantSubscription.deleteMany({ where: { tenantId: { in: ids } } });
      await raw.tenant.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 60_000);

  it("a tenant that meets every condition gets a proof for that tenant", async () => {
    const id = await provableTenant();
    await expect(prove(id)).resolves.toMatchObject({
      tenantId: id,
      closedAt: daysAgo(40),
      provenAt: NOW,
    });
  });

  it.each([
    ["active", { status: "ACTIVE" }, "NOT_CLOSED"],
    ["expired trial", { status: "READ_ONLY", readOnlyReason: "trial_expired" }, "NOT_CLOSED"],
    ["hold", { retentionHoldAt: daysAgo(1), retentionHoldReason: "dispute" }, "ON_HOLD"],
    ["no approval", { purgeApprovedAt: null }, "NO_APPROVAL"],
    [
      "approval older than the closing",
      { purgeApprovedAt: daysAgo(41) },
      "APPROVAL_BEFORE_CLOSING",
    ],
    ["demo", { class: "DEMO" }, "TENANT_CLASS_REFUSED"],
    ["internal", { class: "INTERNAL" }, "TENANT_CLASS_REFUSED"],
    ["RT-25 no notice", { purgeNoticeAt: null }, "NO_NOTICE"],
    ["RT-25 notice 29 days old", { purgeNoticeAt: daysAgo(29) }, "NOTICE_TOO_RECENT"],
    ["RT-25 open copy request", { copyRequestOpenAt: daysAgo(1) }, "COPY_REQUEST_OPEN"],
  ])("RT-3 %s is refused", async (_name, change, reason) => {
    expect(await refusal(await provableTenant(change))).toBe(reason);
  });

  it("RT-3 day 29 is refused", async () => {
    const id = await provableTenant({ purgeNoticeAt: daysAgo(29) });
    await setClosedAt(id, daysAgo(29));
    expect(await refusal(id)).toBe("CLOSED_TOO_RECENTLY");
  });

  it("a tenant that isn't there is refused", async () => {
    expect(await refusal(randomUUID())).toBe("TENANT_NOT_FOUND");
  });

  describe("RT-3 live Stripe subscription", () => {
    const gate = (tenantId: string, status: string) =>
      stripeGateBeforeTermination(
        {
          prisma,
          stripe: {
            isConfigured: true,
            getSubscription: async () => ({ status, customer: "cus_acme", metadata: { tenantId } }),
          },
          logger: new Logger("spec"),
          record: async () => undefined,
        } as never,
        tenantId,
        null,
      );
    const withSub = async () => {
      const id = await provableTenant();
      await raw.tenantSubscription.create({
        data: { tenantId: id, stripeSubId: `sub_${run}_${seq}`, stripeCustomerId: "cus_acme" },
      });
      return id;
    };

    it("a live subscription stops at the gate, so no proof can be asked for", async () => {
      const id = await withSub();
      await expect(gate(id, "active")).rejects.toMatchObject({
        response: { code: "TENANT_CANCEL_SUBSCRIPTION_FIRST" },
      });
    });

    it("an ended subscription proves with the id the gate read", async () => {
      const id = await withSub();
      expect(await refusal(id, await gate(id, "canceled"))).toBe("PROVEN");
    });

    it("a subscription that appeared or changed after the read is refused under the lock", async () => {
      const id = await withSub();
      expect(await refusal(id, NO_SUB)).toBe("STRIPE_SUBSCRIPTION_CHANGED");
      expect(await refusal(id, { stripeSubId: "sub_other" })).toBe("STRIPE_SUBSCRIPTION_CHANGED");
    });
  });

  it("the proof holds the tenant row, so a reopening waits for the batch", async () => {
    const id = await provableTenant();
    const other = await pool.connect();
    try {
      await prisma.$transaction(async (tx) => {
        await proveClosedTenant(tx, id, NOW, NO_SUB);
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout = '200ms'");
        await expect(
          other.query(`UPDATE "Tenant" SET status = 'ACTIVE' WHERE id = $1`, [id]),
        ).rejects.toThrow(/lock timeout/);
        await other.query("ROLLBACK");
      });
    } finally {
      other.release();
    }
    expect((await raw.tenant.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
  });

  it("reopened between batches: the next proof refuses, and closing again needs a new notice and approval", async () => {
    const id = await provableTenant();
    await prove(id);
    await raw.tenant.update({ where: { id }, data: { status: "ACTIVE" } });
    expect(await refusal(id)).toBe("NOT_CLOSED");
    const reopened = await raw.tenant.findUniqueOrThrow({ where: { id } });
    expect(reopened.closedAt).toBeNull();
    expect(reopened.purgeApprovedAt).toBeNull();

    await raw.tenant.update({ where: { id }, data: { status: "CANCELLED" } });
    await setClosedAt(id, daysAgo(31));
    expect(await refusal(id)).toBe("NOTICE_BEFORE_CLOSING");
    await raw.tenant.update({ where: { id }, data: { purgeNoticeAt: daysAgo(30) } });
    expect(await refusal(id)).toBe("NO_APPROVAL");
  });
});
