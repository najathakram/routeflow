/**
 * F-10a (#2077) — DB lane. A mailbox state change is ONE conditional UPDATE, so concurrent sends
 * that detect the same revocation (or rate limit) produce exactly one audit row and one admin
 * notification. mailbox-state-change.spec.ts pins the query against a Prisma stub; only real
 * Postgres proves the guarantee itself: under READ COMMITTED the second UPDATE blocks on the row
 * lock, re-evaluates `status IN (...)` against the committed row, and matches nothing.
 *
 * DETERMINISTIC RACE: the provider mock parks every send at the network boundary until ALL of
 * them have arrived there, so each send has already read the row as CONNECTED and fetched its
 * token before any of them can write — the detections really are concurrent, not sequential.
 *
 * REAL: Postgres, the `mailbox` advisory lock around the token read, EncryptionService,
 * AuditService (real AuditLog rows), MailboxSendService, and MailboxAlertService including its
 * admin lookup against a real seeded TENANT_ADMIN. STUBBED: the provider HTTP APIs (axios) and
 * the two delivery edges — NotificationsService.sendToUser and
 * EmailService.sendMailboxRevokedNotice — which are counted, never sent.
 *
 * SAFETY: throwaway `qa-f10a-<run>-<n>` tenants approved by `assertTestTenant`; `afterAll`
 * deletes exactly the rows this run created. No real HTTP leaves the process.
 */

jest.mock("axios");

import axios from "axios";
import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../../audit/audit.service";
import { EncryptionService } from "../../common/encryption.service";
import { _resetLockPoolForTests } from "../../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { MailboxAlertService } from "./mailbox-alert.service";
import { MailboxSendService, type MailboxStateChange } from "./mailbox-send.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const mockedAxios = axios as jest.Mocked<typeof axios>;

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-f10a-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "mailbox-state-change.db.spec.ts",
  );
}

function httpError(status: number, data: unknown, headers: Record<string, string> = {}) {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.response = { status, data, headers };
  return err;
}

/**
 * A provider stand-in that parks every call until `n` calls have arrived, then rejects them all
 * with `makeErr()`. `beforeRelease` runs once, when the last call arrives and before any call is
 * released — the moment "another replica" or "the admin" acts in the race tests below.
 */
function holdUntilAllArrive(
  n: number,
  makeErr: () => unknown,
  beforeRelease?: () => Promise<void>,
) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === n) {
      if (beforeRelease) await beforeRelease();
      release();
    }
    await gate;
    throw makeErr();
  };
}

