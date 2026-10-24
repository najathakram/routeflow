import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { InventorySettings, UpdateInventorySettingsRequest } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PolicyService, type PolicyActor } from "../policy/policy.service";
import {
  BUYER_BACKORDER_VISIBILITY_MODES,
  BUYER_OVERSELL_MODES,
  type BuyerBackorderVisibility,
  type BuyerOversellMode,
} from "../policy/policy-registry";
import { PrismaService } from "../prisma/prisma.service";
import { requireTenantContext } from "./require-tenant-context";

export const INVENTORY_SETTINGS_DEFAULT_REASON = "Changed in Settings → Inventory & ordering";
export const INVENTORY_SETTINGS_INVALID_MESSAGE = 'buyerOversell must be "off" or "backorder".';
export const INVENTORY_VISIBILITY_INVALID_MESSAGE =
  'buyerBackorderVisibility must be "show" or "hide".';
const REASON_MAX = 500;

/**
 * Typed Settings → Inventory & ordering over the policy registry. The tenant-scope value of
 * `orders.buyerOversell` is read through `PolicyService.resolve` and written ONLY through
 * `PolicyService.set` (append-only, audited as `policy.set`); this service owns no storage.
 */
@Injectable()
export class SettingsInventoryService {
  constructor(
    @Inject(PolicyService) private readonly policies: PolicyService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async get(): Promise<InventorySettings> {
    const tenantId = requireTenantContext(this.prisma);
    const raw = await this.policies.resolve(tenantId, "orders.buyerOversell", {});
    const visibility = await this.policies.resolve(tenantId, "orders.buyerBackorderVisibility", {});
    return {
      buyerOversell: toMode(raw),
      buyerBackorderVisibility: toVisibility(visibility),
      customerOverrides: await this.countOverrides(tenantId),
    };
  }

  /**
   * Active CUSTOMER-scope rows for the key: a customer pinned to a different value than the tenant
   * default, so the screen can never read "off" while some customers can still backorder.
   */
  private async countOverrides(tenantId: string): Promise<number> {
    const rows = await this.policies.listActive(tenantId);
    return rows.filter((r) => r.key === "orders.buyerOversell" && r.scopeType === "CUSTOMER")
      .length;
  }

  async update(body: unknown, user: JwtPayload): Promise<InventorySettings> {
    const tenantId = requireTenantContext(this.prisma);
    const { buyerOversell, buyerBackorderVisibility, reason } = parseUpdate(body);
    const writes: Array<[string, string]> = [];
    if (buyerOversell !== undefined) writes.push(["orders.buyerOversell", buyerOversell]);
    if (buyerBackorderVisibility !== undefined) {
      writes.push(["orders.buyerBackorderVisibility", buyerBackorderVisibility]);
    }
    for (const [key, value] of writes) {
      await this.policies.set({
        tenantId,
        key,
        scopeType: "TENANT",
        scopeId: null,
        value,
        reason,
        actor: actorOf(user),
      });
    }
    return this.get();
  }
}

/** Fail closed: anything but a known mode reads as "off". */
function toMode(raw: unknown): BuyerOversellMode {
  return (BUYER_OVERSELL_MODES as readonly unknown[]).includes(raw)
    ? (raw as BuyerOversellMode)
    : "off";
}

/** Fail closed to today's behaviour: anything but a known mode reads as "show". */
function toVisibility(raw: unknown): BuyerBackorderVisibility {
  return (BUYER_BACKORDER_VISIBILITY_MODES as readonly unknown[]).includes(raw)
    ? (raw as BuyerBackorderVisibility)
    : "show";
}

function invalid(
  field: "buyerOversell" | "buyerBackorderVisibility" | "reason",
  message: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: API_ERROR_CODES.INVENTORY_SETTING_INVALID,
    message,
    details: { field },
  });
}

/**
 * Extra fields are ignored. At least one of `buyerOversell` / `buyerBackorderVisibility` must be
 * present, and each present one must be exactly a known mode.
 */
function parseUpdate(body: unknown): {
  buyerOversell?: BuyerOversellMode;
  buyerBackorderVisibility?: BuyerBackorderVisibility;
  reason: string;
} {
  const b =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Partial<Record<keyof UpdateInventorySettingsRequest, unknown>>)
      : {};
  if (b.buyerOversell === undefined && b.buyerBackorderVisibility === undefined) {
    throw invalid("buyerOversell", INVENTORY_SETTINGS_INVALID_MESSAGE);
  }
  if (
    b.buyerOversell !== undefined &&
    !(BUYER_OVERSELL_MODES as readonly unknown[]).includes(b.buyerOversell)
  ) {
    throw invalid("buyerOversell", INVENTORY_SETTINGS_INVALID_MESSAGE);
  }
  if (
    b.buyerBackorderVisibility !== undefined &&
    !(BUYER_BACKORDER_VISIBILITY_MODES as readonly unknown[]).includes(b.buyerBackorderVisibility)
  ) {
    throw invalid("buyerBackorderVisibility", INVENTORY_VISIBILITY_INVALID_MESSAGE);
  }
  let reason = INVENTORY_SETTINGS_DEFAULT_REASON;
  if (b.reason !== undefined && b.reason !== null) {
    if (typeof b.reason !== "string") throw invalid("reason", "reason must be text.");
    const trimmed = b.reason.trim();
    if (trimmed.length > REASON_MAX) {
      throw invalid("reason", `reason must be at most ${REASON_MAX} characters.`);
    }
    if (trimmed) reason = trimmed;
  }
  return {
    ...(b.buyerOversell !== undefined
      ? { buyerOversell: b.buyerOversell as BuyerOversellMode }
      : {}),
    ...(b.buyerBackorderVisibility !== undefined
      ? { buyerBackorderVisibility: b.buyerBackorderVisibility as BuyerBackorderVisibility }
      : {}),
    reason,
  };
}

function actorOf(user: JwtPayload): PolicyActor {
  return {
    id: user.sub ?? null,
    name: user.username ?? null,
    impersonatedBy: user.impersonatedBy ?? null,
  };
}
