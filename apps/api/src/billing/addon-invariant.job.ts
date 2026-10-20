import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { LeaderCron } from "../common/cron-lock";
import { EmailService } from "../email/email.service";
import { AdminAuditAction, ADMIN_AUDIT_ENTITY } from "../platform-admin/audit-actions.constant";
import { PrismaService } from "../prisma/prisma.service";
import { addonBillingModeOf, inclusionOf, usd, type AddonSkuDef } from "./addon-inclusion";
import { writeAdminNotice } from "./manual-invoice-notice";
import { PlanCatalogService } from "./plan-catalog.service";
import { inclusionCatalogFor, resolvePlanVersionId } from "./plan-version-pin";
import {
  BILLING_EVENTS,
  addonSkuCode,
  normalizePlanKey,
  planKeyFromEnum,
} from "./plan-catalog.constants";
import { StripeService } from "./stripe.service";

/**
 * SA-788 (b) - the daily add-on invariant: detect, record, alert.
 *
 * Runs at 07:00 UTC over PRODUCTION, not-deleted tenants and READS ONLY, apart from its own claims and alerts. A
 * registry of checks ({@link ADDON_INVARIANTS}; a new invariant is one array entry):
 *   I1  an ACTIVE tenant's add-on went inactive in the window and its latest `addon.state_changed` is missing or
 *       was written by the SYSTEM (a deactivation no owner, admin or tenant made; a missing record is a bypass of the
 *       single writer);
 *   I2  an active, non-comp row at $0 whose SKU the tenant's plan does NOT include, on a STRIPE or MANUAL tenant (a
 *       re-price is owed: SA-786's after-commit failure leftover);
 *   I3  an active, non-comp row that is priced or holds a Stripe item although the tenant's plan INCLUDES the SKU
 *       (billing an included add-on).
 * Every NEW finding (one `BillingNotificationLog` claim per finding, released on a failed send) is logged at ERROR,
 * becomes an in-app notice (`ADDON_INVARIANT_BROKEN`), and - only when `ADDON_INVARIANT_EMAIL=email` and
 * `PLATFORM_ALERT_EMAILS` is set - is listed in ONE email per run. The email is DARK by default (`log`): the owner reads
 * a week of in-app findings first, then flips it on its own deploy day.
 */

/** Past this many findings in one run the rest are not claimed; one notice says the run was truncated. */
export const ADDON_INVARIANT_MAX_FINDINGS_PER_RUN = 200;
/** How far back I1 looks: 24 h plus an overlap for a missed tick. */
export const ADDON_INVARIANT_WINDOW_HOURS = 26;
/** Tenants read per page (one rows query and one events query per page). */
export const ADDON_INVARIANT_PAGE_SIZE = 200;

export type InvariantId = "I1" | "I2" | "I3";

export interface InvariantTenant {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  plan: string | null;
  /** The tenant-side pin: the mirror `resolvePlanVersionId` falls back to when the subscription has none. */
  planVersionId?: string | null;
  subscription: {
    planKey?: string | null;
    planVersionId?: string | null;
    stripeSubId?: string | null;
    externalPayment?: boolean | null;
    couponFull?: boolean | null;
  } | null;
}

export interface InvariantRow {
  id: string;
  tenantId: string;
  addonKey: string;
  sku: string | null;
  active: boolean;
  isComp: boolean;
  quantity: number;
  priceSnapshot: unknown;
  stripeItemId: string | null;
  updatedAt: Date;
}

export interface InvariantContext {
  now: Date;
  windowStart: Date;
  tenants: readonly InvariantTenant[];
  rowsOf(tenantId: string): readonly InvariantRow[];
  /** The latest `addon.state_changed` actor kind per row id inside the window (absent = no record). */
  latestActorKind(rowId: string): string | null | undefined;
  /** The tenant's catalog SKUs (its pinned version), or null when the catalog cannot be resolved. */
  skusOf(tenant: InvariantTenant): readonly AddonSkuDef[] | null;
  planKeyOf(tenant: InvariantTenant): string | null;
  modeOf(tenant: InvariantTenant): "STRIPE" | "MANUAL" | "UNBILLED";
}

