import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { FulfillPath, OrderStatus, UserRole } from "@prisma/client";
import type {
  FulfilmentChange,
  FulfilmentCounterEffective,
  FulfilmentCounterSetting,
  FulfilmentEffect,
  FulfilmentLastChange,
  FulfilmentMode,
  FulfilmentModeOption,
  FulfilmentPreview,
  FulfilmentSettings,
  FulfilmentSettingsUpdated,
} from "@routeflow/types";
import { createHash } from "crypto";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AddonService } from "../billing/addon.service";
import { FeatureConfigService, fleetNeededConflict } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import {
  FLEET_KEYS,
  capabilityFromInputs,
  isFleetHeld,
  readFulfilmentInputs,
  type FulfilmentInputs,
} from "../billing/fulfilment-capability";
import { underFulfilmentLock } from "../billing/fulfilment-settings-lock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { requireTenantContext } from "../settings-inventory/require-tenant-context";
import { SHIPPING_FULFILMENT_MODES } from "../orders/shipping-fulfilment-modes";
import { canEditFulfilment } from "./fulfilment-edit";
import { resolveFulfilmentSelfServe } from "./fulfilment-self-serve";

export const FULFILMENT_SETTINGS_REASON = "Changed in Settings → Fulfillment";
const MODEL_KEY = "fulfilment_model";
const COUNTER_KEY = "counter_sales";
const CONFIG_KEYS = [MODEL_KEY, COUNTER_KEY];
/** Display order of the delivery-method options. Mirrors `FULFILMENT_MODE_VALUES` (pinned by a spec). */
export const FULFILMENT_OPTION_ORDER: readonly FulfilmentMode[] = [
  "delivery",
  "ship",
  "both",
  "pickup",
  "pickup_ship",
  "unset",
];
const IN_STORE_MODES: readonly string[] = ["pickup", "pickup_ship"];
const CLOSED_ORDER_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.CANCELLED];

interface ParsedBody {
  fulfilmentModel?: FulfilmentMode;
  counterSales?: FulfilmentCounterSetting;
  fingerprint?: string;
}

interface Stored {
  mode: FulfilmentMode;
  /** The raw stored `counter_sales` mode ("on" | "unset"), as written. */
  counterRaw: string;
  counter: FulfilmentCounterSetting;
  rows: Array<{ featureKey: string; mode: string; updatedAt: Date; updatedById: string | null }>;
}

interface Snapshot {
  stored: Stored;
  inputs: FulfilmentInputs & { fleet: boolean };
}

interface RequestContext {
  tenantId: string;
  user: JwtPayload;
  selfServe: { enabled: boolean; pilot: boolean };
}

const invalid = (field: string, message: string) =>
  new BadRequestException({
    statusCode: 400,
    code: API_ERROR_CODES.FULFILMENT_SETTING_INVALID,
    message,
    details: { field },
  });

const registryModes = () => FEATURE_REGISTRY.find((f) => f.key === MODEL_KEY)?.config?.modes ?? {};

const methodWords = { ROUTE: "on your trucks", SHIP: "by carrier", PICKUP: "for pickup" } as const;

/**
 * Settings → Fulfillment (dark behind FULFILMENT_SELF_SERVE): the tenant admin's face over the
 * `fulfilment_model` and `counter_sales` config rows. Reads and the write go through the SAME
 * `FeatureConfigService` the Feature Console uses; the capability the rest of the system reads is
 * derived once, in `billing/fulfilment-capability.ts` (never re-derived here).
 *
 * The change runs: per-tenant lock -> recompute the fingerprint from the STORED rows (never the 30 s
 * per-replica cache) -> 409 if stale -> drop unchanged fields -> carrier-in-transit check inside the
 * transaction -> upsert + awaited audit in ONE transaction -> after the commit, drop the cache entry
 * (other replicas catch up within the store's 30 s TTL, an accepted lag) -> unlock.
 */
