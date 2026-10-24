/**
 * D-14 (F-10, R1.1) — the tenant-own-mailbox send path has real-Postgres unit coverage
 * (mailbox-send.service.spec.ts) with a hand-rolled Prisma stub, but nothing proves the
 * FULL round trip: a real encrypted MailboxConnection row, read back and decrypted by
 * MailboxSendService itself, driving a real MIME build, through to the one genuinely
 * external boundary (Gmail/Graph's HTTP API — mocked here, since a real send needs live
 * OAuth credentials this suite can't hold and must never touch a real inbox).
 *
 * WHY THE DB LANE: `prepareSend` takes a real Postgres advisory lock
 * (`withAdvisoryLock`, db-locks.ts) around its read — a mocked Prisma object was never
 * going to exercise that. `EncryptionService` runs for real (AES-256-GCM), so this also
 * proves a token written through the real encrypt path is legible read back.
 *
 * SAFETY: throwaway `qa-d14-<run>-<n>` tenants approved by `assertTestTenant`; `afterAll`
 * deletes exactly the tenants THIS run created, best-effort. No real HTTP leaves the
 * process — axios is mocked at the module boundary.
 */

jest.mock("axios");

import axios from "axios";
import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { MailboxSendService } from "./mailbox-send.service";
import { EncryptionService } from "../../common/encryption.service";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const mockedAxios = axios as jest.Mocked<typeof axios>;

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-d14-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "mailbox-send.e2e.db.spec.ts",
  );
}

describeDb("D-14: tenant-own-mailbox send — real Postgres round trip", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let encryption: EncryptionService;
  let service: MailboxSendService;
  const createdTenantIds: string[] = [];

  beforeEach(() => {
    mockedAxios.post.mockReset();
  });

  const config = {
    get: (k: string) =>
      ({
        ENCRYPTION_KEY: "b".repeat(64),
        GOOGLE_MAILBOX_CLIENT_ID: "client-id",
        GOOGLE_MAILBOX_CLIENT_SECRET: "client-secret",
      })[k],
  } as unknown as ConfigService;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    encryption = new EncryptionService(config);
    service = new MailboxSendService(prisma, encryption, config, {
      decide: jest.fn().mockResolvedValue({ outcome: "granted", overrides: new Map() }),
    } as any);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    // F-10a: a state change on one of these tenants writes an audit row — none of the cases
    // below should, but a regression that did must not leave rows behind.
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.mailboxConnection.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** A tenant with a CONNECTED Google mailbox, its access token encrypted for real and
   *  still valid (so `prepareSend` reads it straight back — no refresh call needed). */
  async function seedConnectedTenant(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `D-14 ${slug}` } });
    createdTenantIds.push(tenant.id);
    await prisma.mailboxConnection.create({
      data: {
        tenantId: tenant.id,
        provider: "GOOGLE",
        accountEmail: `sales@${slug}.example.invalid`,
        externalSubject: `sub-${slug}`,
        scopesGranted: ["gmail.send"],
        refreshTokenCipher: encryption.encrypt("refresh-token-plaintext"),
        accessTokenCipher: encryption.encrypt("access-token-plaintext"),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000), // 1h out — no refresh needed
        status: "CONNECTED",
      },
    });
    return { tenant };
  }

  it("REG-D14: sends through the real encrypted connection, decrypts the stored token, calls Gmail with it", async () => {
    const { tenant } = await seedConnectedTenant("send");
    mockedAxios.post.mockResolvedValueOnce({ data: { id: "gmail-msg-1" } });

    const result = await service.trySend(tenant.id, {
      to: "customer@example.invalid",
      subject: "Your invoice",
      html: "<p>Hi</p>",
      fromName: "D-14 Test Co",
    });

    expect(result).toEqual(
      expect.objectContaining({ delivered: true, transport: "mailbox", id: "gmail-msg-1" }),
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(1); // no refresh call — the stored token was still valid
    const [url, body, config2] = mockedAxios.post.mock.calls[0] as [string, any, any];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(config2.headers.Authorization).toBe("Bearer access-token-plaintext"); // decrypted correctly
    // The MIME body is base64url — assert it round-trips to a message carrying the real From.
    const decoded = Buffer.from(
      String(body.raw).replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toContain(`sales@${tenant.slug}.example.invalid`);
    expect(decoded).toContain("D-14 Test Co");
  });

  it("REG-D14: a REVOKED connection never reaches the network — falls through with 'revoked'", async () => {
    const { tenant } = await seedConnectedTenant("revoked");
    await prisma.mailboxConnection.update({
      where: { tenantId: tenant.id },
      data: { status: "REVOKED" },
    });

    const result = await service.trySend(tenant.id, {
      to: "customer@example.invalid",
      subject: "Your invoice",
      html: "<p>Hi</p>",
    });

    expect(result).toEqual({ delivered: false, transport: "mailbox", error: "revoked" });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("REG-D14: a THROTTLED connection still inside its window never reaches the network", async () => {
    const { tenant } = await seedConnectedTenant("throttled");
    await prisma.mailboxConnection.update({
      where: { tenantId: tenant.id },
      data: { status: "THROTTLED", throttledUntil: new Date(Date.now() + 60_000) },
    });

    const result = await service.trySend(tenant.id, {
      to: "customer@example.invalid",
      subject: "Your invoice",
      html: "<p>Hi</p>",
    });

    expect(result).toEqual({ delivered: false, transport: "mailbox", error: "throttled" });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("REG-D14: a tenant with no connection at all falls through as 'not_connected'", async () => {
    const slug = freshTenantSlug("none");
    const tenant = await prisma.tenant.create({ data: { slug, name: `D-14 ${slug}` } });
    createdTenantIds.push(tenant.id);

    const result = await service.trySend(tenant.id, {
      to: "customer@example.invalid",
      subject: "Your invoice",
      html: "<p>Hi</p>",
    });

    expect(result).toEqual({ delivered: false, transport: "mailbox", error: "not_connected" });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
