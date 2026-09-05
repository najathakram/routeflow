/**
 * P4-b — regression pin (architecture review P-15/P-16): the three global guards
 * registered in app.module.ts run in order `ThrottlerGuard → TenantStatusGuard →
 * ImpersonationGuard`, all BEFORE `JwtAuthGuard` (route-level only), and hand-decode
 * the bearer payload without verifying the signature. This file drives the whole
 * chain, in that registered order, against forged tokens to pin the invariant that
 * nothing in the chain ever GRANTS access on an unverified claim — TenantStatusGuard
 * may only deny (403) or pass through, ImpersonationGuard only logs, and the actual
 * authorization boundary stays JwtAuthGuard's signature check.
 *
 * SCOPE: two of the three global guards run for real (TenantStatusGuard against a mock
 * PrismaService, ImpersonationGuard as-is), and JwtAuthGuard runs against a real
 * JwtStrategy. ThrottlerGuard is a `{ canActivate: () => true }` STUB — it is called
 * first only to hold the registered ORDER honest. Rate-limiting behaviour itself is not
 * under test here; that lives in login-throttle-config.spec.ts and
 * throttler-exception.filter.spec.ts.
 *
 * T1/R1/R2 (2026-09-03-imp-p4-guard-order-findunique-pins/brief.md). See also
 * impersonation.guard.spec.ts (fake-ExecutionContext pattern) and
 * tenant-status.guard.spec.ts (TenantStatusGuard mock-PrismaService pattern) —
 * this file drives the same guards together, through JwtAuthGuard, rather than
 * duplicating either file's isolated coverage.
 */
import { Test } from "@nestjs/testing";
import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { JwtStrategy } from "../strategies/jwt.strategy";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { ImpersonationGuard } from "./impersonation.guard";
import { TenantStatusGuard } from "../../tenant/tenant-status.guard";
import { PrismaService } from "../../prisma/prisma.service";

const SECRET = "guard-chain-test-secret";
const WRONG_SECRET = "guard-chain-wrong-secret";

/** Claims an attacker who controls only the bearer header could put in a forged token. */
const FORGED_CLAIMS = {
  sub: "attacker-1",
  username: "attacker",
  role: "SUPER_ADMIN",
  status: "ACTIVE",
  tenantId: null as string | null,
  impersonatedBy: "admin",
};

