/**
 * F03 slice 2 (SA-1096), real Postgres: the one-time link CLAIMS are conditional writes, and each condition is
 * proved here by changing the row between the claim's read and its write.
 *
 * Why a rival write: a claim that reads a link, checks it, and then writes it is only atomic if the write repeats the
 * checks. The service reads the row, so every happy-path row passes whether or not the write repeats them. These rows
 * run the real service, and at the moment of the claim write a second connection commits a rival change (the invite
 * is claimed by someone else, its token is rotated, or its status moves). The claim must then lose, say so, and
 * leave the rival's row exactly as the rival left it.
 *
 * Also here: the refusal rules of the staff and buyer reset and verify claims (spent link, not rolled back; a
 * removed account is refused; the staff reset signs the user out everywhere).
 *
 * Run via `npm run local:test:db`. Throwaway `qa-linkclaims-<run>` tenant (approved by `assertTestTenant`);
 * afterAll deletes exactly what it made.
 */
import { createHash, randomUUID } from "crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuthService } from "./auth.service";
import { GoogleOAuthService } from "./google-oauth.service";
import { BuyerAuthService } from "../buyer/buyer-auth.service";
import { BuyerService } from "../buyer/buyer.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "link-claims-races.db.spec.ts";
const RUN = randomUUID().slice(0, 8);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const SECRET = "link-claims-races-secret-".padEnd(48, "x");

