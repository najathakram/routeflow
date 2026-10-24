import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { isLoginEligible } from "../auth/login-eligibility";
import {
  HandoffCodeService,
  handoffCodeInvalid,
  handoffRoleNotAllowed,
} from "../auth/handoff/handoff-code.service";
import { BuyerAuthService, type BuyerDeviceInfo } from "./buyer-auth.service";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";

/**
 * #2653 buyer realm (SA-542b): POST /buyer/auth/handoff (mint) and POST /buyer/auth/handoff/exchange.
 * The buyer JWT has no tenant claim (an account spans sellers), so the code is bound to the
 * BuyerAccount alone (tenantId NULL). The shell may append a public `&seller=<slug>` to the
 * fragment for continuity; the web page applies it the way the seller switch does.
 */
@Injectable()
export class BuyerHandoffService {
  constructor(
    private readonly codes: HandoffCodeService,
    private readonly prisma: PrismaService,
    private readonly buyerAuth: BuyerAuthService,
  ) {}

  async mint(buyer: BuyerJwtPayload, deviceId: string) {
    if (buyer.impersonatedBy) throw handoffRoleNotAllowed();
    return this.codes.mint({ realm: "BUYER", buyerAccountId: buyer.sub }, deviceId);
  }

  /** A FRESH buyer pair via the same issuer the password login uses. Every refusal: one 401. */
  async exchange(code: unknown, deviceInfo: BuyerDeviceInfo) {
    const row = await this.codes.consume("BUYER", code);
    const account = row.buyerAccountId
      ? await this.prisma.buyerAccount.findUnique({ where: { id: row.buyerAccountId } })
      : null;
    if (!isLoginEligible(account)) throw handoffCodeInvalid();
    const result = await this.buyerAuth.issueHandoffPair(account, {
      ...deviceInfo,
      deviceName: `hybrid-shell:${row.deviceId}`,
    });
    return { realm: "BUYER" as const, ...result };
  }
}
