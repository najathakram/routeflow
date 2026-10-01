/**
 * #2113 (SA-528) — DB lane. The F-10a admin alert is DURABLE: a transition stamps
 * `MailboxConnection.alertPendingAt` in its own transaction, and a claim/clear pair of
 * compare-and-sets settles it exactly once, whether the in-process listener or the
 * `mailbox-alert.sweepPending` job gets there first. Only real Postgres proves the CAS semantics
 * (row lock + re-evaluated predicate); mailbox-alert.service.spec.ts pins the queries on a stub.
 *
 * REAL: Postgres, MailboxSendService's transition, MailboxAlertOutbox and MailboxAlertService
 * (claim, stale check, admin lookup, clear, sweep). STUBBED: the provider HTTP APIs (axios) and
 * the two delivery edges, which are counted, never sent. The lease clock is injected
 * (`alerts.now`), never waited on.
 *
 * SAFETY: throwaway `qa-2113-<run>-<n>` tenants approved by `assertTestTenant`; `afterAll`
 * deletes exactly the rows this run created. No real HTTP leaves the process.
 */

jest.mock("axios");

import axios from "axios";
import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { EncryptionService } from "../../common/encryption.service";
import { _resetLockPoolForTests } from "../../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { MailboxAlertOutbox, MAILBOX_ALERT_LEASE_MS } from "./mailbox-alert-outbox";
import { MailboxAlertService } from "./mailbox-alert.service";
import { MailboxSendService } from "./mailbox-send.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const mockedAxios = axios as jest.Mocked<typeof axios>;

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;

function httpError(status: number, data: unknown) {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.response = { status, data, headers: {} };
  return err;
}