@Injectable()
export class SettingsFulfilmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureConfig: FeatureConfigService,
    private readonly store: FeatureConfigStore,
    private readonly addons: AddonService,
    private readonly featureOverrides: FeatureOverrideService,
  ) {}

  // ── context ───────────────────────────────────────────────────────────────────────────────

  /** Tenant from the request context ONLY; the caller's token must be for that tenant. */
  private context(user: JwtPayload): RequestContext {
    const tenantId = requireTenantContext(this.prisma);
    if (user.tenantId !== tenantId) {
      throw new ForbiddenException({
        statusCode: 403,
        message: "This account does not belong to the current tenant.",
      });
    }
    return { tenantId, user, selfServe: resolveFulfilmentSelfServe(user.tenantSlug) };
  }

  private requireSelfServe(ctx: RequestContext): void {
    if (!ctx.selfServe.enabled) {
      throw new ForbiddenException({
        statusCode: 403,
        code: API_ERROR_CODES.FULFILMENT_SELF_SERVE_OFF,
        message: "Fulfillment settings are not available on this account yet.",
      });
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      statusCode: 503,
      code: API_ERROR_CODES.FEATURES_UNAVAILABLE,
      message: "Feature resolution is temporarily unavailable. Please retry.",
    });
  }

  /** The stored rows (direct DB read, tenant scoped) and the inputs the capability derives from. */
  private async snapshot(tenantId: string): Promise<Snapshot> {
    const rows = await this.prisma.tenantFeatureConfig.findMany({
      where: { tenantId, featureKey: { in: CONFIG_KEYS } },
      select: { featureKey: true, mode: true, updatedAt: true, updatedById: true },
    });
    const inputs = await readFulfilmentInputs(
      {
        featureConfig: this.featureConfig,
        addonService: this.addons,
        featureOverrides: this.featureOverrides,
      },
      tenantId,
    );
    // A failed fleet or mode read must not become a guessed answer on a settings screen.
    if (inputs.fleet === null || inputs.modesFailed) throw this.unavailable();

    const model = rows.find((r) => r.featureKey === MODEL_KEY)?.mode;
    const counterRaw = rows.find((r) => r.featureKey === COUNTER_KEY)?.mode ?? "unset";
    const known = FULFILMENT_OPTION_ORDER as readonly string[];
    return {
      stored: {
        mode: (model && known.includes(model) ? model : "unset") as FulfilmentMode,
        counterRaw,
        counter: counterRaw === "on" ? "on" : "off",
        rows,
      },
      inputs: { ...inputs, fleet: inputs.fleet },
    };
  }

  private fingerprintOf(snap: Snapshot): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          fm: snap.stored.mode,
          cs: snap.stored.counter,
          fleet: snap.inputs.fleet,
        }),
      )
      .digest("hex")
      .slice(0, 16);
  }

  private async lastChange(tenantId: string, stored: Stored): Promise<FulfilmentLastChange | null> {
    if (stored.rows.length === 0) return null;
    const latest = stored.rows.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    const at = new Date(latest.updatedAt).toISOString();
    if (!latest.updatedById) return { at, by: "routeflow", name: null };
    const who = await this.prisma.user.findFirst({
      where: { id: latest.updatedById, tenantId },
      select: { username: true, role: true },
    });
    if (!who || who.role === UserRole.SUPER_ADMIN) return { at, by: "routeflow", name: null };
    return { at, by: "business", name: who.username };
  }

  private async options(
    tenantId: string,
    snap: Snapshot,
    pilot: boolean,
  ): Promise<FulfilmentModeOption[]> {
    let allowed: string[];
    try {
      allowed = (await this.featureConfig.getState(tenantId, MODEL_KEY)).allowed;
    } catch {
      throw this.unavailable();
    }
    const modes = registryModes() as Record<
      string,
      { label: string; available: boolean; lifecycle: string }
    >;
    return FULFILMENT_OPTION_ORDER.map((key): FulfilmentModeOption => {
      const def = modes[key];
      const label = def?.label ?? key;
      if (!def || !def.available) return { key, label, selectable: false };
      if (!allowed.includes(key)) return { key, label, selectable: false, blockedBy: "plan" };
      if (def.lifecycle === "proposed" && !pilot) {
        return { key, label, selectable: false, blockedBy: "proposed" };
      }
      return { key, label, selectable: true };
    });
  }

  private async settings(ctx: RequestContext, snap?: Snapshot): Promise<FulfilmentSettings> {
    const s = snap ?? (await this.snapshot(ctx.tenantId));
    const capability = capabilityFromInputs(s.inputs);
    const unavailable =
      (registryModes() as Record<string, { available: boolean }>)[s.inputs.fulfilmentMode]
        ?.available === false;
    const effective = (unavailable ? "unset" : s.inputs.fulfilmentMode) as FulfilmentMode;
    return {
      fulfilmentModel: {
        value: s.stored.mode,
        effective,
        options: await this.options(ctx.tenantId, s, ctx.selfServe.pilot),
      },
      counterSales: { value: s.stored.counter, effective: capability.counter },
      capability,
      selfServe: ctx.selfServe.enabled,
      canEdit: ctx.selfServe.enabled && canEditFulfilment(ctx.user),
      fingerprint: this.fingerprintOf(s),
      lastChange: await this.lastChange(ctx.tenantId, s.stored),
    };
  }

  async get(user: JwtPayload): Promise<FulfilmentSettings> {
    return this.settings(this.context(user));
  }

  // ── body parsing and request validation ───────────────────────────────────────────────────

  /** Unknown body -> typed fields, or a coded 400 naming the field. Extra keys are ignored. */
  private parse(body: unknown, needFingerprint: boolean): ParsedBody {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw invalid("fulfilmentModel", "Send a delivery method and/or counter sales.");
    }
    const b = body as Record<string, unknown>;
    const out: ParsedBody = {};
    if (b.fulfilmentModel !== undefined) {
      if (
        typeof b.fulfilmentModel !== "string" ||
        !(FULFILMENT_OPTION_ORDER as readonly string[]).includes(b.fulfilmentModel)
      ) {
        throw invalid("fulfilmentModel", "That delivery method is not recognised.");
      }
      out.fulfilmentModel = b.fulfilmentModel as FulfilmentMode;
    }
    if (b.counterSales !== undefined) {
      if (b.counterSales !== "on" && b.counterSales !== "off") {
        throw invalid("counterSales", 'Counter sales must be "on" or "off".');
      }
      out.counterSales = b.counterSales;
    }
    if (out.fulfilmentModel === undefined && out.counterSales === undefined) {
      throw invalid("fulfilmentModel", "Send a delivery method and/or counter sales.");
    }
    if (needFingerprint) {
      if (typeof b.fingerprint !== "string" || b.fingerprint.length === 0) {
        throw invalid("fingerprint", "Send the fingerprint from the settings you reviewed.");
      }
      out.fingerprint = b.fingerprint;
    }
    return out;
  }

  /** Registry availability, the in-store pilot rule and the in-store counter rule: no DB needed. */
  private checkRequested(parsed: ParsedBody, pilot: boolean): void {
    const mode = parsed.fulfilmentModel;
    if (mode !== undefined) {
      const def = (
        registryModes() as Record<string, { available: boolean; lifecycle: string } | undefined>
      )[mode];
      if (!def || !def.available) {
        throw invalid("fulfilmentModel", "That delivery method is not available.");
      }
      if (def.lifecycle === "proposed" && !pilot) {
        throw invalid("fulfilmentModel", "That delivery method is not open to this account yet.");
      }
      if (IN_STORE_MODES.includes(mode) && parsed.counterSales !== undefined) {
        throw invalid("counterSales", "In-store businesses always have the counter.");
      }
    }
  }

  /** The state-dependent half: an in-store account's counter is not a switch. */
  private checkAgainstStored(parsed: ParsedBody, stored: Stored): void {
    const resulting = parsed.fulfilmentModel ?? stored.mode;
    if (parsed.counterSales !== undefined && IN_STORE_MODES.includes(resulting)) {
      throw invalid("counterSales", "In-store businesses always have the counter.");
    }
  }

  private changesOf(parsed: ParsedBody, stored: Stored): FulfilmentChange[] {
    const changes: FulfilmentChange[] = [];
    if (parsed.fulfilmentModel !== undefined && parsed.fulfilmentModel !== stored.mode) {
      changes.push({ key: "fulfilmentModel", from: stored.mode, to: parsed.fulfilmentModel });
    }
    if (parsed.counterSales !== undefined && parsed.counterSales !== stored.counter) {
      changes.push({ key: "counterSales", from: stored.counter, to: parsed.counterSales });
    }
    return changes;
  }

  private async requireFleetFor(tenantId: string, mode: string | undefined): Promise<void> {
    if (mode !== "delivery" && mode !== "both") return;
    let held: boolean;
    try {
      held = await isFleetHeld(this.addons, this.featureOverrides, tenantId);
    } catch {
      throw this.unavailable();
    }
    if (!held) throw fleetNeededConflict(MODEL_KEY, mode);
  }

  // ── preview ───────────────────────────────────────────────────────────────────────────────

  async preview(body: unknown, user: JwtPayload): Promise<FulfilmentPreview> {
    const ctx = this.context(user);
    this.requireSelfServe(ctx);
    const parsed = this.parse(body, false);
    this.checkRequested(parsed, ctx.selfServe.pilot);
    await this.requireFleetFor(ctx.tenantId, parsed.fulfilmentModel);

    const snap = await this.snapshot(ctx.tenantId);
    this.checkAgainstStored(parsed, snap.stored);
    const changes = this.changesOf(parsed, snap.stored);
    const fingerprint = this.fingerprintOf(snap);
    if (changes.length === 0) return { changes, effects: [], notChanged: [], fingerprint };

    const effects = await this.effects(ctx.tenantId, snap, parsed, changes);
    const notChanged = await this.notChanged(ctx.tenantId, snap, changes);
    return { changes, effects, notChanged, fingerprint };
  }

  private async effects(
    tenantId: string,
    snap: Snapshot,
    parsed: ParsedBody,
    changes: FulfilmentChange[],
  ): Promise<FulfilmentEffect[]> {
    const { fleet } = snap.inputs;
    const fromMode = snap.stored.mode;
    const toMode = parsed.fulfilmentModel ?? fromMode;
    const toCounterRaw = parsed.counterSales
      ? parsed.counterSales === "on"
        ? "on"
        : "unset"
      : snap.stored.counterRaw;
    // The ONE derivation (billing/fulfilment-capability.ts), fed the before / after inputs.
    const capabilityOf = (mode: string, counterSales: string) =>
      capabilityFromInputs({ fulfilmentMode: mode, counterSales, fleet, modesFailed: false });
    const before = capabilityOf(fromMode, snap.stored.counterRaw);
    const after = capabilityOf(toMode, toCounterRaw);
    const effects: FulfilmentEffect[] = [];
    const modelChanged = changes.some((c) => c.key === "fulfilmentModel");

    if (modelChanged) {
      const open = { notIn: CLOSED_ORDER_STATUSES };
      // Open truck orders stay on their trucks when the account stops offering them.
      if (before.methods.includes("ROUTE") && !after.methods.includes("ROUTE")) {
        const count = await this.prisma.order.count({
          where: { tenantId, fulfillPath: FulfillPath.ROUTE, status: open },
        });
        if (count > 0) {
          effects.push({
            code: "OPEN_ROUTE_ORDERS",
            count,
            text:
              count === 1
                ? "1 open order is still on your delivery routes and will go out as planned."
                : `${count} open orders are still on your delivery routes and will go out as planned.`,
          });
        }
      }
      // Standing orders follow the staff default of the new setup.
      if (before.staffDefault !== after.staffDefault) {
        const count = await this.prisma.orderTemplate.count({
          where: { tenantId, isActive: true },
        });
        if (count > 0) {
          const how = methodWords[after.staffDefault];
          effects.push({
            code: "TEMPLATES_PATH_CHANGES",
            count,
            text:
              count === 1
                ? `1 standing order will create its new orders ${how} from now on.`
                : `${count} standing orders will create their new orders ${how} from now on.`,
          });
        }
      }
      const billedAtShipFrom = SHIPPING_FULFILMENT_MODES.has(fromMode);
      const billedAtShipTo = SHIPPING_FULFILMENT_MODES.has(toMode);
      if (billedAtShipFrom !== billedAtShipTo) {
        const count = await this.prisma.order.count({
          where: { tenantId, fulfillPath: FulfillPath.SHIP, status: open },
        });
        effects.push({
          code: "BILLING_MOMENT",
          count,
          text: billedAtShipTo
            ? "Carrier orders will be invoiced when they ship, not when they are delivered."
            : "Carrier orders will be invoiced when they are delivered, not when they ship.",
        });
      }
      if (JSON.stringify(before.portalMethods) !== JSON.stringify(after.portalMethods)) {
        effects.push({
          code: "PORTAL_CHOICE",
          count: 0,
          text:
            after.portalMethods.length === 0
              ? "Customers will no longer choose a delivery method in the portal."
              : after.portalMethods.length === 1
                ? `Customers' portal orders will go ${methodWords[after.portalMethods[0]]}.`
                : "Customers can choose between your delivery methods in the portal.",
        });
      }
      if (before.staffOpensAs !== after.staffOpensAs) {
        effects.push({
          code: "NEW_ORDER_OPENS",
          count: 0,
          text:
            after.staffOpensAs === "counter"
              ? "New Order will open the counter for your staff."
              : "New Order will open the regular order form again.",
        });
      }
    }

    const wasOff = before.counter === "off";
    const isOff = after.counter === "off";
    if (wasOff && !isOff) {
      effects.push({
        code: "COUNTER_OPENS",
        count: 0,
        text: "Staff can ring up walk-in customers and take payment on one screen.",
      });
    } else if (!wasOff && isOff) {
      effects.push({
        code: "COUNTER_CLOSES",
        count: 0,
        text: "Staff can no longer ring up counter sales. Sales already rung up are kept.",
      });
    }
    return effects;
  }

  private async notChanged(
    tenantId: string,
    snap: Snapshot,
    changes: FulfilmentChange[],
  ): Promise<string[]> {
    const out: string[] = [];
    const model = changes.find((c) => c.key === "fulfilmentModel");
    if (model) {
      out.push(
        "Existing orders keep their delivery method.",
        "Customers keep their saved delivery method.",
      );
    }
    out.push("Routes, drivers and your add-ons are not changed.");
    const ownDelivery = (m: string) => m === "delivery" || m === "both";
    if (model && ownDelivery(model.from) && !ownDelivery(model.to)) {
      const active = await this.addons.getActiveAddons(tenantId);
      const names = FLEET_KEYS.filter((k) => active.includes(k)).map((k) =>
        k === "recurring_routes" ? "Routes" : "Order delivery",
      );
      if (names.length > 0) {
        out.push(
          `You still pay for ${names.join(" and ")}. To stop it, change your plan in Plan & Billing.`,
        );
      }
    }
    return out;
  }

  // ── change ────────────────────────────────────────────────────────────────────────────────

  async update(body: unknown, user: JwtPayload): Promise<FulfilmentSettingsUpdated> {
    const ctx = this.context(user);
    this.requireSelfServe(ctx);
    const parsed = this.parse(body, true);
    this.checkRequested(parsed, ctx.selfServe.pilot);

    return underFulfilmentLock(ctx.tenantId, async () => {
      const snap = await this.snapshot(ctx.tenantId);
      const fingerprint = this.fingerprintOf(snap);
      if (parsed.fingerprint !== fingerprint) {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.FULFILMENT_SETTINGS_STALE,
          message: "Someone changed this a moment ago. Review the new setting and try again.",
          ...(await this.settings(ctx, snap)),
        });
      }
      this.checkAgainstStored(parsed, snap.stored);

      const changes = this.changesOf(parsed, snap.stored);
      if (changes.length === 0) {
        return { ...(await this.settings(ctx, snap)), changed: false };
      }

      const model = changes.find((c) => c.key === "fulfilmentModel");
      const crossesShipping =
        !!model &&
        SHIPPING_FULFILMENT_MODES.has(model.from) !== SHIPPING_FULFILMENT_MODES.has(model.to);
      const actor = {
        userId: user.sub,
        impersonatedBy: user.impersonatedBy ?? null,
        reason: FULFILMENT_SETTINGS_REASON,
      };

      await this.prisma.tenantTransaction(async (tx) => {
        // M1 interim rule: re-pointing the billing moment while a carrier order is in flight would
        // bill it twice or never. Evaluated here, inside the write, under the lock.
        if (crossesShipping) {
          const count = await tx.order.count({
            where: {
              tenantId: ctx.tenantId,
              fulfillPath: FulfillPath.SHIP,
              status: { notIn: CLOSED_ORDER_STATUSES },
              shippedAt: { not: null },
            },
          });
          if (count > 0) {
            throw new ConflictException({
              statusCode: 409,
              code: API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT,
              message:
                "Orders are with the carrier right now. Change the delivery method once they are delivered.",
              count,
            });
          }
        }
        for (const change of changes) {
          const isModel = change.key === "fulfilmentModel";
          const key = isModel ? MODEL_KEY : COUNTER_KEY;
          const from = isModel ? snap.stored.mode : snap.stored.counterRaw;
          const to = isModel ? change.to : change.to === "on" ? "on" : "unset";
          await this.featureConfig.setAuditedInTx(tx, ctx.tenantId, key, to, actor, {
            from,
            to,
            via: "tenant_settings",
            fingerprint,
          });
        }
      });

      // After the commit: drop this replica's cache entry (other replicas catch up within the
      // store's TTL, an accepted lag), still under the lock so the next writer reads fresh.
      for (const change of changes) {
        this.store.invalidate(
          ctx.tenantId,
          change.key === "fulfilmentModel" ? MODEL_KEY : COUNTER_KEY,
        );
      }
      return { ...(await this.settings(ctx)), changed: true };
    });
  }
}