describeDb("F-10a: mailbox REVOKED / THROTTLED transitions — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let encryption: EncryptionService;
  let service: MailboxSendService;
  let alerts: MailboxAlertService;
  const createdTenantIds: string[] = [];

  const notifications = { sendToUser: jest.fn() };
  const email = { isEmailConfigured: jest.fn(), sendMailboxRevokedNotice: jest.fn() };
  let emitted: MailboxStateChange[] = [];
  let deliveries: Promise<void>[] = [];
  let unsubscribe: () => void = () => {};

  const config = {
    get: (k: string) =>
      ({
        ENCRYPTION_KEY: "c".repeat(64),
        GOOGLE_MAILBOX_CLIENT_ID: "client-id",
        GOOGLE_MAILBOX_CLIENT_SECRET: "client-secret",
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
    service = new MailboxSendService(prisma, encryption, config, new AuditService(prisma));
    alerts = new MailboxAlertService(
      service,
      prisma,
      tenantCtx,
      notifications as any,
      email as any,
    );
  });

  beforeEach(() => {
    mockedAxios.post.mockReset();
    notifications.sendToUser.mockReset().mockResolvedValue(1);
    email.isEmailConfigured.mockReset().mockResolvedValue(true);
    email.sendMailboxRevokedNotice
      .mockReset()
      .mockResolvedValue({ delivered: true, transport: "smtp" });
    emitted = [];
    deliveries = [];
    // Each state change goes through the REAL alert service; the delivery promise is kept so a
    // test awaits the notifications themselves rather than guessing a delay (L-165).
    unsubscribe = service.onStateChange((change) => {
      emitted.push(change);
      deliveries.push(alerts.notifyAdmins(change));
    });
  });

  afterEach(() => unsubscribe());

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

  /** A tenant with one active TENANT_ADMIN and a mailbox whose access token is still valid, so
   *  every send goes straight to the provider (no refresh). */
  async function seedTenant(
    label: string,
    provider: "GOOGLE" | "MICROSOFT",
    overrides: { status?: "CONNECTED" | "THROTTLED"; throttledUntil?: Date } = {},
  ) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `F-10a ${slug}` } });
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
        provider,
        accountEmail: `sales@${slug}.example.invalid`,
        externalSubject: `sub-${slug}`,
        scopesGranted: provider === "GOOGLE" ? ["gmail.send"] : ["Mail.Send"],
        refreshTokenCipher: encryption.encrypt("refresh-token-plaintext"),
        accessTokenCipher: encryption.encrypt("access-token-plaintext"),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
        status: "CONNECTED",
        ...overrides,
      },
    });
    return { tenant, admin, conn };
  }

  const sendAs = (tenantId: string) =>
    service.trySend(tenantId, {
      to: "customer@example.invalid",
      subject: "Your invoice",
      html: "<p>Hi</p>",
    });

  const auditRows = (tenantId: string) =>
    prisma.auditLog.findMany({ where: { tenantId, entityType: "mailbox_connection" } });

  it("REG-2077: two sends detecting the same Graph revocation at once — ONE audit row, ONE notification, row REVOKED", async () => {
    const { tenant, admin, conn } = await seedTenant("graph401", "MICROSOFT");
    mockedAxios.post.mockImplementation(
      holdUntilAllArrive(2, () =>
        httpError(401, { error: { code: "InvalidAuthenticationToken" } }),
      ) as any,
    );

    const results = await Promise.all([sendAs(tenant.id), sendAs(tenant.id)]);
    await Promise.all(deliveries);

    // Both sends fell through, and both genuinely reached the provider before either wrote.
    expect(results).toEqual([
      { delivered: false, transport: "mailbox", error: "revoked" },
      { delivered: false, transport: "mailbox", error: "revoked" },
    ]);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);

    const rows = await auditRows(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "mailbox.revoked_detected",
      entityId: conn.id,
      userId: null,
      meta: { provider: "MICROSOFT", accountEmail: conn.accountEmail, reasonCode: "graph_401" },
    });
    expect(emitted).toHaveLength(1);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser.mock.calls[0][0]).toBe(admin.id);
    expect(email.sendMailboxRevokedNotice).toHaveBeenCalledTimes(1);
    expect(email.sendMailboxRevokedNotice.mock.calls[0][0]).toMatchObject({
      to: admin.email,
      accountEmail: conn.accountEmail,
      provider: "MICROSOFT",
    });

    const after = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe("REVOKED");
    expect(after.lastError).toBe("Microsoft rejected the send — reconnect required.");
    expect(after.lastErrorAt).toBeInstanceOf(Date);
  });

  it("REG-2077: two sends rate-limited at once — ONE throttled audit row, ONE in-app notification, no email", async () => {
    const { tenant, admin, conn } = await seedTenant("gmail429", "GOOGLE");
    mockedAxios.post.mockImplementation(
      holdUntilAllArrive(2, () => httpError(429, {}, { "retry-after": "120" })) as any,
    );

    const before = Date.now();
    const results = await Promise.all([sendAs(tenant.id), sendAs(tenant.id)]);
    await Promise.all(deliveries);

    expect(results.map((r) => r.error)).toEqual(["throttled", "throttled"]);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    const rows = await auditRows(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "mailbox.throttled_detected",
      entityId: conn.id,
      meta: { provider: "GOOGLE", accountEmail: conn.accountEmail, reasonCode: "rate_limited" },
    });
    expect(emitted).toHaveLength(1);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser.mock.calls[0][0]).toBe(admin.id);
    expect(email.sendMailboxRevokedNotice).not.toHaveBeenCalled();

    const after = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe("THROTTLED");
    expect(after.throttledUntil!.getTime() - before).toBeGreaterThan(115_000);
  });

  it("REG-2077: a detection on a row another replica already revoked writes nothing new", async () => {
    const { tenant, conn } = await seedTenant("already", "MICROSOFT");
    const otherReplicasError = "Revoked by another replica a moment ago.";
    mockedAxios.post.mockImplementation(
      holdUntilAllArrive(
        1,
        () => httpError(401, {}),
        async () => {
          await prisma.mailboxConnection.update({
            where: { id: conn.id },
            data: { status: "REVOKED", lastError: otherReplicasError },
          });
        },
      ) as any,
    );

    const res = await sendAs(tenant.id);
    await Promise.all(deliveries);

    expect(res.error).toBe("revoked");
    expect(await auditRows(tenant.id)).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(notifications.sendToUser).not.toHaveBeenCalled();
    const after = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe("REVOKED");
    expect(after.lastError).toBe(otherReplicasError); // the losing detection wrote nothing
  });

  it("REG-2077: a 401 for a credential the admin replaced mid-send never revokes the fresh connection", async () => {
    const { tenant, conn } = await seedTenant("reconnected", "MICROSOFT");
    mockedAxios.post.mockImplementation(
      holdUntilAllArrive(
        1,
        () => httpError(401, {}),
        async () => {
          // What confirmConnect writes when the admin reconnects: a new grant, CONNECTED.
          await prisma.mailboxConnection.update({
            where: { id: conn.id },
            data: {
              accessTokenCipher: encryption.encrypt("fresh-access-token"),
              refreshTokenCipher: encryption.encrypt("fresh-refresh-token"),
              status: "CONNECTED",
            },
          });
        },
      ) as any,
    );

    const res = await sendAs(tenant.id);
    await Promise.all(deliveries);

    expect(res.error).toBe("revoked"); // this send still falls through to the next sender
    expect(await auditRows(tenant.id)).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    const after = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe("CONNECTED");
  });

  it("REG-2077: a repeat 429 on an already-THROTTLED row extends its window — no new audit row", async () => {
    const { tenant, conn } = await seedTenant("rethrottle", "GOOGLE", {
      status: "THROTTLED",
      throttledUntil: new Date(Date.now() - 1000), // lapsed: this send retries the mailbox
    });
    mockedAxios.post.mockImplementation(
      holdUntilAllArrive(1, () => httpError(429, {}, { "retry-after": "300" })) as any,
    );

    const before = Date.now();
    const res = await sendAs(tenant.id);
    await Promise.all(deliveries);

    expect(res.error).toBe("throttled");
    expect(await auditRows(tenant.id)).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    const after = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe("THROTTLED");
    expect(after.throttledUntil!.getTime() - before).toBeGreaterThan(295_000);
  });
});