describeDb("#2113: durable mailbox admin alert — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let encryption: EncryptionService;
  let sender: MailboxSendService;
  let alerts: MailboxAlertService;
  let outbox: MailboxAlertOutbox;
  const createdTenantIds: string[] = [];

  const notifications = { sendToUser: jest.fn() };
  const email = { isEmailConfigured: jest.fn(), sendMailboxRevokedNotice: jest.fn() };

  const config = {
    get: (k: string) =>
      ({
        ENCRYPTION_KEY: "d".repeat(64),
        MICROSOFT_MAILBOX_CLIENT_ID: "ms-client-id",
        MICROSOFT_MAILBOX_CLIENT_SECRET: "ms-client-secret",
      })[k],
  } as unknown as ConfigService;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    encryption = new EncryptionService(config);
    sender = new MailboxSendService(prisma, encryption, config, {
      decide: jest.fn().mockResolvedValue({ outcome: "granted", overrides: new Map() }),
    } as any);
    // NOT subscribed (no onModuleInit): every transition here is "the process died between the
    // commit and the emit" — only the sweep can deliver it.
    alerts = new MailboxAlertService(sender, prisma, tenantCtx, notifications as any, email as any);
    outbox = new MailboxAlertOutbox(prisma, () => alerts.now());
  });

  beforeEach(() => {
    mockedAxios.post.mockReset();
    alerts.now = () => new Date();
    notifications.sendToUser.mockReset().mockResolvedValue(1);
    email.isEmailConfigured.mockReset().mockResolvedValue(true);
    email.sendMailboxRevokedNotice
      .mockReset()
      .mockResolvedValue({ delivered: true, transport: "smtp" });
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
    await _resetLockPoolForTests();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.mailboxConnection.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** A tenant with one active TENANT_ADMIN and a CONNECTED Outlook mailbox (valid access token). */
  async function seedTenant(label: string, overrides: Record<string, unknown> = {}) {
    tenantSeq += 1;
    const slug = assertTestTenant(
      `qa-2113-${RUN_SUFFIX}-${tenantSeq}-${label}`,
      "mailbox-alert-outbox.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2113 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `owner@${slug}.example.invalid`,
        username: `owner-${slug}`,
        role: "TENANT_ADMIN",
        status: "ACTIVE",
      },
    });
    const conn = await prisma.mailboxConnection.create({
      data: {
        tenantId: tenant.id,
        provider: "MICROSOFT",
        accountEmail: `sales@${slug}.example.invalid`,
        externalSubject: `oid-${slug}`,
        scopesGranted: ["Mail.Send"],
        refreshTokenCipher: encryption.encrypt("refresh-token-plaintext"),
        accessTokenCipher: encryption.encrypt("access-token-plaintext"),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
        status: "CONNECTED",
        ...overrides,
      },
    });
    return { tenant, admin, conn };
  }

  /** In-app notifications that reached this admin (the sweep is cross-tenant). */
  const toldAdmin = (adminId: string) =>
    notifications.sendToUser.mock.calls.filter((c) => c[0] === adminId).length;

  const pendingOf = async (id: string) =>
    (await prisma.mailboxConnection.findUniqueOrThrow({ where: { id } })).alertPendingAt;

  it("a transition whose process dies before the emit: the sweep delivers it exactly once, a second sweep nothing", async () => {
    const { tenant, admin, conn } = await seedTenant("killed");
    mockedAxios.post.mockRejectedValue(
      httpError(401, { error: { code: "InvalidAuthenticationToken" } }),
    );

    const res = await sender.trySend(tenant.id, {
      to: "customer@example.invalid",
      subject: "Your invoice",
      html: "<p>Hi</p>",
    });
    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "revoked" });
    const committed = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(committed.status).toBe("REVOKED");
    expect(committed.alertPendingAt).toBeInstanceOf(Date); // owed, in the transition's own commit
    expect(toldAdmin(admin.id)).toBe(0); // nobody was listening: the "kill"

    await alerts.sweepPending();
    expect(toldAdmin(admin.id)).toBe(1);
    expect(email.sendMailboxRevokedNotice).toHaveBeenCalledTimes(1);
    expect(await pendingOf(conn.id)).toBeNull();

    await alerts.sweepPending();
    expect(toldAdmin(admin.id)).toBe(1);
    expect(email.sendMailboxRevokedNotice).toHaveBeenCalledTimes(1);
  });

  it("concurrent claims of the same owed alert: exactly one wins", async () => {
    const seen = new Date(Date.now() - 1_000);
    const { conn } = await seedTenant("race", { status: "REVOKED", alertPendingAt: seen });

    const leases = await Promise.all(Array.from({ length: 6 }, () => outbox.claim(conn.id, seen)));

    expect(leases.filter((l) => l !== null)).toHaveLength(1);
    expect(await pendingOf(conn.id)).toEqual(leases.find((l) => l !== null));
  });

  it("concurrent settles (listener + sweeps): one delivery", async () => {
    const seen = new Date(Date.now() - 1_000);
    const { admin, conn } = await seedTenant("settle-race", {
      status: "REVOKED",
      alertPendingAt: seen,
    });

    await Promise.all([
      alerts.settle(conn.id, seen),
      alerts.settle(conn.id, seen),
      alerts.sweepPending(),
    ]);

    expect(toldAdmin(admin.id)).toBe(1);
    expect(await pendingOf(conn.id)).toBeNull();
  });

  it("a row reconnected before its alert was delivered is cleared silently", async () => {
    const { admin, conn } = await seedTenant("stale", {
      status: "CONNECTED",
      alertPendingAt: new Date(Date.now() - 1_000),
    });

    await alerts.sweepPending();

    expect(toldAdmin(admin.id)).toBe(0);
    expect(await pendingOf(conn.id)).toBeNull();
  });

  it("the clear CAS loses to a newer transition, and the newer alert is still delivered once", async () => {
    const first = new Date(Date.now() - 2_000);
    const { admin, conn } = await seedTenant("repended", {
      status: "THROTTLED",
      throttledUntil: new Date(Date.now() + 60 * 60_000),
      alertPendingAt: first,
    });
    const lease = await outbox.claim(conn.id, first);
    expect(lease).not.toBeNull();

    // A newer transition (THROTTLED → REVOKED) commits while the first deliverer is mid-flight.
    const newer = new Date(Date.now() - 1_000);
    await prisma.mailboxConnection.update({
      where: { id: conn.id },
      data: { status: "REVOKED", throttledUntil: null, alertPendingAt: newer },
    });

    expect(await outbox.clear(conn.id, lease!)).toBe(false);
    expect(await pendingOf(conn.id)).toEqual(newer); // the newer alert is still owed

    await alerts.sweepPending();
    expect(toldAdmin(admin.id)).toBe(1);
    expect(email.sendMailboxRevokedNotice).toHaveBeenCalledTimes(1);
    expect(await pendingOf(conn.id)).toBeNull();
  });

  it("a claim that is never cleared is re-delivered only once its lease has passed", async () => {
    const seen = new Date(Date.now() - 1_000);
    const { admin, conn } = await seedTenant("lease", {
      status: "REVOKED",
      alertPendingAt: seen,
    });
    const t0 = Date.now();
    alerts.now = () => new Date(t0);
    const lease = await outbox.claim(conn.id, seen); // the deliverer that then died
    expect(lease).toEqual(new Date(t0 + MAILBOX_ALERT_LEASE_MS));

    alerts.now = () => new Date(t0 + MAILBOX_ALERT_LEASE_MS - 1_000); // still inside the lease
    await alerts.sweepPending();
    expect(toldAdmin(admin.id)).toBe(0);

    alerts.now = () => new Date(t0 + MAILBOX_ALERT_LEASE_MS + 1_000); // the lease has passed
    await alerts.sweepPending();
    expect(toldAdmin(admin.id)).toBe(1);
    expect(await pendingOf(conn.id)).toBeNull();
  });

  it("the seen-null guard issues no compare-and-set: a row that owes nothing is left untouched", async () => {
    const { admin, conn } = await seedTenant("null", { status: "REVOKED" });
    const before = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: conn.id } });

    await expect(alerts.settle(conn.id, null)).resolves.toBe("not-claimed");
    await expect(alerts.settle(conn.id, undefined)).resolves.toBe("not-claimed");

    const after = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.alertPendingAt).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt); // no write happened at all
    expect(toldAdmin(admin.id)).toBe(0);
  });
});