describeDb(
  "one-time link claims are conditional writes (rival write between read and claim)",
  () => {
    let prisma: PrismaService;
    let tenantId: string;
    let seq = 0;
    const buyerIds: string[] = [];
    const email = new Proxy(
      {},
      { get: () => async () => ({ delivered: true, transport: "test" }) },
    ) as never;

    let authService: AuthService;
    let buyerAuth: BuyerAuthService;
    let buyerService: BuyerService;
    let google: GoogleOAuthService;
    const state: { rival?: () => Promise<void> } = {};

    /** Wraps `customerLink.updateMany` so a rival write commits just before it runs (one shot). */
    const raceOnClaim = (base: PrismaService | Record<string, any>) =>
      new Proxy(base as any, {
        get(target, prop) {
          if (prop === "customerLink") {
            return new Proxy(target.customerLink, {
              get(model, name) {
                if (name === "updateMany") {
                  return async (args: unknown) => {
                    const rival = state.rival;
                    state.rival = undefined;
                    if (rival) await rival();
                    return model.updateMany(args);
                  };
                }
                const v = model[name];
                return typeof v === "function" ? v.bind(model) : v;
              },
            });
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });

    const mkBuyer = async (name: string, over: Record<string, unknown> = {}) => {
      const b = await prisma.buyerAccount.create({
        data: {
          email: `${name}-${RUN}-${++seq}@example.invalid`,
          passwordHash: "original-hash",
          name: `Buyer ${name}`,
          status: "ACTIVE",
          emailVerified: false,
          ...over,
        } as never,
      });
      buyerIds.push(b.id);
      return b;
    };

    /** A customer with its own login user and an invite link carrying `token`. */
    const mkInvite = async (name: string, token: string, status = "INVITED") => {
      const user = await prisma.user.create({
        data: {
          tenantId,
          username: `${name}-${RUN}-${++seq}`,
          email: `${name}-${RUN}-${seq}@example.invalid`,
          role: UserRole.CUSTOMER,
          status: UserStatus.ACTIVE,
        },
      });
      const customer = await prisma.customer.create({
        data: { tenantId, userId: user.id, businessName: `Cust ${name}`, contactName: name },
      });
      return prisma.customerLink.create({
        data: {
          customerId: customer.id,
          tenantId,
          status: status as never,
          inviteToken: token,
          inviteExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    };
    const linkNow = (id: string) => prisma.customerLink.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
      prisma = new PrismaService(new TenantContextService());
      await prisma.$connect();
      const config = {
        get: (key: string) => {
          if (key === "jwt") return { secret: SECRET };
          if (key === "REDIS_URL") return process.env.REDIS_URL;
          return undefined;
        },
      } as never;
      authService = new AuthService(prisma, {} as never, {} as never, config, email, {} as never);
      buyerAuth = new BuyerAuthService(prisma, {} as never, config, email, {} as never);
      buyerService = new BuyerService(prisma, email, config, {} as never);
      google = new GoogleOAuthService(raceOnClaim(prisma), {} as never, config, email, {} as never);
      const slug = assertTestTenant(`qa-linkclaims-${RUN}`, SPEC);
      tenantId = (await prisma.tenant.create({ data: { slug, name: `Link claims ${slug}` } })).id;
    }, 120_000);

    afterAll(async () => {
      (google as any)?.redis?.disconnect?.();
      if (tenantId) {
        await prisma.customerLink.deleteMany({ where: { tenantId } });
        await prisma.customer.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } }); // tokens and sessions cascade
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
      await prisma.buyerAccount.deleteMany({ where: { id: { in: buyerIds } } }); // tokens cascade
      await prisma?.$disconnect();
    }, 120_000);

    describe("portal invite accept (BuyerService.acceptInvite)", () => {
      /** Runs `rival` inside the accept's transaction, just before its claim write. */
      const racePortalClaim = (rival: () => Promise<void>) => {
        const original = prisma.$transaction.bind(prisma);
        jest
          .spyOn(prisma, "$transaction")
          .mockImplementationOnce(((fn: any, opts: any) =>
            original((tx: any) => fn(raceOnClaim(tx)), opts)) as never);
        state.rival = rival;
      };
      afterEach(() => jest.restoreAllMocks());

      it("P1: an invite whose status moved out of the redeemable states is refused, same token", async () => {
        const buyer = await mkBuyer("p1");
        const link = await mkInvite("p1", `tok-p1-${RUN}`);
        racePortalClaim(async () => {
          await prisma.customerLink.update({
            where: { id: link.id },
            data: { status: "DISCONNECTED" },
          });
        });
        await expect(buyerService.acceptInvite(`tok-p1-${RUN}`, buyer.id)).rejects.toBeInstanceOf(
          ConflictException,
        );
        const after = await linkNow(link.id);
        expect(after.status).toBe("DISCONNECTED");
        expect(after.buyerAccountId).toBeNull();
        expect(after.inviteToken).toBe(`tok-p1-${RUN}`); // the rival's row, untouched by the loser
      });

      it("P2: an invite whose token is rotated between the read and the write is refused, not claimed", async () => {
        const buyer = await mkBuyer("p2");
        const link = await mkInvite("p2", `tok-p2-${RUN}`);
        racePortalClaim(async () => {
          await prisma.customerLink.update({
            where: { id: link.id },
            data: { inviteToken: `rotated-p2-${RUN}` },
          });
        });
        await expect(buyerService.acceptInvite(`tok-p2-${RUN}`, buyer.id)).rejects.toBeInstanceOf(
          ConflictException,
        );
        const after = await linkNow(link.id);
        expect(after.buyerAccountId).toBeNull();
        expect(after.status).toBe("INVITED");
        expect(after.inviteToken).toBe(`rotated-p2-${RUN}`);
      });
    });

    describe("Google invite accept (GoogleOAuthService.acceptInviteToken)", () => {
      const accept = (token: string, buyerAccountId: string) =>
        (google as any).acceptInviteToken(token, buyerAccountId) as Promise<string>;

      it("G1: an invite claimed by someone else between the read and the write reads as ignored", async () => {
        const winner = await mkBuyer("g1w");
        const loser = await mkBuyer("g1l");
        const link = await mkInvite("g1", `tok-g1-${RUN}`);
        state.rival = async () => {
          await prisma.customerLink.update({
            where: { id: link.id },
            data: { status: "ACTIVE", buyerAccountId: winner.id, inviteToken: null },
          });
        };
        expect(await accept(`tok-g1-${RUN}`, loser.id)).toBe("ignored");
        expect((await linkNow(link.id)).buyerAccountId).toBe(winner.id);
      });

      it("G2: an invite whose token is rotated between the read and the write is not claimed with the old token", async () => {
        const buyer = await mkBuyer("g2");
        const link = await mkInvite("g2", `tok-g2-${RUN}`);
        state.rival = async () => {
          await prisma.customerLink.update({
            where: { id: link.id },
            data: { inviteToken: `rotated-g2-${RUN}` },
          });
        };
        expect(await accept(`tok-g2-${RUN}`, buyer.id)).toBe("ignored");
        const after = await linkNow(link.id);
        expect(after.buyerAccountId).toBeNull();
        expect(after.status).toBe("INVITED");
        expect(after.inviteToken).toBe(`rotated-g2-${RUN}`);
      });
    });

    describe("reset and verify claims", () => {
      it("R1: the staff reset signs the user out everywhere, and the link is spent", async () => {
        const user = await prisma.user.create({
          data: {
            tenantId,
            username: `r1-${RUN}-${++seq}`,
            email: `r1-${RUN}-${seq}@example.invalid`,
            role: UserRole.OPERATOR,
            status: UserStatus.ACTIVE,
          },
        });
        await prisma.refreshToken.create({
          data: {
            userId: user.id,
            tokenHash: hash(`session-${user.id}`),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        await prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hash(`raw-${user.id}`),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        await authService.resetPassword(`raw-${user.id}`, "NewPassw0rd!x");
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password,
        ).not.toBeNull();
        expect(
          await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } }),
        ).toBe(0);
      });

      it("R2: a verification link clicked while the account is suspended is spent, and stays dead after reactivation", async () => {
        const buyer = await mkBuyer("r2", { status: "SUSPENDED" });
        await prisma.buyerEmailVerificationToken.create({
          data: {
            buyerAccountId: buyer.id,
            tokenHash: hash(`verify-${buyer.id}`),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        await expect(buyerAuth.verifyEmail(`verify-${buyer.id}`)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        // the refusal is not rolled back: the claim committed, so the link is used
        expect(
          await prisma.buyerEmailVerificationToken.count({
            where: { buyerAccountId: buyer.id, usedAt: null },
          }),
        ).toBe(0);
        await prisma.buyerAccount.update({ where: { id: buyer.id }, data: { status: "ACTIVE" } });
        await expect(buyerAuth.verifyEmail(`verify-${buyer.id}`)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(
          (await prisma.buyerAccount.findUniqueOrThrow({ where: { id: buyer.id } })).emailVerified,
        ).toBe(false);
      });

      it.each([
        ["a removed account (status DELETED)", { status: "DELETED", deletedAt: new Date() }],
        ["a suspended account", { status: "SUSPENDED" }],
        ["a soft-deleted account still marked ACTIVE", { status: "ACTIVE", deletedAt: new Date() }],
      ])("R3: a buyer reset link on %s is refused and changes nothing", async (_label, over) => {
        const buyer = await mkBuyer("r3", over);
        await prisma.buyerPasswordResetToken.create({
          data: {
            buyerAccountId: buyer.id,
            tokenHash: hash(`breset-${buyer.id}`),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        await expect(
          buyerAuth.resetPassword(`breset-${buyer.id}`, "NewPassw0rd!x"),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(
          (await prisma.buyerAccount.findUniqueOrThrow({ where: { id: buyer.id } })).passwordHash,
        ).toBe("original-hash");
      });
    });
  },
);