export interface InvariantFinding {
  invariant: InvariantId;
  tenantId: string;
  tenantLabel: string;
  slug: string;
  rowId: string;
  addonKey: string;
  sku: string;
  name: string;
  /** `updatedAt` of the row: part of the dedupe key, so a row that changes again is a NEW finding. */
  updatedAt: Date;
  sentence: string;
}

export interface InvariantCheck {
  id: InvariantId;
  run(ctx: InvariantContext): InvariantFinding[];
}

const labelOf = (t: InvariantTenant) => t.name ?? t.slug;
const codeOf = (r: InvariantRow) =>
  addonSkuCode({ sku: r.sku, addonKey: r.addonKey }) ?? r.addonKey;

function finding(
  invariant: InvariantId,
  t: InvariantTenant,
  r: InvariantRow,
  name: string,
  sentence: string,
): InvariantFinding {
  return {
    invariant,
    tenantId: t.id,
    tenantLabel: labelOf(t),
    slug: t.slug,
    rowId: r.id,
    addonKey: r.addonKey,
    sku: codeOf(r),
    name,
    updatedAt: r.updatedAt,
    sentence,
  };
}

/** The registry. A new invariant is one entry here. */
export const ADDON_INVARIANTS: readonly InvariantCheck[] = [
  {
    id: "I1",
    run(ctx) {
      const out: InvariantFinding[] = [];
      for (const t of ctx.tenants) {
        if (t.status !== "ACTIVE") continue;
        for (const r of ctx.rowsOf(t.id)) {
          if (r.active || r.updatedAt < ctx.windowStart) continue;
          const actor = ctx.latestActorKind(r.id);
          // missing record (undefined) = a bypass of the writer; SYSTEM = an automatic path switched it off.
          if (actor === undefined || actor === "SYSTEM") {
            out.push(
              finding(
                "I1",
                t,
                r,
                ctx.skusOf(t)?.find((sk) => sk.sku === codeOf(r))?.name ?? codeOf(r),
                "was switched off with no owner, admin or tenant action on record",
              ),
            );
          }
        }
      }
      return out;
    },
  },
  {
    id: "I2",
    run(ctx) {
      const out: InvariantFinding[] = [];
      for (const t of ctx.tenants) {
        const mode = ctx.modeOf(t);
        if (mode === "UNBILLED") continue;
        const skus = ctx.skusOf(t);
        const plan = ctx.planKeyOf(t);
        if (!skus || !plan) continue;
        for (const r of ctx.rowsOf(t.id)) {
          if (!r.active || r.isComp || Number(r.priceSnapshot ?? 0) !== 0 || r.stripeItemId)
            continue;
          const def = skus.find((s) => s.sku === codeOf(r));
          if (!def || inclusionOf(def, plan).kind !== "NOT_INCLUDED") continue;
          const price = roundMoney(Number(def.monthlyPrice ?? 0));
          if (!(price > 0)) continue;
          out.push(
            finding(
              "I2",
              t,
              r,
              def.name,
              `is on at $0 but ${plan} does not include it: ${usd(price)} a month is owed`,
            ),
          );
        }
      }
      return out;
    },
  },
  {
    id: "I3",
    run(ctx) {
      const out: InvariantFinding[] = [];
      for (const t of ctx.tenants) {
        const skus = ctx.skusOf(t);
        const plan = ctx.planKeyOf(t);
        if (!skus || !plan) continue;
        for (const r of ctx.rowsOf(t.id)) {
          if (!r.active || r.isComp) continue;
          if (!(Number(r.priceSnapshot ?? 0) > 0 || r.stripeItemId)) continue;
          const def = skus.find((s) => s.sku === codeOf(r));
          if (!def || inclusionOf(def, plan).kind !== "INCLUDED") continue;
          out.push(finding("I3", t, r, def.name, `is billed although ${plan} includes it`));
        }
      }
      return out;
    },
  },
];

const isUnique = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export function findingMessage(f: InvariantFinding): string {
  return `Add-on ${f.name} for ${f.tenantLabel}: ${f.sentence}. Check the tenant's add-ons.`;
}

@Injectable()
export class AddonInvariantJob {
  private readonly logger = new Logger(AddonInvariantJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: PlanCatalogService,
    private readonly stripe: StripeService,
    private readonly email: EmailService,
  ) {}

