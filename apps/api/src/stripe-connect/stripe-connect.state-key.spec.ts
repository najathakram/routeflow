/**
 * The Connect `state` is signed with its own derived key and audience (no fallback to the raw
 * secret): a state signed any other way is refused before the jti is consumed.
 */
import * as crypto from "crypto";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { StripeConnectService } from "./stripe-connect.service";
import { PrismaService } from "../prisma/prisma.service";
import { CONNECT_OAUTH_PROVIDER } from "./provider/connect-oauth.interface";
import { createMockPrisma } from "../testing/prisma-mock";

const SECRET = "connect-state-key-test-secret-0123456789";
const STRIPE_CONFIG = {
  secretKey: "sk_test",
  connectClientId: "ca_test",
  connectWebhookSecret: "w",
};
const stateKey = Buffer.from(
  crypto.hkdfSync("sha256", SECRET, Buffer.alloc(0), "stripe-connect-state-v1", 32),
);
const claims = { purpose: "stripe-connect", tid: "tenant-1", by: "alice", jti: "jti-1" };

describe("StripeConnectService state key and audience", () => {
  const jwt = new JwtService({ secret: SECRET });
  let service: StripeConnectService;
  let prisma: any;
  let tsc: { upsert: jest.Mock; updateMany: jest.Mock };
  let oauth: any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    tsc = {
      upsert: jest.fn().mockResolvedValue({ chargesEnabled: true, livemode: false }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    prisma.tenantStripeConnect = tsc;
    prisma.user.findFirst.mockResolvedValue({ email: "a@acme.example", role: "TENANT_ADMIN" });
    prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-1", slug: "acme", name: "Acme" });
    oauth = {
      isConfigured: true,
      exchangeCode: jest.fn().mockResolvedValue({ accountRef: "acct_1", livemode: false }),
      retrieveAccount: jest
        .fn()
        .mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true }),
      retrievePlatformAccountId: jest.fn().mockResolvedValue("acct_platform"),
    };
    const mod = await Test.createTestingModule({
      providers: [
        StripeConnectService,
        { provide: PrismaService, useValue: prisma },
        { provide: CONNECT_OAUTH_PROVIDER, useValue: oauth },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) =>
              k === "stripe"
                ? STRIPE_CONFIG
                : k === "jwt"
                  ? { secret: SECRET }
                  : k === "jwt.secret"
                    ? SECRET
                    : undefined,
            ),
          },
        },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = mod.get(StripeConnectService);
  });

  const stateOf = async () =>
    new URL(await service.buildAuthorizeUrl("tenant-1", "user-1", "alice")).searchParams.get(
      "state",
    )!;

  it("round-trips: a state it minted completes, once, and a replay is refused", async () => {
    const state = await stateOf();
    const minted = jwt.verify(state, { secret: stateKey, audience: "stripe-connect-state" }) as any;
    expect(minted).toMatchObject({ purpose: "stripe-connect", tid: "tenant-1" });
    tsc.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(service.completeOAuth("code", state)).resolves.toMatchObject({
      accountId: "acct_1",
    });
    tsc.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.completeOAuth("code", state)).rejects.toMatchObject({
      response: { message: "state_replayed" },
    });
  });

  it("mints with the derived key, not the raw secret", async () => {
    const state = await stateOf();
    expect(() => jwt.verify(state)).toThrow();
  });

  it("refuses a state signed with the raw secret as state_expired, consuming nothing", async () => {
    const raw = jwt.sign({ ...claims }, { audience: "stripe-connect-state", expiresIn: "15m" });
    await expect(service.completeOAuth("code", raw)).rejects.toMatchObject({
      response: { message: "state_expired" },
    });
    expect(tsc.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a legacy raw-secret state with no audience (no fallback)", async () => {
    const legacy = jwt.sign({ ...claims }, { expiresIn: "15m" });
    await expect(service.completeOAuth("code", legacy)).rejects.toMatchObject({
      response: { message: "state_expired" },
    });
    expect(tsc.updateMany).not.toHaveBeenCalled();
  });

  it.each([["email-verify"], ["staff-access"]])(
    "refuses a derived-key state with the wrong audience (%s) as state_invalid",
    async (aud) => {
      const bad = jwt.sign(claims, { secret: stateKey, audience: aud, expiresIn: "15m" });
      await expect(service.completeOAuth("code", bad)).rejects.toMatchObject({
        response: { message: "state_invalid" },
      });
      expect(tsc.updateMany).not.toHaveBeenCalled();
    },
  );

  it("refuses a derived-key state with no audience as state_invalid", async () => {
    const bad = jwt.sign(claims, { secret: stateKey, expiresIn: "15m" });
    await expect(service.completeOAuth("code", bad)).rejects.toMatchObject({
      response: { message: "state_invalid" },
    });
  });
});
