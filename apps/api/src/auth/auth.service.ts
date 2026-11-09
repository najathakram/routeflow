import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import type { User } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { UsersService } from "../users/users.service";
import { EmailService } from "../email/email.service";
import { newLoginMessage, passwordResetMessage, passwordSetMessage } from "../email/routeflow-mail";
import { OwnerAlertService } from "../email/owner-alert.service";
import { AppConfig } from "../config/configuration";
import { JwtPayload } from "./jwt-payload.interface";
import { EntitlementsService } from "../billing/entitlements.service";
import {
  DERIVED_JWT_AUDIENCES,
  DERIVED_JWT_LABELS,
  derivedJwtKey,
} from "../common/derived-jwt-key";
import { isLoginEligible, isSignInBlocked } from "./login-eligibility";
import {
  claimSignupLink,
  verificationLinkState,
  VERIFICATION_REFUSED,
} from "./verification-link-eligibility";
import { hasForeignAudience, STAFF_ACCESS_AUDIENCE, STAFF_REFRESH_AUDIENCE } from "./session-token";
import { revokeUserEmailChanges, revokeUserLinkTokens } from "./link-token-revocation";
import { hashEmailChangeToken } from "../users/email-change";
import { API_ERROR_CODES } from "../common/api-error-codes";

export interface DeviceInfo {
  userAgent?: string;
  ipAddress?: string;
  deviceName?: string;
}

/**
 * RF-176 / W-767 (SA-917): a staff session with no business is a PLATFORM session, SUPER_ADMIN only. A null-tenantId JWT
 * bypasses every forTenant() scope and can read across businesses. The ONE check, made before EVERY staff token mint in
 * this file (login, refresh, mintSessionForUser): `session-tenant.spec.ts` keeps each sign site behind it.
 */
