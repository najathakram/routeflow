import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ConflictException, GoneException, NotFoundException } from "@nestjs/common";
import { BuyerService } from "./buyer.service";
import { GoogleOAuthService } from "../auth/google-oauth.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { FakeCall, FakeTable, installFakeTables } from "../testing/claim-fake";
import { hashInviteToken } from "./invite-token";

jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn() }));

/**
 * Invite links are consumed by an atomic claim. Both consumers (the portal accept and the Google
 * sign-in accept) run for real against one in-memory link table that applies the `where` each
 * sends, so the loser of a race gets a real count of 0 and a throwing transaction really undoes
 * its writes.
 */
const TOKEN = "invite-token-1";
const HASH = hashInviteToken(TOKEN);
const GENERIC = "Invite not found or already used";

describe("invite link — claimed atomically by both consumers", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let buyers: BuyerService;
  let google: GoogleOAuthService;
  let links: FakeTable;
  let log: FakeCall[];

  const linkRow = (patch: Record<string, unknown> = {}) => ({
    id: "link-1",
    tenantId: "tenant-1",
    customerId: "cust-1",
    status: "INVITED",
    buyerAccountId: null as string | null,
    inviteToken: null as string | null,
    inviteTokenHash: HASH as string | null,
    inviteExpiresAt: new Date(Date.now() + 3_600_000) as Date | null,
    inviteMethod: "EMAIL",
    linkedAt: null as Date | null,
    tenant: { id: "tenant-1", name: "Acme Foods", slug: "acme-foods" },
    customer: { id: "cust-1", deletedAt: null as Date | null },
    ...patch,
  });

  function seed(rows: Array<Record<string, unknown>> = [linkRow()]) {
    log = [];
    links = new FakeTable(rows, "link", log);
    installFakeTables(prisma, { customerLink: links });
  }

  const webAccept = (buyer: string) => buyers.acceptInvite(TOKEN, buyer);
  const googleAccept = (buyer: string) => (google as any).acceptInviteToken(TOKEN, buyer);
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error("expected a refusal");
      },
      (e) => e,
    );

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

  it("(d) two concurrent portal accepts: exactly one connects, the other is refused generically", async () => {
    seed();

    const results = await Promise.allSettled([webAccept("buyer-a"), webAccept("buyer-b")]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(NotFoundException);
    expect(lost.reason.message).toBe(GENERIC);

    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>)
      .value;
    expect(winner).toMatchObject({ tenantSlug: "acme-foods", linkId: "link-1" });
    expect(links.rows[0]).toMatchObject({
      status: "ACTIVE",
      inviteToken: null,
      inviteTokenHash: null,
    });
    expect(["buyer-a", "buyer-b"]).toContain(links.rows[0]!.buyerAccountId);
    // Exactly one write ever matched.
    const claims = log.filter((c) => c.op === "link.updateMany");
    expect(claims).toHaveLength(2);
  });

  it("(d) a portal accept racing a Google accept of the same link: exactly one connects", async () => {
    seed();

    const [web, goog] = await Promise.allSettled([webAccept("buyer-web"), googleAccept("buyer-g")]);

    const webWon = web.status === "fulfilled";
    // Google's accept never throws: a lost claim is ignored, as an expired invite is.
    expect(goog.status).toBe("fulfilled");
    expect(links.rows[0]).toMatchObject({
      status: "ACTIVE",
      inviteToken: null,
      inviteTokenHash: null,
    });
    expect(links.rows[0]!.buyerAccountId).toBe(webWon ? "buyer-web" : "buyer-g");
    if (!webWon) {
      expect((web as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundException);
    }
    // The loser changed nothing: a single owner, a single linkedAt.
    expect(links.rows[0]!.linkedAt).toBeInstanceOf(Date);
  });

  it("(d) the same race the other way round (Google claims first)", async () => {
    seed();

    await googleAccept("buyer-g");
    const err = await refusal(webAccept("buyer-web"));

    expect(err).toBeInstanceOf(NotFoundException);
    expect(links.rows[0]!.buyerAccountId).toBe("buyer-g");
  });

  it("(d) two concurrent Google accepts: exactly one connects", async () => {
    seed();

    await Promise.all([googleAccept("buyer-a"), googleAccept("buyer-b")]);

    expect(links.rows[0]).toMatchObject({
      status: "ACTIVE",
      inviteToken: null,
      inviteTokenHash: null,
    });
    expect(["buyer-a", "buyer-b"]).toContain(links.rows[0]!.buyerAccountId);
    const matched = log.filter((c) => c.op === "link.updateMany");
    expect(matched).toHaveLength(2);
  });

  it("the portal claim carries every predicate and clears the token", async () => {
    seed();

    await webAccept("buyer-a");

    const claim = log.find((c) => c.op === "link.updateMany" && c.inTx)!;
    expect(claim.args.where).toEqual({
      id: "link-1",
      status: { in: ["INVITED", "PENDING_SELLER_APPROVAL"] },
      customer: { deletedAt: null },
      AND: [
        { OR: [{ inviteTokenHash: HASH }, { inviteToken: TOKEN }] },
        { OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: expect.any(Date) } }] },
      ],
    });
    expect(claim.args.data).toEqual({
      buyerAccountId: "buyer-a",
      status: "ACTIVE",
      linkedAt: expect.any(Date),
      inviteToken: null,
      inviteTokenHash: null,
      inviteExpiresAt: null,
    });
  });

  it("the Google claim carries every predicate and clears the token", async () => {
    seed();

    await googleAccept("buyer-g");

    const claim = log.find((c) => c.op === "link.updateMany")!;
    expect(claim.args.where).toEqual({
      id: "link-1",
      status: { in: ["INVITED", "PENDING_SELLER_APPROVAL"] },
      customer: { deletedAt: null },
      AND: [
        { OR: [{ inviteTokenHash: HASH }, { inviteToken: TOKEN }] },
        { OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: expect.any(Date) } }] },
      ],
    });
    expect(claim.args.data).toEqual({
      buyerAccountId: "buyer-g",
      status: "ACTIVE",
      inviteToken: null,
      inviteTokenHash: null,
      inviteExpiresAt: null,
      linkedAt: expect.any(Date),
    });
  });

  it("(d) a failure after the claim rolls the claim back (portal)", async () => {
    // The buyer already holds an ACTIVE link to this seller through another customer row.
    seed([
      linkRow(),
      linkRow({
        id: "link-other",
        customerId: "cust-2",
        status: "ACTIVE",
        buyerAccountId: "buyer-a",
        inviteToken: null,
        inviteTokenHash: null,
        inviteExpiresAt: null,
        customer: { id: "cust-2", deletedAt: null },
      }),
    ]);

    const err = await refusal(webAccept("buyer-a"));

    expect(err).toBeInstanceOf(ConflictException);
    expect(links.rows[0]).toMatchObject({
      status: "INVITED",
      inviteTokenHash: HASH,
      buyerAccountId: null,
    });
  });

  describe("(e) an invite that is not redeemable", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "a removed customer",
        { customer: { id: "cust-1", deletedAt: new Date("2026-09-01T00:00:00Z") } },
      ],
      ["an already-active link", { status: "ACTIVE" }],
      ["a disconnected link", { status: "DISCONNECTED" }],
      ["an expired invite", { inviteExpiresAt: new Date(Date.now() - 1000) }],
    ];

    it.each(cases)("%s: the portal accept is refused and nothing changes", async (_n, patch) => {
      seed([linkRow(patch)]);
      const before = JSON.stringify(links.rows);

      const err = await refusal(webAccept("buyer-a"));

      expect(
        [NotFoundException, GoneException, ConflictException].some((c) => err instanceof c),
      ).toBe(true);
      expect(JSON.stringify(links.rows)).toBe(before);
    });

    it.each(cases)("%s: the Google accept is ignored and nothing changes", async (_n, patch) => {
      seed([linkRow(patch)]);
      const before = JSON.stringify(links.rows);

      await googleAccept("buyer-g");

      expect(JSON.stringify(links.rows)).toBe(before);
    });

    it("an invite that lapses between the read and the claim is refused and nothing changes", async () => {
      seed([linkRow()]);
      // The read sees a live invite; by the time the claim runs the invite has lapsed.
      const view = links.view.bind(links);
      links.view = (undo) => {
        const v = view(undo);
        const read = v.findFirst;
        v.findFirst = async (a) => {
          const found = await read(a);
          const snapshot = found && { ...found };
          if (found) found.inviteExpiresAt = new Date(Date.now() - 1000);
          return snapshot;
        };
        return v;
      };
      installFakeTables(prisma, { customerLink: links });

      const err = await refusal(webAccept("buyer-a"));

      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe(GENERIC);
      expect(links.rows[0]).toMatchObject({ status: "INVITED", inviteTokenHash: HASH });
    });
  });

  it("(g) a pending-approval row is still redeemable by the invitee via either path", async () => {
    seed([linkRow({ status: "PENDING_SELLER_APPROVAL", buyerAccountId: "impostor" })]);
    await expect(webAccept("invitee")).resolves.toMatchObject({ linkId: "link-1" });
    expect(links.rows[0]).toMatchObject({ status: "ACTIVE", buyerAccountId: "invitee" });

    seed([linkRow({ status: "PENDING_SELLER_APPROVAL", buyerAccountId: "impostor" })]);
    await googleAccept("invitee");
    expect(links.rows[0]).toMatchObject({ status: "ACTIVE", buyerAccountId: "invitee" });
  });
});
