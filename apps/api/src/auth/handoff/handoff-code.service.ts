import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { HandoffRealm } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { hashSignedToken, mintSignedToken, verifySignedToken } from "../../common/signed-token";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * #2653 sign-in handoff (SA-542a/b): the shared core behind BOTH realms' mint + exchange.
 *
 * The native app, already signed in, asks its realm's endpoint for a one-time code
 * (POST /auth/handoff for staff, POST /buyer/auth/handoff for buyers). The in-app WebView then
 * loads the web's /handoff page with the code in the URL FRAGMENT, and the page trades it for a
 * FRESH token pair of its own (POST …/handoff/exchange). Never the app's own pair: refresh rotation
 * would log one side out, or read the reuse as token theft.
 *
 * - The code is `mintSignedToken(HANDOFF_TOKEN_SECRET)`: its HMAC is checked BEFORE any database
 *   read, so a forgery costs zero queries. Only `sha256(code)` is stored.
 * - A code lives 60 s and works once. Consume = read the row (realm-filtered), then ONE
 *   `deleteMany {tokenHash, realm, expiresAt > now}` that must return count 1, so of two racing
 *   exchanges exactly one wins. Nothing is left to purge; minting also clears the subject's
 *   expired rows.
 * - The realm is decided by which guarded endpoint minted the code, never by parsing a JWT. It
 *   sits in every `where`, so a code presented to the other realm's exchange is the same 401 and
 *   writes nothing.
 * - EVERY exchange refusal (forged, unknown, expired, used, wrong realm, ineligible subject,
 *   tenant mismatch) is the SAME 401 HANDOFF_CODE_INVALID, so nothing leaks which check failed.
 */

export const HANDOFF_TOKEN_SECRET_MIN_LENGTH = 32;
export const HANDOFF_TTL_SECONDS = 60;

/** The Prisma enum (mirrored for clients as HANDOFF_REALM_VALUES in @routeflow/types). */
export type { HandoffRealm };

export type HandoffSubject =
  { realm: "STAFF"; userId: string; tenantId: string } | { realm: "BUYER"; buyerAccountId: string };

export interface ConsumedHandoff {
  realm: HandoffRealm;
  userId: string | null;
  buyerAccountId: string | null;
  tenantId: string | null;
  deviceId: string;
}

/** HANDOFF_TOKEN_SECRET when it is long enough to use, else null (the feature is off). */
export function handoffTokenSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = (env.HANDOFF_TOKEN_SECRET ?? "").trim();
  return secret.length >= HANDOFF_TOKEN_SECRET_MIN_LENGTH ? secret : null;
}

/** A mint refused for the caller's kind of session (SUPER_ADMIN, DRIVER, impersonation, …). */
export function handoffRoleNotAllowed(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: API_ERROR_CODES.HANDOFF_ROLE_NOT_ALLOWED,
    message: "In-app sign-in is not available for this account.",
  });
}

/** The one refusal every failed exchange returns. */
export function handoffCodeInvalid(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: API_ERROR_CODES.HANDOFF_CODE_INVALID,
    message: "This sign-in link is invalid or has expired. Sign in again.",
  });
}

@Injectable()
export class HandoffCodeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mint a one-time code for an already-authenticated subject. */
  async mint(
    subject: HandoffSubject,
    deviceId: string,
  ): Promise<{ code: string; expiresIn: number }> {
    const secret = handoffTokenSecret();
    if (!secret) {
      throw new ConflictException({
        statusCode: 409,
        code: API_ERROR_CODES.HANDOFF_NOT_CONFIGURED,
        message: "In-app sign-in is not available yet.",
      });
    }
    const now = new Date();
    const subjectWhere =
      subject.realm === "STAFF"
        ? { userId: subject.userId }
        : { buyerAccountId: subject.buyerAccountId };
    // The subject's expired rows go first, so the table never grows without bound.
    await this.prisma.authHandoffCode.deleteMany({
      where: { realm: subject.realm, ...subjectWhere, expiresAt: { lte: now } },
    });
    const code = mintSignedToken(secret);
    await this.prisma.authHandoffCode.create({
      data: {
        tokenHash: hashSignedToken(code),
        realm: subject.realm,
        userId: subject.realm === "STAFF" ? subject.userId : null,
        buyerAccountId: subject.realm === "BUYER" ? subject.buyerAccountId : null,
        tenantId: subject.realm === "STAFF" ? subject.tenantId : null,
        deviceId,
        expiresAt: new Date(now.getTime() + HANDOFF_TTL_SECONDS * 1000),
      },
    });
    return { code, expiresIn: HANDOFF_TTL_SECONDS };
  }

  /**
   * Consume `code` for `realm`: exactly once, within its TTL, only at its own realm. Any refusal
   * throws handoffCodeInvalid(). A forged or malformed code never touches the database.
   */
  async consume(realm: HandoffRealm, code: unknown): Promise<ConsumedHandoff> {
    const secret = handoffTokenSecret();
    if (!secret || typeof code !== "string" || !verifySignedToken(code, secret)) {
      throw handoffCodeInvalid();
    }
    const tokenHash = hashSignedToken(code);
    const now = new Date();
    const row = await this.prisma.authHandoffCode.findFirst({
      where: { tokenHash, realm, expiresAt: { gt: now } },
      select: { realm: true, userId: true, buyerAccountId: true, tenantId: true, deviceId: true },
    });
    if (!row) throw handoffCodeInvalid();
    const { count } = await this.prisma.authHandoffCode.deleteMany({
      where: { tokenHash, realm, expiresAt: { gt: now } },
    });
    if (count !== 1) throw handoffCodeInvalid();
    return row;
  }
}