  @LeaderCron("0 7 * * *", "billing.addonInvariants")
  async addonInvariants(): Promise<void> {
    await this.run(new Date());
  }

  /** One pass. Exported for the DB spec; returns the findings that were NEW this run. */
  async run(now: Date = new Date()): Promise<InvariantFinding[]> {
    const windowStart = new Date(now.getTime() - ADDON_INVARIANT_WINDOW_HOURS * 3_600_000);
    const fresh: InvariantFinding[] = [];
    const skuCache = new Map<string, readonly AddonSkuDef[] | null>();
    let truncated = false;
    let cursor: string | undefined;

    for (;;) {
      const tenants = (await this.prisma.tenant.findMany({
        where: {
          class: "PRODUCTION",
          deletedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: ADDON_INVARIANT_PAGE_SIZE,
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          plan: true,
          planVersionId: true,
          subscription: {
            select: {
              planKey: true,
              planVersionId: true,
              stripeSubId: true,
              externalPayment: true,
              couponFull: true,
            },
          },
        },
      })) as InvariantTenant[];
      if (tenants.length === 0) break;
      cursor = tenants[tenants.length - 1].id;
      const ids = tenants.map((t) => t.id);

      const [rows, events] = await Promise.all([
        this.prisma.tenantAddon.findMany({ where: { tenantId: { in: ids } } }),
        this.prisma.billingEvent.findMany({
          where: {
            type: BILLING_EVENTS.ADDON_STATE_CHANGED,
            tenantId: { in: ids },
            createdAt: { gte: windowStart },
          },
          orderBy: { createdAt: "asc" },
          select: { payload: true },
        }),
      ]);
      const byTenant = new Map<string, InvariantRow[]>();
      for (const r of rows as unknown as InvariantRow[]) {
        const list = byTenant.get(r.tenantId) ?? [];
        list.push(r);
        byTenant.set(r.tenantId, list);
      }
      const latest = new Map<string, string | null>();
      for (const e of events) {
        const p = e.payload as { rowId?: string; actor?: { kind?: string } } | null;
        if (p?.rowId) latest.set(p.rowId, p.actor?.kind ?? null);
      }
      for (const t of tenants) {
        const v = resolvePlanVersionId(t.subscription, t) ?? "";
        if (!skuCache.has(v)) skuCache.set(v, await this.skusFor(v));
      }

      const ctx: InvariantContext = {
        now,
        windowStart,
        tenants,
        rowsOf: (id) => byTenant.get(id) ?? [],
        latestActorKind: (rowId) => (latest.has(rowId) ? latest.get(rowId) : undefined),
        skusOf: (t) => skuCache.get(resolvePlanVersionId(t.subscription, t) ?? "") ?? null,
        planKeyOf: (t) =>
          normalizePlanKey(t.subscription?.planKey) ?? (t.plan ? planKeyFromEnum(t.plan) : null),
        modeOf: (t) => addonBillingModeOf(this.stripe.isConfigured, t.subscription),
      };
      for (const check of ADDON_INVARIANTS) {
        for (const f of check.run(ctx)) {
          if (fresh.length >= ADDON_INVARIANT_MAX_FINDINGS_PER_RUN) {
            truncated = true;
            break;
          }
          if (await this.claim(f)) fresh.push(f);
        }
      }
      if (truncated) break;
      if (tenants.length < ADDON_INVARIANT_PAGE_SIZE) break;
    }

    for (const f of fresh) await this.alert(f);
    if (truncated) await this.noticeTruncated();
    if (fresh.length > 0) await this.sendEmail(fresh, truncated);
    return fresh;
  }

  private async skusFor(planVersionId: string): Promise<readonly AddonSkuDef[] | null> {
    try {
      // SA-815a: the ONE resolver (an empty id = unpinned = the published version).
      const v = await inclusionCatalogFor(this.catalog, { planVersionId: planVersionId || null });
      return v.addonSkus;
    } catch (err) {
      this.logger.error(`addon invariant: catalog unresolved (${(err as Error).message})`);
      return null;
    }
  }

