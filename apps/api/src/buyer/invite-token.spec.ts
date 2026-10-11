import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { NotFoundException } from "@nestjs/common";
import { BuyerService } from "./buyer.service";
import { GoogleOAuthService } from "../auth/google-oauth.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { LEGACY_INVITE_ACCEPT_UNTIL } from "../auth/legacy-link-windows";
import { createMockPrisma } from "../testing/prisma-mock";
import { FakeTable, installFakeTables } from "../testing/claim-fake";
import {
  clearInvite,
  findLiveInvite,
  hasLiveInviteToken,
  hashInviteToken,
  inviteClaimWhere,
  inviteTokenWhere,
  issueInviteData,
  legacyInviteAccepted,
  withoutInviteSecrets,
} from "./invite-token";

jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn() }));

/**
 * An invite is stored as a hash. The plaintext column is honoured only for invites issued before
 * the switch, and only until LEGACY_INVITE_ACCEPT_UNTIL; both consumers (portal accept and Google
 * accept) and the details lookup go through one helper.
 */
const TOKEN = "invite-token-abc";
const HASH = hashInviteToken(TOKEN);
const INSIDE = new Date(LEGACY_INVITE_ACCEPT_UNTIL.getTime() - 60_000);
const AFTER = new Date(LEGACY_INVITE_ACCEPT_UNTIL.getTime() + 60_000);
const NEVER = new Date("2099-01-01T00:00:00.000Z");
const GENERIC = "Invite not found or already used";

const NOT_FAKED = [
  "nextTick",
  "setImmediate",
  "clearImmediate",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
] as const;
const at = (now: Date) => jest.useFakeTimers({ now, doNotFake: [...NOT_FAKED] });

describe("invite-token helper", () => {
  it("hashes with SHA-256 hex", () => {
    expect(hashInviteToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("issueInviteData stores the hash and empties the plaintext column", () => {
    expect(issueInviteData(TOKEN)).toEqual({ inviteToken: null, inviteTokenHash: HASH });
  });

  it("clearInvite nulls BOTH columns and keeps the rest of the write", () => {
    expect(clearInvite({ status: "ACTIVE", inviteExpiresAt: null })).toEqual({
      status: "ACTIVE",
      inviteExpiresAt: null,
      inviteToken: null,
      inviteTokenHash: null,
    });
    expect(clearInvite()).toEqual({ inviteToken: null, inviteTokenHash: null });
  });

  it("the legacy window closes at the hard constant", () => {
    expect(legacyInviteAccepted(INSIDE)).toBe(true);
    expect(legacyInviteAccepted(LEGACY_INVITE_ACCEPT_UNTIL)).toBe(false);
    expect(legacyInviteAccepted(AFTER)).toBe(false);
  });

  it("the token match is hash-or-plaintext inside the window and hash-only after it", () => {
    expect(inviteTokenWhere(TOKEN, INSIDE)).toEqual({
      OR: [{ inviteTokenHash: HASH }, { inviteToken: TOKEN }],
    });
    expect(inviteTokenWhere(TOKEN, AFTER)).toEqual({ inviteTokenHash: HASH });
  });

  it("the claim carries id, status, customer, token and expiry predicates", () => {
    expect(inviteClaimWhere("link-1", TOKEN, AFTER)).toEqual({
      id: "link-1",
      status: { in: ["INVITED", "PENDING_SELLER_APPROVAL"] },
      customer: { deletedAt: null },
      AND: [
        { inviteTokenHash: HASH },
        { OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: AFTER } }] },
      ],
    });
  });

  describe("hasLiveInviteToken: either column, plaintext only inside the window, not expired", () => {
    it.each([
      ["hash only", { inviteTokenHash: HASH }, INSIDE, true],
      ["hash only, after the window", { inviteTokenHash: HASH }, AFTER, true],
      ["plaintext only, inside the window", { inviteToken: TOKEN }, INSIDE, true],
      ["plaintext only, after the window", { inviteToken: TOKEN }, AFTER, false],
      ["neither column", {}, INSIDE, false],
      [
        "hash, expired",
        { inviteTokenHash: HASH, inviteExpiresAt: new Date(INSIDE.getTime() - 1) },
        INSIDE,
        false,
      ],
      ["hash, not yet expired", { inviteTokenHash: HASH, inviteExpiresAt: NEVER }, INSIDE, true],
    ])("%s", (_n, link, now, live) => {
      expect(hasLiveInviteToken(link, now)).toBe(live);
    });
  });

  it("withoutInviteSecrets drops both columns and nothing else", () => {
    expect(
      withoutInviteSecrets({ id: "l", inviteToken: "x", inviteTokenHash: "y", status: "INVITED" }),
    ).toEqual({ id: "l", status: "INVITED" });
  });

  it("findLiveInvite looks up the hash first, and the plaintext column only inside the window", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = { customerLink: { findFirst } } as any;

    await findLiveInvite(db, TOKEN, INSIDE);
    expect(findFirst.mock.calls.map((c) => c[0].where)).toEqual([
      { inviteTokenHash: HASH, customer: { deletedAt: null } },
      { inviteToken: TOKEN, customer: { deletedAt: null } },
    ]);

    findFirst.mockClear();
    await findLiveInvite(db, TOKEN, AFTER);
    expect(findFirst.mock.calls.map((c) => c[0].where)).toEqual([
      { inviteTokenHash: HASH, customer: { deletedAt: null } },
    ]);
  });
});

