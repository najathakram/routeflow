import { BadRequestException, Injectable } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type {
  StaffCcInvalidDetails,
  StaffEmailSettings,
  UpdateStaffEmailSettingsRequest,
} from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { isInternalEmail } from "../common/internal-email";
import { maskEmail } from "./messaging-deliveries.service";
import { PolicyService, type PolicyActor } from "../policy/policy.service";
import { StaffOrderEmailService, toStaffOrderEmailMode } from "./staff-order-email";
import { requireTenantContext } from "./require-tenant-context";

/** Local literal copy (the API never value-imports `@routeflow/types`); mirrors the shared
 *  `STAFF_CC_MAX`, pinned by the `staff-email-settings` spec and the parity spec. */
export const STAFF_CC_MAX = 5;

/** Same shape the recipient resolver (`staff-order-email.ts`) accepts. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STAFF_CC_KEY = "notifications.staffCc";

/**
 * WS4 (SA-606) — the tenant-visible "Also send to" list behind `GET/PUT
 * /messaging/staff-email-settings`. Stored in the tenant SystemConfig row `notifications.staffCc`
 * as a JSON array string — exactly what `StaffOrderEmailService.resolveRecipients` reads.
 */
@Injectable()
export class StaffEmailSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staffEmail: StaffOrderEmailService,
    private readonly policies: PolicyService,
  ) {}

  async get(role: string): Promise<StaffEmailSettings> {
    const tenantId = requireTenantContext(this.prisma);
    const list = await this.read();
    const isAdmin = role === "TENANT_ADMIN";
    return {
      staffCc: isAdmin ? list : list.map(maskEmail),
      effectiveMode: await this.staffEmail.getEffectiveMode(tenantId),
      policyMode: toStaffOrderEmailMode(
        await this.policies.resolve(tenantId, "notifications.staffOrderEmail", {}),
      ),
      // SA-1063 MUST 12: who gets the email today. Full addresses, TENANT_ADMIN only.
      ...(isAdmin ? { recipients: await this.staffEmail.resolveRecipients(tenantId) } : {}),
    };
  }

  /**
   * `staffCc` replaces the "Also send to" list; `mode` ("on" | "off") is the tenant's choice, written through
   * `PolicyService.set` (append-only, audited as `policy.set`). Any other field is ignored. With neither
   * field the request is the old invalid list (400).
   */
  async update(
    body: UpdateStaffEmailSettingsRequest,
    user?: JwtPayload,
  ): Promise<StaffEmailSettings> {
    const tenantId = requireTenantContext(this.prisma);
    const hasMode = body?.mode !== undefined;
    if (hasMode && body.mode !== "on" && body.mode !== "off") {
      throw new BadRequestException({
        statusCode: 400,
        code: "POLICY_VALUE_INVALID",
        message: 'The staff order email mode must be "on" or "off".',
      });
    }
    if (body?.staffCc !== undefined || !hasMode) {
      const staffCc = this.validate(body?.staffCc);
      const db = this.prisma.forTenant();
      const value = JSON.stringify(staffCc);
      const existing = await db.systemConfig.findFirst({ where: { key: STAFF_CC_KEY } });
      if (existing) {
        await db.systemConfig.update({ where: { id: existing.id }, data: { value } });
      } else {
        await (db.systemConfig.create as any)({ data: { key: STAFF_CC_KEY, value } });
      }
    }
    if (hasMode) {
      await this.policies.set({
        tenantId,
        key: "notifications.staffOrderEmail",
        scopeType: "TENANT",
        scopeId: null,
        value: body.mode,
        reason: `Settings → Notifications: staff order email turned ${body.mode}`,
        actor: actorOf(user),
      });
    }
    return this.get("TENANT_ADMIN");
  }

  private async read(): Promise<string[]> {
    const row = await this.prisma
      .forTenant()
      .systemConfig.findFirst({ where: { key: STAFF_CC_KEY } });
    if (!row?.value) return [];
    try {
      const parsed: unknown = JSON.parse(row.value);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string" && EMAIL_SHAPE.test(v.trim()))
        : [];
    } catch {
      return [];
    }
  }

  private validate(input: unknown): string[] {
    if (!Array.isArray(input)) throw this.invalid({ index: 0, reason: "format" });
    if (input.length > STAFF_CC_MAX) throw this.invalid({ index: 0, reason: "too_many" });
    const seen = new Set<string>();
    const out: string[] = [];
    input.forEach((raw, index) => {
      const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!EMAIL_SHAPE.test(email)) throw this.invalid({ index, reason: "format" });
      if (isInternalEmail(email)) throw this.invalid({ index, reason: "sentinel" });
      if (seen.has(email)) throw this.invalid({ index, reason: "duplicate" });
      seen.add(email);
      out.push(email);
    });
    return out;
  }

  private invalid(details: StaffCcInvalidDetails): BadRequestException {
    return new BadRequestException({
      statusCode: 400,
      code: API_ERROR_CODES.STAFF_CC_INVALID,
      message: "Invalid staff CC list",
      details,
    });
  }
}

function actorOf(user?: JwtPayload): PolicyActor {
  return {
    id: user?.sub ?? null,
    name: user?.username ?? null,
    impersonatedBy: user?.impersonatedBy ?? null,
  };
}
