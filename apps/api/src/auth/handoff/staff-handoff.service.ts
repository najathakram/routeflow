import { Injectable } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { AuthService, type DeviceInfo } from "../auth.service";
import type { JwtPayload } from "../jwt-payload.interface";
import { isLoginEligible } from "../login-eligibility";
import { PrismaService } from "../../prisma/prisma.service";
import {
  HandoffCodeService,
  handoffCodeInvalid,
  handoffRoleNotAllowed,
} from "./handoff-code.service";

/** SA-542b: the staff roles that may hand off into the in-app web shell (CUSTOMER is legacy, out). */
export const STAFF_HANDOFF_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  UserRole.OPERATOR,
  UserRole.TENANT_ADMIN,
]);

/** #2653 staff realm: POST /auth/handoff (mint) and POST /auth/handoff/exchange. */
@Injectable()
export class StaffHandoffService {
  constructor(
    private readonly codes: HandoffCodeService,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  /** The caller's own JWT decides the subject; SUPER_ADMIN, DRIVER and impersonation are refused. */
  async mint(user: JwtPayload, deviceId: string) {
    if (user.impersonatedBy || !STAFF_HANDOFF_ROLES.has(user.role) || !user.tenantId) {
      throw handoffRoleNotAllowed();
    }
    return this.codes.mint({ realm: "STAFF", userId: user.sub, tenantId: user.tenantId }, deviceId);
  }

  /**
   * Trade a code for a FRESH staff pair (deviceName "hybrid-shell:<deviceId>"), minted by the
   * same AuthService.login() the password login uses, so the claims snapshot, refresh storage and
   * lastLoginAt stamp are identical. Every refusal is the same 401.
   */
  async exchange(code: unknown, deviceInfo: DeviceInfo) {
    const row = await this.codes.consume("STAFF", code);
    // The raw row (password field included) is what login() documents for a non-password caller:
    // it derives hasPassword from it, and resolves the tenant slug itself.
    const user = row.userId
      ? await this.prisma.user.findUnique({ where: { id: row.userId } })
      : null;
    if (
      !user ||
      !isLoginEligible(user) ||
      !STAFF_HANDOFF_ROLES.has(user.role) ||
      user.tenantId === null ||
      user.tenantId !== row.tenantId
    ) {
      throw handoffCodeInvalid();
    }
    const result = await this.auth.login(user, {
      ...deviceInfo,
      deviceName: `hybrid-shell:${row.deviceId}`,
    });
    return { realm: "STAFF" as const, ...result };
  }
}