  private milestone(f: InvariantFinding): string {
    return `ADDON_INVARIANT:${f.invariant}`;
  }
  private key(f: InvariantFinding): string {
    return `${f.rowId}:${f.updatedAt.toISOString()}`;
  }

  /** The house claim: `create` + a P2002 catch. True only for the run that WON the claim. */
  private async claim(f: InvariantFinding): Promise<boolean> {
    try {
      await this.prisma.billingNotificationLog.create({
        data: { tenantId: f.tenantId, milestone: this.milestone(f), key: this.key(f) },
      });
      return true;
    } catch (e) {
      if (!isUnique(e)) {
        this.logger.error(`addon invariant claim failed for ${f.tenantId}/${f.rowId}`, e as Error);
      }
      return false;
    }
  }

  private async release(f: InvariantFinding): Promise<void> {
    try {
      await this.prisma.billingNotificationLog.delete({
        where: {
          tenantId_milestone_key: {
            tenantId: f.tenantId,
            milestone: this.milestone(f),
            key: this.key(f),
          },
        },
      });
    } catch (e) {
      this.logger.error(`addon invariant release failed for ${f.tenantId}/${f.rowId}`, e as Error);
    }
  }

  private async alert(f: InvariantFinding): Promise<void> {
    this.logger.error(
      `addon invariant ${f.invariant} tenant=${f.slug} sku=${f.sku}: ${f.sentence}`,
    );
    try {
      await writeAdminNotice(this.prisma, {
        tenantId: f.tenantId,
        action: AdminAuditAction.ADDON_INVARIANT_BROKEN,
        message: findingMessage(f),
        meta: { invariant: f.invariant, rowId: f.rowId, sku: f.sku },
      });
    } catch (e) {
      this.logger.error(`addon invariant notice failed for ${f.tenantId}`, e as Error);
    }
  }

  private async noticeTruncated(): Promise<void> {
    this.logger.error(
      `addon invariant: more than ${ADDON_INVARIANT_MAX_FINDINGS_PER_RUN} findings, the run was truncated`,
    );
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: null,
          userId: null,
          action: AdminAuditAction.ADDON_INVARIANT_BROKEN,
          entityType: ADMIN_AUDIT_ENTITY,
          entityId: "addon-invariants",
          meta: {
            platformAdmin: true,
            truncated: true,
            message: `The add-on invariant run was truncated at ${ADDON_INVARIANT_MAX_FINDINGS_PER_RUN} findings. Check the tenants' add-ons.`,
          },
        },
      });
    } catch (e) {
      this.logger.error("addon invariant truncation notice failed", e as Error);
    }
  }

  /** `log` mode (the default) sends nothing; `email` sends ONE message per recipient for the run, never throws. */
  private async sendEmail(fresh: readonly InvariantFinding[], truncated: boolean): Promise<void> {
    if (process.env.ADDON_INVARIANT_EMAIL !== "email") return;
    const recipients = (process.env.PLATFORM_ALERT_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      this.logger.error("addon invariant: no alert recipients configured");
      return;
    }
    try {
      const base = (
        process.env.WEB_URL ??
        process.env.FRONTEND_URL ??
        "https://www.routeflow.info"
      ).replace(/\/$/, "");
      const lines = fresh.map(
        (f) =>
          `${f.tenantLabel} (${f.slug}): add-on ${f.name} ${f.sentence}. ${base}/admin/tenants/${f.tenantId}`,
      );
      const more = truncated
        ? [`More than ${ADDON_INVARIANT_MAX_FINDINGS_PER_RUN} findings: this list is truncated.`]
        : [];
      const subject = `RouteFlow alert: ${fresh.length} add-on issue(s) need a look`;
      const text = [...lines, ...more].join("\n");
      const html = `<ul>${[...lines, ...more].map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
      let delivered = false;
      for (const to of recipients) {
        const r = await this.email.sendPlatform({ to, subject, html, text });
        delivered = delivered || r.delivered;
      }
      if (!delivered) {
        for (const f of fresh) await this.release(f); // the next run retries
        this.logger.error("addon invariant: the alert email was not delivered; claims released");
      }
    } catch (e) {
      for (const f of fresh) await this.release(f);
      this.logger.error("addon invariant: the alert email threw; claims released", e as Error);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