export function hasSessionTenant(user: { tenantId: string | null; role: string }): boolean {
  return !!user.tenantId || user.role === "SUPER_ADMIN";
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly emailVerifyKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig>,
    private readonly emailService: EmailService,
    private readonly entitlements: EntitlementsService,
    @Optional() private readonly ownerAlerts?: OwnerAlertService,
  ) {
    // Fails the boot on a missing or short secret (see derived-jwt-key.ts).
    this.emailVerifyKey = derivedJwtKey(
      DERIVED_JWT_LABELS.emailVerify,
      configService.get<AppConfig["jwt"]>("jwt")?.secret ?? "",
    );
  }

  /**
   * Validate username + password.
   *
   * RF-176: cross-tenant fallback is only attempted when a tenant header was
   * provided but the user wasn't found in that tenant (e.g. stale cookie).
   * When no tenant header is present (tenantId === null) we skip the fallback
   * entirely — this prevents a null-tenantId JWT that could read across all
   * tenant data via the cross-tenant lookup path.
   */
  async validateUser(username: string, password: string, tenantId: string | null) {
    let user = await this.usersService.findByUsername(username, tenantId);

    // Cross-tenant fallback only when a tenant slug was provided but the user
    // was not found in that specific tenant (e.g. old/stale cookie).
    // Never fall back when tenantId is null (no X-Tenant-Slug sent) — that
    // would allow any tenant user to obtain a null-tenantId JWT (RF-176).
    if (!user && tenantId !== null) {
      if (username.includes("@")) {
        user = await this.usersService.findByEmailCrossTenant(username);
      } else {
        user = await this.usersService.findByUsernameCrossTenant(username);
      }
    }

    // Deleted, or the account lockout: refused WITHOUT running bcrypt (no
    // timing oracle, no counter churn) and with the same null as any bad
    // credential — enumeration-safe. Time-based auto-unlock; TENANT_ADMIN can
    // clear it early via POST /users/:id/unlock. The rule itself lives in
    // login-eligibility.ts (one rule for every sign-in path, #2653).
    if (!user || isSignInBlocked(user)) return null;
    // Google-only accounts have no password
    if (!user.password) return null;
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      await this.recordFailedLogin(user.id, user.failedLoginAttempts, user.lockedUntil);
      return null;
    }
    // Status is checked AFTER the password is verified, not before (it used to
    // run first) — this closes a timing oracle: checking status first meant
    // every non-ACTIVE username short-circuited before bcrypt ran, so response
    // latency alone told an attacker which usernames exist. Running bcrypt
    // unconditionally makes every non-ACTIVE case take the same time as a
    // wrong password (B213). Only reachable with the CORRECT password, so
    // nothing here tells a stranger an account exists.
    //
    // Deliberately generic for EVERY non-ACTIVE status, including INACTIVE:
    // an earlier version of this fix threw a distinguishable EMAIL_NOT_VERIFIED
    // for INACTIVE specifically, on the theory that INACTIVE means "self-signup
    // admin pending email verification" (TenantsService.register). That's not
    // true in general — INACTIVE is the SAME status an admin sets via
    // UsersService.changeStatus (apps/web settings page) to deactivate ANY
    // staff member, and the same status BillingCronService's seat-cap
    // enforcement writes on a plan downgrade. Surfacing EMAIL_NOT_VERIFIED (and
    // a "Resend verification email" affordance) to a deactivated staff member
    // handed them a path back to ACTIVE via TenantsService.resendVerification +
    // verifyEmailAndLogin below — a self-reactivation hole caught in review.
    // UserStatus alone does not tell "never verified" from "deliberately
    // deactivated"; the sign-up link is gated by a live UserEmailVerificationToken
    // row instead (B448, verification-link-eligibility.ts), which every
    // deactivation burns. Login stays generic for every non-ACTIVE status.
    if (!isLoginEligible(user)) return null;
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
    const { password: _pw, ...result } = user;
    return result;
  }

  /**
   * #2159 S1: stamp `User.lastLoginAt` on every interactive session mint (password, Google,
   * email-verification, set/change password) — the onboarding "admin / drivers have signed in"
   * checks read it. Best-effort: a failed stamp never blocks a sign-in. Platform impersonation
   * mints its own tokens elsewhere and deliberately does not come through here.
   */
  private async touchLastLogin(userId: string): Promise<void> {
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    } catch (err) {
      this.logger.warn(`lastLoginAt stamp failed for user ${userId}: ${(err as Error).message}`);
    }
  }

  /** 10 consecutive failures → 15-minute lock. The per-IP login throttle
   *  (10/5min) bites first for single-IP attackers; this is layered defense
   *  against distributed guessing, tuned to avoid locking out real staff. */
  static readonly LOCKOUT_THRESHOLD = 10;
  static readonly LOCKOUT_WINDOW_MS = 15 * 60_000;

  private async recordFailedLogin(userId: string, priorFailures: number, lockedUntil: Date | null) {
    // An expired lock starts a fresh streak (otherwise one failure re-locks).
    const lockExpired = lockedUntil != null && lockedUntil <= new Date();
    const attempts = lockExpired ? 1 : (priorFailures || 0) + 1;
    const lockNow = attempts >= AuthService.LOCKOUT_THRESHOLD;
    await this.prisma.user.update({
      where: { id: userId },
      data: lockNow
        ? {
            failedLoginAttempts: 0,
            lockedUntil: new Date(Date.now() + AuthService.LOCKOUT_WINDOW_MS),
          }
        : { failedLoginAttempts: attempts, ...(lockExpired ? { lockedUntil: null } : {}) },
    });
  }

  async login(
    user: NonNullable<Awaited<ReturnType<AuthService["validateUser"]>>>,
    deviceInfo?: DeviceInfo,
  ) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    // RF-176: reject logins where the user has no tenant association unless the
    // user is a platform-level super-admin.  A null-tenantId JWT bypasses all
    // forTenant() query scoping and can read data across every tenant.
    if (!hasSessionTenant(user)) {
      throw new UnauthorizedException("Tenant not found");
    }
    await this.touchLastLogin(user.id);

    // Fetch tenant slug if user belongs to a tenant
    let tenantSlug: string | null = null;
    if (user.tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { slug: true },
      });
      tenantSlug = tenant?.slug ?? null;
    }

    // validateUser strips `password` before handing the user here, and getting
    // this far via password login proves one exists. Callers that pass a raw
    // user row (legacy Google path, email verification) still carry the field,
    // so respect it when present.
    const hasPassword =
      "password" in user ? !!(user as { password?: string | null }).password : true;

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange,
      tenantId: user.tenantId ?? null,
      tenantSlug,
      isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
      canActAsDriver: user.canActAsDriver,
      hasPassword,
    };

    // Plans & Billing: embed a compact entitlement snapshot (plan/flags/addons/
    // seats/trialEnds) so the client can render plan gates without a round-trip.
    // Server guards still re-resolve from EntitlementsService (the authority).
    const claims = await this.entitlements.claimsFor(payload.tenantId);
    if (claims) Object.assign(payload, claims);

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      audience: STAFF_ACCESS_AUDIENCE,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      // F5-003: tag staff refresh tokens with a realm discriminator so a
      // buyer refresh token can never be replayed on the staff refresh path.
      { sub: user.id, type: "staff" },
      {
        secret: jwtConfig.refreshSecret,
        expiresIn: jwtConfig.refreshExpiresIn as any,
        audience: STAFF_REFRESH_AUDIENCE,
      },
    );

    // RF-228: new-device login notification (minimum viable security measure).
    // Check before storing so we compare against pre-existing tokens only.
    // Full session management (per-device revocation, session listing UI) is a backlog item.
    if (deviceInfo?.userAgent && (user as any).email) {
      const knownCount = await this.prisma.refreshToken.count({
        where: {
          userId: user.id,
          userAgent: deviceInfo.userAgent,
          expiresAt: { gt: new Date() },
        },
      });
      if (knownCount === 0) {
        const deviceName = this.deriveDeviceName(deviceInfo.userAgent);
        const loginTime = new Date().toUTCString();
        // Fire-and-forget — email failures must not block the login response.
        this.emailService
          .send({
            to: (user as any).email as string,
            ...newLoginMessage({
              device: deviceName,
              ip: deviceInfo.ipAddress ?? "unknown",
              time: loginTime,
            }),
            // email-connect-google PR-3: a security notification must never leave from a
            // tenant's own connected mailbox/SMTP — platform sender only.
            senderClass: "platform",
          })
          .catch(() => {});
      }
    }

    await this.storeRefreshToken(user.id, refreshToken, deviceInfo);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        forcePasswordChange: user.forcePasswordChange,
        tenantId: user.tenantId ?? null,
        tenantSlug,
        isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
        canActAsDriver: user.canActAsDriver,
        hasPassword,
      },
    };
  }

  async refresh(incomingToken: string, deviceInfo?: DeviceInfo) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    let payload: { sub: string; type?: string; aud?: unknown };
    try {
      payload = this.jwtService.verify(incomingToken, {
        secret: jwtConfig.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    // F5-003: enforce the realm discriminator when present. A token explicitly
    // typed for another realm (e.g. a buyer refresh token) is rejected here.
    // Legacy tokens issued before this change carry no `type` — allow them
    // (grace) so live sessions are never force-logged-out. Defense-in-depth on
    // top of the per-table hash lookup below.
    if (payload.type && payload.type !== "staff") {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }
    // A refresh token that names an audience must name this realm's; one with no `aud`
    // (minted before audiences existed) is still accepted.
    // Remove in PR-4a; strict refresh is safe only 30 days after deploy.
    // The staff refresh path re-derives role and tenant from the database row; the audience
    // does not separate platform-admin from tenant sessions.
    if (hasForeignAudience(payload, STAFF_REFRESH_AUDIENCE)) {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const tokenHash = this.hashToken(incomingToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.userId !== payload.sub || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token revoked or expired");
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    // W-767 (SA-917): login's RF-176 rule too — a user with no business renews only as a SUPER_ADMIN.
    if (!user || user.status !== "ACTIVE" || user.deletedAt || !hasSessionTenant(user)) {
      // B155: the old delete-then-check ordering consumed the token here too —
      // keep that, or a suspended user's row survives in listSessions.
      await this.prisma.refreshToken.deleteMany({ where: { tokenHash } });
      throw new UnauthorizedException("Account unavailable");
    }

    let tenantSlug: string | null = null;
    if (user.tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { slug: true },
      });
      tenantSlug = tenant?.slug ?? null;
    }

    const newPayload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange,
      tenantId: user.tenantId ?? null,
      tenantSlug,
      isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
      canActAsDriver: user.canActAsDriver,
      hasPassword: !!user.password,
    };

    // Plans & Billing: refresh re-snapshots entitlement claims into the token.
    const claims = await this.entitlements.claimsFor(newPayload.tenantId);
    if (claims) Object.assign(newPayload, claims);

    const accessToken = this.jwtService.sign(newPayload, {
      secret: jwtConfig.secret,
      audience: STAFF_ACCESS_AUDIENCE,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      // F5-003: realm discriminator (rotated token).
      // B155: `jti` is what makes each rotated token UNIQUE. Without it the payload is
      // only {sub, type} plus jsonwebtoken's iat/exp at one-second resolution, so two
      // sessions of the SAME user rotating inside one second mint byte-identical tokens
      // and therefore the same sha256 `tokenHash` — a `@unique` column. The old code
      // wrote it through `upsert`, whose update branch silently absorbed the duplicate
      // (merging the two sessions); the compare-and-swap below would instead raise P2002
      // and 500 the refresh, which every client treats as a dead session.
      { sub: user.id, type: "staff", jti: crypto.randomUUID() },
      {
        secret: jwtConfig.refreshSecret,
        expiresIn: jwtConfig.refreshExpiresIn as any,
        audience: STAFF_REFRESH_AUDIENCE,
      },
    );

    // B155: rotate IN PLACE. The old code deleted the row and upserted a NEW one
    // (a new id + createdAt every ~15 min), so Active Sessions showed the last
    // rotation as "Signed in" and Revoke-by-listed-id 403'd after any rotation.
    // Compare-and-swap on { id, oldHash }: the update IS the invalidation of the
    // old token. `id`/`createdAt`/`userId` are never written.
    const now = new Date();
    const newTokenHash = this.hashToken(refreshToken);
    const newExpiresAt = new Date(this.jwtService.decode(refreshToken).exp * 1000);
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, tokenHash: stored.tokenHash },
      data: {
        tokenHash: newTokenHash,
        expiresAt: newExpiresAt,
        lastUsedAt: now,
        // Only overwrite device columns when the caller supplied them (mirrors the
        // old upsert's `update` branch); `undefined` leaves a column untouched.
        userAgent: deviceInfo?.userAgent,
        ipAddress: deviceInfo?.ipAddress,
        deviceName: deviceInfo?.deviceName,
      },
    });

    if (count === 0) {
      // Lost a concurrent-rotation race: another refresh of the same token already
      // swapped the hash. Preserve the old tolerance (the deleteMany comment's
      // "avoids P2025 on race") — give the loser a fresh row so BOTH refreshes
      // succeed exactly as before.
      const effectiveDeviceInfo: DeviceInfo = deviceInfo ?? {
        userAgent: stored.userAgent ?? undefined,
        ipAddress: stored.ipAddress ?? undefined,
        deviceName: stored.deviceName ?? undefined,
      };
      await this.storeRefreshToken(user.id, refreshToken, effectiveDeviceInfo);
    }

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        forcePasswordChange: user.forcePasswordChange,
        tenantId: user.tenantId ?? null,
        tenantSlug,
        isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
        canActAsDriver: user.canActAsDriver,
        hasPassword: !!user.password,
      },
    };
  }

  async logout(userId: string) {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
    return { message: "Logged out successfully" };
  }

  // ─── Session management ────────────────────────────────────────────────────────

  async listSessions(userId: string) {
    const sessions = await this.prisma.refreshToken.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        userAgent: true,
        ipAddress: true,
        deviceName: true,
      },
    });
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      deviceName: s.deviceName ?? this.deriveDeviceName(s.userAgent),
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.refreshToken.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new ForbiddenException("Session not found");
    }
    await this.prisma.refreshToken.delete({ where: { id: sessionId } });
    return { message: "Session revoked" };
  }

  // ─── Email verification ────────────────────────────────────────────────────────

  /**
   * Verifies a self-service signup email token, activates the user, and
   * returns a full auth token pair so the frontend can auto-log in.
   */
  async verifyEmailAndLogin(token: string, deviceInfo?: DeviceInfo) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    let payload: { sub: string; type: string; tenantId: string; aud?: unknown; jti?: unknown };
    try {
      payload = this.jwtService.verify(token, {
        secret: this.emailVerifyKey,
        audience: DERIVED_JWT_AUDIENCES.emailVerify,
      });
    } catch {
      // Links issued before per-purpose keys were signed with the session secret and carry no
      // audience; they stay valid for their own 24h and nothing else is accepted that way.
      // remove in PR-4a (token audience required), added 2026-10-07
      try {
        payload = this.jwtService.verify(token, { secret: jwtConfig.secret });
        if (payload.aud !== undefined) throw new Error("audience on a legacy-key token");
      } catch {
        throw new BadRequestException(
          "Verification link is invalid or has expired. Please sign up again or request a new link.",
        );
      }
    }

    if (payload.type !== "email_verify") {
      throw new BadRequestException("Invalid verification token.");
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) {
      throw new BadRequestException("Account not found.");
    }

    // Only a signup admin that has never signed in and still holds a live sign-up link may be activated by this
    // link; every other account is refused with one coded, reason-free answer (see verification-link-eligibility).
    // B448: a link row is the only thing that tells a pending sign-up from an admin another admin deactivated.
    const linkState = await verificationLinkState(this.prisma, user);
    const linkId = typeof payload.jti === "string" && payload.jti ? payload.jti : null;
    if (linkState === "none" || (linkState === "live" && !linkId)) {
      throw new BadRequestException({ ...VERIFICATION_REFUSED });
    }
    // Claim the link, then the activation, atomically (a second concurrent use loses either claim) and record it in
    // the same transaction, so a failed audit write rolls the activation back. A legacy account (no link row was
    // ever written for it) has nothing to claim; its status CAS is the only claim.
    const claimed = await this.prisma.tenantTransaction(async (tx) => {
      // One lock order with resend and deactivation: the User row first, then its link rows. Taking the link row
      // first would invert it and let a click racing a resend or a deactivation deadlock (40P01).
      await tx.$executeRaw`SELECT 1 FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      if (linkId && !(await claimSignupLink(tx, user.id, linkId))) return false;
      const res = await tx.user.updateMany({
        where: { id: user.id, status: "INACTIVE", lastLoginAt: null },
        data: { status: "ACTIVE" },
      });
      if (res.count !== 1) return false;
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId ?? null,
          userId: user.id,
          action: "user.activate",
          entityType: "User",
          entityId: user.id,
          meta: { reason: "email_verify" },
        },
      });
      return true;
    });
    if (!claimed) {
      throw new BadRequestException({ ...VERIFICATION_REFUSED });
    }
    const activeUser = { ...user, status: "ACTIVE" as const };
    // W1 (COPY 2q): tell the owner a trial is live. Best-effort and never awaited into the sign-in.
    if (user.tenantId)
      this.ownerAlerts?.trialVerified(user.tenantId, user.email)?.catch(() => undefined);

    const { password: _pw, ...safeUser } = activeUser;
    return this.login(safeUser, deviceInfo);
  }

  // ─── Login email change (B461, SA-1116) ───────────────────────────────────────

  /**
   * POST /auth/confirm-email-change. The NEW mailbox proves itself with the link, and only then does the account's
   * email change. ONE transaction: find the live, unexpired row by the hash of the token, lock the user row first (the
   * lock order of every other writer, B448), claim the row, then write the email behind a compare-and-set on the
   * address the request was made against (the account must still be ACTIVE, not deleted, and still hold that address),
   * and burn the account's other links. Any failed step throws inside the transaction, so nothing is written and the
   * row stays as it was. The `@@unique([tenantId, email])` index decides a race for the new address: P2002 is
   * `EMAIL_TAKEN`. A used, expired, unknown or superseded link and a moved address all answer the one coded
   * `EMAIL_CHANGE_LINK_INVALID`. Plain `$transaction` with raw SQL for the token table (no `tenantId` column, SA-1096).
   */
  async confirmEmailChange(token: string): Promise<{ email: string }> {
    const refused = () =>
      new BadRequestException({
        code: API_ERROR_CODES.EMAIL_CHANGE_LINK_INVALID,
        message: "This link is invalid or has expired.",
      });
    const now = new Date();
    const tokenHash = hashEmailChangeToken(typeof token === "string" ? token : "");
    let change: { userId: string; fromEmail: string; toEmail: string; username: string };
    try {
      // A plain transaction on purpose: the tenant guard only sees forTenant()/tenantTransaction, so this is never reported.
      change = await this.prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<
          { id: string; userId: string; fromEmail: string; toEmail: string; username: string }[]
        >`SELECT c."id", c."userId", c."fromEmail", c."toEmail", u."username"
          FROM "UserEmailChange" c JOIN "User" u ON u."id" = c."userId"
          WHERE c."tokenHash" = ${tokenHash} AND c."usedAt" IS NULL AND c."expiresAt" > ${now}`;
        if (!row) throw refused();
        await tx.$executeRaw`SELECT 1 FROM "User" WHERE id = ${row.userId} FOR UPDATE`;
        const claimed =
          await tx.$executeRaw`UPDATE "UserEmailChange" SET "usedAt" = ${now} WHERE "id" = ${row.id} AND "usedAt" IS NULL AND "expiresAt" > ${now}`;
        if (claimed !== 1) throw refused();
        const res = await tx.user.updateMany({
          where: { id: row.userId, email: row.fromEmail, status: "ACTIVE", deletedAt: null },
          data: { email: row.toEmail, emailVerifiedAt: now },
        });
        if (res.count !== 1) throw refused();
        await revokeUserLinkTokens(tx, row.userId);
        return row;
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException({
          code: API_ERROR_CODES.EMAIL_TAKEN,
          message: "This address is already used by another account.",
        });
      }
      throw err;
    }

    // Best-effort notices, after the commit: the old address learns the change was made, the new one that it is now
    // the login email. A delivery failure never undoes the change.
    try {
      const old = await this.emailService.sendEmailChangedNotice({
        to: change.fromEmail,
        username: change.username,
        newEmail: change.toEmail,
      });
      if (!old.delivered) {
        this.logger.error(
          `Email-changed notice NOT delivered to the old address for user ${change.userId}.`,
        );
      }
      const added = await this.emailService.sendEmailChangeConfirmation({
        to: change.toEmail,
        username: change.username,
      });
      if (!added.delivered) {
        this.logger.error(
          `Email-change confirmation NOT delivered to the new address for user ${change.userId}.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to send email-change notices for user ${change.userId}: ${(err as Error).message}`,
      );
    }
    return { email: change.toEmail };
  }

  // ─── Password reset (RF-018) ──────────────────────────────────────────────────

  /**
   * Generates a single-use password reset token and emails a link to the user.
   * Always returns the same shape to prevent email enumeration.
   */
  async requestPasswordReset(
    email: string,
    surface: "web" | "mobile" = "mobile",
  ): Promise<{ message: string }> {
    const MSG = { message: "If that address is registered you will receive a reset link shortly." };

    // Look up user by email (cross-tenant safe — find first active match)
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase(), deletedAt: null, status: "ACTIVE" },
    });
    if (!user) return MSG;

    // Raw 32-byte random token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // Clean up any previous unexpired tokens for this user to avoid table bloat
    await this.prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    });

    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    // The base URL is resolved strictly server-side from config — accepting a
    // client-supplied URL here would let an attacker exfiltrate reset tokens.
    const urls = this.configService.get<AppConfig["urls"]>("urls")!;
    // 2026-11-04: the old Expo mobile-web build only redirects now, so every surface (native app
    // included) links to the current website's /reset-password page.
    void surface;
    const base = urls.web;
    const resetUrl = `${base}/reset-password?token=${rawToken}`;

    // B212-class fix: this used to be fire-and-forget with the result
    // discarded (`.catch(() => {})`) — a real delivery failure had zero trace
    // anywhere but "user says they never got the email". Still fire-and-forget
    // (NOT awaited): the response text is the SAME fixed, enumeration-safe
    // message regardless of delivery outcome, and awaiting the send here would
    // make a registered address cost an extra SMTP/Resend round-trip that an
    // unknown address never pays for — a timing oracle on the one endpoint
    // whose whole contract is enumeration safety (review finding on PR #778).
    // The attempt is logged, just never blocks the response.
    const resetMail = passwordResetMessage({ resetUrl });
    this.emailService
      .send({
        to: email,
        subject: resetMail.subject,
        html: resetMail.html,
        text: resetMail.text,
        // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
        senderClass: "platform",
      })
      .then((sendResult) => {
        if (!sendResult.delivered) {
          this.logger.error(
            `Password reset email NOT delivered for user ${user.id} (${email}) — ` +
              `transport=${sendResult.transport} ` +
              `error=${sendResult.error ?? sendResult.smtpFallbackReason ?? "unknown"}.`,
          );
        }
      })
      .catch((err: Error) => {
        this.logger.error(
          `Failed to send password reset email for user ${user.id} (${email}): ${err.message}`,
        );
      });

    return MSG;
  }

  /**
   * Validates a reset token, updates the user's password, and invalidates all
   * existing refresh tokens so active sessions are force-logged-out.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const tokenHash = this.hashToken(token);
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    if (!record) throw new BadRequestException("Reset link is invalid or has already been used.");
    if (record.usedAt) throw new BadRequestException("Reset link has already been used.");
    if (record.expiresAt < new Date()) throw new BadRequestException("Reset link has expired.");

    const newHash = await bcrypt.hash(newPassword, 10);

    // F03 slice 2 (SA-1096): claim the link atomically. The account row is locked FIRST (the writers' order:
    // users.service takes user rows, then revokes links), so a reset and a deactivate serialize instead of
    // deadlocking; then the token is claimed with its own predicate, so two concurrent clicks cannot both win.
    // A non-active or deleted account is refused AFTER the claim commits (a throw here would roll the claim back):
    // the link is spent either way, so reactivating the account never revives it.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const [account] = await tx.$queryRaw<{ status: string; deletedAt: Date | null }[]>`
        SELECT "status", "deletedAt" FROM "User" WHERE id = ${record.userId} FOR UPDATE`;
      const claim = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claim.count !== 1) return "refused" as const;
      if (!account || account.deletedAt || account.status !== "ACTIVE") return "refused" as const;
      await tx.user.update({
        where: { id: record.userId },
        data: { password: newHash, forcePasswordChange: false },
      });
      await tx.refreshToken.deleteMany({ where: { userId: record.userId } });
      // B461: a reset also kills a pending login-email change, one requested from a stolen session included.
      await revokeUserEmailChanges(tx, record.userId);
      return "done" as const;
    });
    // One answer for a spent link and a link on an account that cannot sign in: nothing about the account.
    if (outcome === "refused") {
      throw new BadRequestException("Reset link is invalid or has already been used.");
    }

    return { message: "Password reset successfully. Please log in with your new password." };
  }

  /**
   * Hash a raw token with SHA-256 for storage — same helper used for refresh tokens.
   * Exported for unit testing.
   */
  hashTokenPublic(token: string): string {
    return this.hashToken(token);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    // W-767 (SA-924): login's RF-176 rule BEFORE any write; mintSessionForUser checks again before it mints.
    if (!hasSessionTenant(user)) throw new UnauthorizedException("Tenant not found");

    if (!user.password)
      throw new BadRequestException("This account uses Google sign-in and has no password");

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new BadRequestException("Current password is incorrect");

    const sameAsOld = await bcrypt.compare(newPassword, user.password);
    if (sameAsOld) throw new BadRequestException("New password must differ from current password");

    const newHash = await bcrypt.hash(newPassword, 10);
    // One transaction: the password write, the burn of its links and of a pending email change (B461) land together.
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: userId },
        data: { password: newHash, forcePasswordChange: false },
      });
      // N2 review fix: a 72h staff-invite/admin-reset set-password link must not
      // outlive the user changing their own password through a different path.
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await revokeUserEmailChanges(tx, userId);
      return row;
    });

    const tokens = await this.mintSessionForUser(updated);

    return {
      message: "Password changed successfully. All other sessions have been invalidated.",
      ...tokens,
    };
  }

  /**
   * First-password setup for a signed-in account that has none (Google-only
   * sign-ins). Refuses when a password already exists — overwriting one
   * requires the current-password proof in changePassword. The NULL check runs
   * against the database, never a JWT claim, so a stale token can't authorize
   * a takeover.
   */
  async setPassword(userId: string, newPassword: string, deviceInfo?: DeviceInfo) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    // W-767 (SA-924): login's RF-176 rule BEFORE any write; mintSessionForUser checks again before it mints.
    if (!hasSessionTenant(user)) throw new UnauthorizedException("Tenant not found");

    if (user.password)
      throw new BadRequestException(
        "This account already has a password — use change password instead",
      );

    const newHash = await bcrypt.hash(newPassword, 10);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: userId },
        data: { password: newHash, forcePasswordChange: false },
      });
      // N2 review fix: same invalidation as changePassword — a 72h staff-invite/
      // admin-reset set-password link must not outlive this mutation either.
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await revokeUserEmailChanges(tx, userId);
      return row;
    });

    const tokens = await this.mintSessionForUser(updated, deviceInfo);

    if (user.email) {
      // Fire-and-forget — email failures must not block the mutation.
      this.emailService
        .send({
          to: user.email,
          ...passwordSetMessage({
            portal: false,
            ip: deviceInfo?.ipAddress ?? "unknown",
            time: new Date().toUTCString(),
          }),
          // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
          senderClass: "platform",
        })
        .catch(() => {});
    }

    return {
      message: "Password set successfully. All other sessions have been invalidated.",
      ...tokens,
    };
  }

  /**
   * Revoke every refresh token for the user, then mint a fresh access+refresh
   * pair from current DB state — the shared tail of changePassword/setPassword.
   * The caller's JWT immediately reflects the mutation (forcePasswordChange,
   * hasPassword) while every other session dies.
   */
  private async mintSessionForUser(user: User, deviceInfo?: DeviceInfo) {
    // W-767 (SA-917): login's RF-176 rule, before anything is revoked or minted.
    if (!hasSessionTenant(user)) throw new UnauthorizedException("Tenant not found");
    await this.prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await this.touchLastLogin(user.id);

    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    let tenantSlug: string | null = null;
    if (user.tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { slug: true },
      });
      tenantSlug = tenant?.slug ?? null;
    }

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange,
      tenantId: user.tenantId ?? null,
      tenantSlug,
      isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
      canActAsDriver: user.canActAsDriver,
      hasPassword: !!user.password,
    };

    // Plans & Billing: re-snapshot entitlement claims into the fresh token.
    const claims = await this.entitlements.claimsFor(payload.tenantId);
    if (claims) Object.assign(payload, claims);

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      audience: STAFF_ACCESS_AUDIENCE,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: user.id, type: "staff" }, // F5-003: realm discriminator (force-refresh)
      {
        secret: jwtConfig.refreshSecret,
        expiresIn: jwtConfig.refreshExpiresIn as any,
        audience: STAFF_REFRESH_AUDIENCE,
      },
    );

    await this.storeRefreshToken(user.id, refreshToken, deviceInfo);

    return { accessToken, refreshToken };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private async storeRefreshToken(userId: string, token: string, deviceInfo?: DeviceInfo) {
    const tokenHash = this.hashToken(token);
    const decoded = this.jwtService.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.refreshToken.upsert({
      where: { tokenHash },
      create: {
        userId,
        tokenHash,
        expiresAt,
        lastUsedAt: new Date(),
        userAgent: deviceInfo?.userAgent ?? null,
        ipAddress: deviceInfo?.ipAddress ?? null,
        deviceName: deviceInfo?.deviceName ?? null,
      },
      update: {
        expiresAt,
        lastUsedAt: new Date(),
        userAgent: deviceInfo?.userAgent ?? undefined,
        ipAddress: deviceInfo?.ipAddress ?? undefined,
        deviceName: deviceInfo?.deviceName ?? undefined,
      },
    });
  }

  /** Derive a human-readable device name from the User-Agent string */
  private deriveDeviceName(ua: string | null | undefined): string {
    if (!ua) return "Unknown device";
    if (/iPhone|iPad|iOS/i.test(ua)) return "iPhone / iPad";
    if (/Android/i.test(ua)) return "Android device";
    if (/Windows/i.test(ua)) return "Windows PC";
    if (/Macintosh|Mac OS/i.test(ua)) return "Mac";
    if (/Linux/i.test(ua)) return "Linux PC";
    return "Unknown device";
  }
}