function ctx(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function bearer(token: string): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** Unsigned shape: base64url(header).base64url(payload).s — same convention as
 * impersonation.guard.spec.ts's `tokenWith`; the guards under test only ever read
 * the payload segment by hand, so the header content is irrelevant to them, and
 * a non-JSON header segment is exactly what makes jsonwebtoken.verify() reject it. */
function unsignedToken(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

describe("T1/R1/R2 — global guard chain (ThrottlerGuard → TenantStatusGuard → ImpersonationGuard) then JwtAuthGuard: never authorizes on an unverified claim", () => {
  let jwtService: JwtService;
  const throttlerGuard = { canActivate: jest.fn().mockResolvedValue(true) };
  let tenantStatusByTenantId: Record<string, string>;
  let jwtAuthGuard: JwtAuthGuard;
  let impersonationGuard: ImpersonationGuard;

  beforeAll(async () => {
    // Registers the real JwtStrategy against the real Passport singleton (its
    // constructor calls passport.use('jwt', this) as a DI-construction side
    // effect), so `new JwtAuthGuard().canActivate(ctx)` below drives genuine
    // signature verification, not a stub.
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: SECRET })],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === "jwt" ? { secret: SECRET } : undefined) },
        },
      ],
    }).compile();

    jwtService = moduleRef.get(JwtService);
    moduleRef.get(JwtStrategy); // force instantiation / passport registration
  });

  beforeEach(() => {
    tenantStatusByTenantId = {};
    throttlerGuard.canActivate.mockClear();
    jwtAuthGuard = new JwtAuthGuard();
    impersonationGuard = new ImpersonationGuard();
  });

  function makeTenantStatusGuard(): TenantStatusGuard {
    const prisma = {
      tenant: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            tenantStatusByTenantId[where.id] !== undefined
              ? { status: tenantStatusByTenantId[where.id] }
              : null,
          ),
        ),
      },
    };
    return new TenantStatusGuard(prisma as unknown as PrismaService);
  }

  /** Drives the app.module.ts APP_GUARD chain in its registered order, then the
   * route-level JwtAuthGuard — mirroring what a real request goes through. */
  async function runChain(
    req: Record<string, unknown>,
    tenantStatusGuard: TenantStatusGuard,
  ): Promise<boolean> {
    await throttlerGuard.canActivate(ctx(req));
    await tenantStatusGuard.canActivate(ctx(req));
    await impersonationGuard.canActivate(ctx(req));
    return jwtAuthGuard.canActivate(ctx(req));
  }

  it("T1/R1 an unsigned token (h.<payload>.s) carrying forged SUPER_ADMIN/impersonatedBy claims is rejected 401 by JwtAuthGuard", async () => {
    const req = bearer(unsignedToken(FORGED_CLAIMS));
    await expect(runChain(req, makeTenantStatusGuard())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("T1/R1 a token signed with the WRONG secret carrying forged claims is rejected 401", async () => {
    const token = new JwtService({ secret: WRONG_SECRET }).sign(FORGED_CLAIMS);
    const req = bearer(token);
    await expect(runChain(req, makeTenantStatusGuard())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("T1/R1 an expired token (expiresIn: -10) carrying forged claims is rejected 401", async () => {
    const token = jwtService.sign(FORGED_CLAIMS, { expiresIn: -10 });
    const req = bearer(token);
    await expect(runChain(req, makeTenantStatusGuard())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("T1/R1 a correctly signed token resolves 200 — JwtAuthGuard returns true and stamps req.user from the VERIFIED claim", async () => {
    const token = jwtService.sign({
      sub: "user-1",
      username: "op1",
      role: "OPERATOR",
      status: "ACTIVE",
      tenantId: "tenant-active",
    });
    const req = bearer(token) as Record<string, unknown> & { user?: { sub: string; role: string } };
    tenantStatusByTenantId["tenant-active"] = "ACTIVE";

    await expect(runChain(req, makeTenantStatusGuard())).resolves.toBe(true);
    expect(req.user?.sub).toBe("user-1");
    expect(req.user?.role).toBe("OPERATOR");
  });

  it("T1/R2 a forged token naming a SUSPENDED tenant is rejected 403 by TenantStatusGuard BEFORE JwtAuthGuard ever runs", async () => {
    const req = bearer(unsignedToken({ ...FORGED_CLAIMS, tenantId: "tenant-suspended" }));
    tenantStatusByTenantId["tenant-suspended"] = "SUSPENDED";
    const tenantStatusGuard = makeTenantStatusGuard();
    const jwtSpy = jest.spyOn(jwtAuthGuard, "canActivate");

    await expect(runChain(req, tenantStatusGuard)).rejects.toBeInstanceOf(ForbiddenException);
    expect(jwtSpy).not.toHaveBeenCalled();
  });

  it("T1/R2 a forged token naming an ACTIVE tenant passes TenantStatusGuard, then still gets 401 from JwtAuthGuard (unverified signature)", async () => {
    const req = bearer(unsignedToken({ ...FORGED_CLAIMS, tenantId: "tenant-active-2" }));
    tenantStatusByTenantId["tenant-active-2"] = "ACTIVE";
    const tenantStatusGuard = makeTenantStatusGuard();

    await expect(tenantStatusGuard.canActivate(ctx(req))).resolves.toBe(true);
    await expect(runChain(req, tenantStatusGuard)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("T1/R2 a forged token with tenantId: null passes TenantStatusGuard (SUPER_ADMIN exemption), then still gets 401 from JwtAuthGuard", async () => {
    const req = bearer(unsignedToken(FORGED_CLAIMS)); // tenantId: null
    const tenantStatusGuard = makeTenantStatusGuard();

    await expect(tenantStatusGuard.canActivate(ctx(req))).resolves.toBe(true);
    await expect(runChain(req, tenantStatusGuard)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("T1/R2 ImpersonationGuard returns true for every forged bearer shape — unsigned, wrong-secret, expired, and correctly signed", async () => {
    const shapes = [
      unsignedToken(FORGED_CLAIMS),
      new JwtService({ secret: WRONG_SECRET }).sign(FORGED_CLAIMS),
      jwtService.sign(FORGED_CLAIMS, { expiresIn: -10 }),
      jwtService.sign({
        sub: "u1",
        username: "op1",
        role: "OPERATOR",
        status: "ACTIVE",
        tenantId: null,
      }),
    ];
    for (const token of shapes) {
      expect(impersonationGuard.canActivate(ctx(bearer(token)))).toBe(true);
    }
  });
});