describe("invite consumers against an in-memory link table", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let buyers: BuyerService;
  let google: GoogleOAuthService;
  let links: FakeTable;

  const row = (patch: Record<string, unknown> = {}) => ({
    id: "link-1",
    tenantId: "tenant-1",
    customerId: "cust-1",
    status: "INVITED",
    buyerAccountId: null as string | null,
    inviteToken: null as string | null,
    inviteTokenHash: HASH as string | null,
    inviteExpiresAt: NEVER as Date | null,
    inviteMethod: "EMAIL",
    linkedAt: null as Date | null,
    tenant: { id: "tenant-1", name: "Acme Foods", slug: "acme-foods" },
    customer: { id: "cust-1", deletedAt: null as Date | null },
    ...patch,
  });
  const hashOnly = () => row();
  const plaintextOnly = () => row({ inviteToken: TOKEN, inviteTokenHash: null });

  function seed(r: Record<string, unknown>) {
    links = new FakeTable([r], "link");
    installFakeTables(prisma, { customerLink: links });
    prisma.tenantConfig.findFirst.mockResolvedValue({
      businessName: "Acme Foods",
      logoKey: null,
      primaryColor: null,
    } as any);
  }

  const webAccept = () => buyers.acceptInvite(TOKEN, "buyer-1");
  const googleAccept = () => (google as any).acceptInviteToken(TOKEN, "buyer-1");

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        BuyerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: RouteFlowGateway, useValue: {} },
      ],
    }).compile();
    buyers = mod.get(BuyerService);
    google = new GoogleOAuthService(
      prisma as any,
      { sign: jest.fn(), decode: jest.fn() } as unknown as JwtService,
      {
        get: (k: string) =>
          k === "jwt"
            ? {
                secret: "test-jwt-secret-0123456789-abcdefghijklmnop",
                refreshSecret: "rs",
                expiresIn: "15m",
                refreshExpiresIn: "30d",
              }
            : undefined,
      } as unknown as ConfigService,
      { send: jest.fn() } as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
    );
  });

  afterEach(() => jest.useRealTimers());

  describe("a hash-only invite (the plaintext column is null)", () => {
    it.each([
      ["inside the window", INSIDE],
      ["after the window", AFTER],
    ] as const)("is previewed, then accepted by the portal, %s", async (_n, now) => {
      at(now);
      seed(hashOnly());

      await expect(buyers.getInviteDetails(TOKEN)).resolves.toMatchObject({
        sellerSlug: "acme-foods",
      });
      await expect(webAccept()).resolves.toMatchObject({ linkId: "link-1" });

      expect(links.rows[0]).toMatchObject({
        status: "ACTIVE",
        buyerAccountId: "buyer-1",
        inviteToken: null,
        inviteTokenHash: null,
      });
    });

    it("is accepted by the Google sign-in too, and both columns end null", async () => {
      at(AFTER);
      seed(hashOnly());

      await googleAccept();

      expect(links.rows[0]).toMatchObject({
        status: "ACTIVE",
        buyerAccountId: "buyer-1",
        inviteToken: null,
        inviteTokenHash: null,
      });
    });

    it("a different token finds nothing", async () => {
      at(INSIDE);
      seed(hashOnly());

      await expect(buyers.getInviteDetails("some-other-token")).rejects.toThrow(NotFoundException);
      await expect(buyers.acceptInvite("some-other-token", "buyer-1")).rejects.toThrow(GENERIC);
      expect(links.rows[0]).toMatchObject({ status: "INVITED", inviteTokenHash: HASH });
    });
  });

  describe("a legacy invite (plaintext column only)", () => {
    it("is previewed and accepted by the portal before the window closes; both columns end null", async () => {
      at(INSIDE);
      seed(plaintextOnly());

      await expect(buyers.getInviteDetails(TOKEN)).resolves.toMatchObject({
        sellerSlug: "acme-foods",
      });
      await expect(webAccept()).resolves.toMatchObject({ linkId: "link-1" });

      expect(links.rows[0]).toMatchObject({
        status: "ACTIVE",
        inviteToken: null,
        inviteTokenHash: null,
      });
    });

    it("is accepted by the Google sign-in before the window closes", async () => {
      at(INSIDE);
      seed(plaintextOnly());

      await googleAccept();

      expect(links.rows[0]).toMatchObject({ status: "ACTIVE", buyerAccountId: "buyer-1" });
    });

    it("is refused everywhere after the window, with the generic answer, and nothing changes", async () => {
      at(AFTER);
      seed(plaintextOnly());
      const before = JSON.stringify(links.rows);

      await expect(buyers.getInviteDetails(TOKEN)).rejects.toThrow(GENERIC);
      await expect(webAccept()).rejects.toThrow(GENERIC);
      await googleAccept();

      expect(JSON.stringify(links.rows)).toBe(before);
    });
  });
});
