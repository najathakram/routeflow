import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  RuleEditPreviewResponse,
  RuleRevisionDto,
  SellingRestrictionListItemDto,
} from "@routeflow/types";
import type { OrderStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import {
  ruleMatchesProduct,
  ruleTargetSets,
  resolveGoverningState,
  UNRESOLVED_STATE,
  type GoverningState,
  type ProductFacts,
  type RestrictionRuleFacts,
} from "../selling-restrictions/selling-restrictions.core";
import {
  ADDRESS_SELECT,
  SellingRestrictionsService,
} from "../selling-restrictions/selling-restrictions.service";
import { tenantBusinessState } from "../selling-restrictions/tenant-business-state";
import { CommitEditRuleDto, EditRuleDto } from "./dto/edit-rule.dto";
import { assertMayManageRule, lockEditableRule, readEditableRule } from "./rule-lock";
import { staffChannelJudged } from "./staff-channel";
import { ruleEndUseLift, ruleImpactChanged, ruleImpactTooLarge, ruleStale } from "./rule-errors";
import { ruleEditChanges, type RuleEditChange, type RuleEditSettings } from "./rule-edit-direction";
import { impactHash, newlyRestricted } from "./rule-edit-impact";
import { prepareRuleSettings, type PreparedRuleSettings } from "./rule-settings";
import {
  RULE_INCLUDE as INCLUDE,
  toDto,
  type RuleRow as Row,
} from "./selling-restrictions-admin.service";
import { EMPTY_TARGET_SUMMARY, targetSummaries } from "./rule-target-read";

/** Interactive-transaction budget: the impact reads open orders and drafts of a whole tenant. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 };
/** Product / customer ids per `in (...)` read and per label lookup. */
const CHUNK = 500;
/**
 * The most open orders + drafts (together) a tightening edit's impact scan will count; past it the edit is a coded
 * 409 RULE_IMPACT_TOO_LARGE, never a slow scan that dies on a transaction timeout.
 */
export const IMPACT_SCAN_MAX_DOCUMENTS = 2000;
/** The most distinct products on open lines the scan will label-check before giving up the same way. */
const IMPACT_SCAN_MAX_PRODUCTS = 20_000;

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const settingsOf = (r: Row): RuleEditSettings => ({
  jurisdiction: r.jurisdiction,
  states: r.states,
  surface: r.surface,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  reason: r.reason,
});

/**
 * A rule's settings history, NEWEST first (GET /selling-restrictions/:id `revisions`). Takes the caller's
 * transaction client so the detail read and the history are one consistent snapshot.
 */
export async function ruleRevisions(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ruleId: string,
): Promise<RuleRevisionDto[]> {
  if (!tenantId || !ruleId) throw new BadRequestException("A rule is required.");
  const rows = await tx.sellingRestrictionRevision.findMany({
    where: { tenantId, ruleId },
    orderBy: { revision: "desc" },
  });
  return rows.map((r) => ({
    revision: r.revision,
    jurisdiction: r.jurisdiction,
    states: r.states,
    surface: r.surface,
    effectiveFrom: r.effectiveFrom.toISOString(),
    effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString() : null,
    reason: r.reason,
    editedByName: r.editedByName,
    editedAt: r.editedAt.toISOString(),
    note: r.note,
  }));
}

interface EditEvaluation {
  changes: RuleEditChange[];
  impact: { openOrders: number; drafts: number };
  hash: string;
}

/**
 * Row 509 PR3: edit a rule's settings IN PLACE, with an append-only history. Two calls:
 *  - `preview`: what each change does (tightens / loosens), how many open orders and drafts it newly reaches, and
 *    the fingerprint of those documents;
 *  - `commit`: under the rule's row lock (the same lock target edits and lifts take), re-checks the revision and
 *    the fingerprint, writes the new current values and revision n+1, appends the revision row and one audit row.
 * NEVER retroactive: an edit changes the rule only. Open orders and drafts are not touched; the existing choke
 * points (`assertLinesSellable`) judge them by the current rule the next time they are edited, promoted or
 * invoiced. There is no buyer-hide cache to invalidate (the portal reads the rules per request), so none is touched.
 */
@Injectable()
export class RuleEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly restrictions: SellingRestrictionsService,
    private readonly productLabels: ProductLabelsService,
  ) {}

  /**
   * The document cap of the impact scan (`IMPACT_SCAN_MAX_DOCUMENTS`). A field rather than a constructor argument so
   * Nest keeps injecting three providers; a spec lowers it to prove the overflow path.
   */
  scanCap = IMPACT_SCAN_MAX_DOCUMENTS;

  /** The response item: the shared list DTO plus the rule's target summary (PR2's one helper). */
  private async dtoOf(
    tx: Prisma.TransactionClient,
    tenantId: string,
    row: Row,
    now: Date,
  ): Promise<SellingRestrictionListItemDto> {
    const summaries = await targetSummaries(tx as never, tenantId, [row.id]);
    return toDto(row, now, summaries.get(row.id) ?? EMPTY_TARGET_SUMMARY);
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  /** The tenant's rule row, locked by `lockEditableRule` first (so a lifted / foreign rule never gets here). */
  private async loadRule(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Row> {
    const row = await tx.sellingRestriction.findFirst({
      where: { id, tenantId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException("Restriction not found");
    return row;
  }

  /**
   * NO transaction and NO lock: the impact scan can take a while and must not hold the rule (a lift or a target edit
   * waiting behind a preview would be a stall). A plain tenant-scoped read decides what the preview says; the commit
   * re-verifies all of it under `lockEditableRule`, so a rule that changed in between is a coded 409 there.
   */
  async preview(id: string, dto: EditRuleDto, user: JwtPayload): Promise<RuleEditPreviewResponse> {
    const tenantId = this.requireTenant();
    const now = new Date();
    const db = this.prisma.forTenant() as unknown as Prisma.TransactionClient;
    const readRule = await readEditableRule(db, tenantId, id, now);
    const rule = await this.loadRule(db, tenantId, id);
    const next = prepareRuleSettings(dto, rule);
    assertMayManageRule(user, readRule, next);
    this.assertNotEndingNow(next, now);
    const ev = await this.evaluate(db, tenantId, rule, next, now);
    return {
      changes: ev.changes,
      impact: ev.impact,
      impactHash: ev.hash,
      revision: rule.revision,
    };
  }

  /** Ending a rule is a lift (reason, immediate): an edit may shorten the window, never close it. */
  private assertNotEndingNow(next: PreparedRuleSettings, now: Date): void {
    if (next.effectiveTo && next.effectiveTo.getTime() <= now.getTime()) throw ruleEndUseLift();
  }

  async commit(
    id: string,
    dto: CommitEditRuleDto,
    user: JwtPayload,
  ): Promise<SellingRestrictionListItemDto> {
    const tenantId = this.requireTenant();
    const now = new Date();
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const locked = await lockEditableRule(tx, tenantId, id, now);
      const rule = await this.loadRule(tx, tenantId, id);
      if (dto.expectedRevision !== rule.revision) throw ruleStale();
      const next = prepareRuleSettings(dto, rule);
      assertMayManageRule(user, locked, next);
      this.assertNotEndingNow(next, now);
      const ev = await this.evaluate(tx, tenantId, rule, next, now);
      if (ev.hash !== dto.confirmImpactHash) throw ruleImpactChanged();
      if (ev.changes.length === 0) return this.dtoOf(tx, tenantId, rule, now); // nothing to save

      const toRevision = rule.revision + 1;
      const updated: Row = await tx.sellingRestriction.update({
        where: { id: rule.id },
        data: {
          jurisdiction: next.jurisdiction,
          states: next.states,
          surface: next.surface,
          effectiveFrom: next.effectiveFrom,
          effectiveTo: next.effectiveTo,
          reason: next.reason,
          revision: toRevision,
        },
        include: INCLUDE,
      });
      // Append-only: revision rows are only ever inserted, never updated or deleted.
      await tx.sellingRestrictionRevision.create({
        data: {
          tenantId,
          ruleId: rule.id,
          revision: toRevision,
          jurisdiction: next.jurisdiction,
          states: next.states,
          surface: next.surface,
          effectiveFrom: next.effectiveFrom,
          effectiveTo: next.effectiveTo,
          reason: next.reason,
          editedById: user.sub,
          editedByName: user.username,
          note: dto.note ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: "selling_restriction.edited",
          entityType: "SellingRestriction",
          entityId: rule.id,
          meta: {
            ruleId: rule.id,
            fromRevision: rule.revision,
            toRevision,
            changes: ev.changes.map((c) => ({ field: c.field, direction: c.direction })),
          },
        },
      });
      return this.dtoOf(tx, tenantId, updated, now);
    }, TX_OPTIONS);
  }

  /** The directions, the impact on open orders / drafts, and the fingerprint of those documents. */
  private async evaluate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    rule: Row,
    next: PreparedRuleSettings,
    now: Date,
  ): Promise<EditEvaluation> {
    const policy = await this.restrictions.getPolicy(tenantId);
    const staffEnforced = staffChannelJudged(policy);
    const prev = settingsOf(rule);
    const changes = ruleEditChanges(prev, next, { staffEnforced });
    // Only a TIGHTENING edit can newly restrict anyone; a loosening or neutral one reaches nothing.
    const ids: string[] = [];
    let openOrders = 0;
    let drafts = 0;
    if (changes.some((c) => c.direction === "TIGHTENS")) {
      const reached = await this.reachedDocuments(tx, tenantId, rule, now);
      const governing = await this.governingStates(tx, tenantId, policy.addressPrecedence, [
        ...new Set([...reached.orders, ...reached.invoices].map((d) => d.customerId)),
      ]);
      const hit = (customerId: string) =>
        newlyRestricted(prev, next, governing.get(customerId) ?? UNRESOLVED_STATE, {
          staffEnforced,
          at: now,
        });
      for (const o of reached.orders) {
        if (!hit(o.customerId)) continue;
        if (o.status === "DRAFT") {
          drafts += 1;
          ids.push(`d:${o.id}`);
        } else {
          openOrders += 1;
          ids.push(`o:${o.id}`);
        }
      }
      for (const inv of reached.invoices) {
        if (!hit(inv.customerId)) continue;
        drafts += 1;
        ids.push(`i:${inv.id}`);
      }
    }
    return {
      changes,
      impact: { openOrders, drafts },
      hash: impactHash(rule.id, rule.revision, ids, next),
    };
  }

  /**
   * Open orders (any status but DELIVERED / CANCELLED, DRAFT included: the caller splits them) and DRAFT invoices
   * holding a live line whose product falls under the rule's ACTIVE targets (its legacy column when it has no
   * target rows, as the engine does). Products are matched with the engine's own `ruleMatchesProduct` over the
   * EFFECTIVE labels, so a family target reaches its variants and an opt-out is honoured.
   */
  private async reachedDocuments(
    tx: Prisma.TransactionClient,
    tenantId: string,
    rule: Row,
    now: Date,
  ): Promise<{
    orders: Array<{ id: string; status: string; customerId: string }>;
    invoices: Array<{ id: string; customerId: string }>;
  }> {
    const targetRows = await tx.sellingRestrictionTarget.findMany({
      where: { tenantId, ruleId: rule.id },
      select: { productId: true, categoryId: true, addedAt: true, removedAt: true },
    });
    const facts: RestrictionRuleFacts = {
      id: rule.id,
      categoryId: rule.categoryId,
      productId: rule.productId,
      jurisdiction: rule.jurisdiction,
      states: rule.states,
      surface: rule.surface,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      liftedAt: null,
      reason: rule.reason,
      targets: ruleTargetSets(targetRows, targetRows.length, now),
    };

    const liveOrder = {
      tenantId,
      status: { notIn: ["DELIVERED", "CANCELLED"] as OrderStatus[] },
    };
    const liveLine = { productId: { not: null }, status: { not: "CANCELLED" } } as const;
    // SQL GROUP BY (never `distinct`, which Prisma de-duplicates in memory): the distinct products on live lines,
    // bounded, so a tenant with a huge open book is a coded 409 instead of a slow scan.
    // (`as never`: Prisma's groupBy generics reject a literal `by` + `orderBy` + `take` through the tx client type.)
    const orderProducts: Array<{ productId: string | null }> = await tx.orderItem.groupBy({
      by: ["productId"],
      where: { tenantId, ...liveLine, order: liveOrder },
      orderBy: { productId: "asc" },
      take: IMPACT_SCAN_MAX_PRODUCTS + 1,
    } as never);
    const invoiceProducts: Array<{ productId: string | null }> = await tx.invoiceItem.groupBy({
      by: ["productId"],
      where: { tenantId, productId: { not: null }, invoice: { tenantId, status: "DRAFT" } },
      orderBy: { productId: "asc" },
      take: IMPACT_SCAN_MAX_PRODUCTS + 1,
    } as never);
    const candidates = [
      ...new Set([...orderProducts, ...invoiceProducts].map((r) => r.productId)),
    ].filter((id): id is string => typeof id === "string");
    if (
      orderProducts.length > IMPACT_SCAN_MAX_PRODUCTS ||
      invoiceProducts.length > IMPACT_SCAN_MAX_PRODUCTS
    ) {
      throw ruleImpactTooLarge(this.scanCap);
    }

    const matched = new Set<string>();
    for (const part of chunks(candidates, CHUNK)) {
      const labels = await this.productLabels.effectiveLabels(tenantId, part);
      for (const id of part) {
        const l = labels.get(id);
        const product: ProductFacts = {
          id,
          name: l?.name ?? id,
          effectiveCategoryIds: l?.effectiveCategoryIds ?? new Set<string>(),
          lineageIds: l?.lineageIds ?? new Set([id]),
        };
        if (ruleMatchesProduct(facts, product)) matched.add(id);
      }
    }
    if (matched.size === 0) return { orders: [], invoices: [] };

    // Documents are collected by id (one holding lines in two chunks counts once) and the read stops the moment
    // the cap is passed, so the scan is bounded in rows read as well as in time.
    const orders = new Map<string, { id: string; status: string; customerId: string }>();
    const invoices = new Map<string, { id: string; customerId: string }>();
    const guard = () => {
      if (orders.size + invoices.size > this.scanCap) throw ruleImpactTooLarge(this.scanCap);
    };
    for (const part of chunks([...matched], CHUNK)) {
      const o: Array<{ id: string; status: string; customerId: string }> = await tx.order.findMany({
        where: {
          ...liveOrder,
          lineItems: { some: { productId: { in: part }, status: { not: "CANCELLED" } } },
        },
        select: { id: true, status: true, customerId: true },
        orderBy: { id: "asc" },
        take: this.scanCap + 1,
      });
      for (const row of o) orders.set(row.id, row);
      guard();
      const i: Array<{ id: string; customerId: string }> = await tx.invoice.findMany({
        where: { tenantId, status: "DRAFT", items: { some: { productId: { in: part } } } },
        select: { id: true, customerId: true },
        orderBy: { id: "asc" },
        take: this.scanCap + 1,
      });
      for (const row of i) invoices.set(row.id, row);
      guard();
    }
    return { orders: [...orders.values()], invoices: [...invoices.values()] };
  }

  /** Each customer's governing state, by the engine's own resolver (walk-in: the tenant's business state). */
  private async governingStates(
    tx: Prisma.TransactionClient,
    tenantId: string,
    precedence: Parameters<typeof resolveGoverningState>[1],
    customerIds: readonly string[],
  ): Promise<Map<string, GoverningState>> {
    const out = new Map<string, GoverningState>();
    let businessState: GoverningState | undefined;
    for (const part of chunks(customerIds, CHUNK)) {
      const rows: Array<{
        id: string;
        isWalkIn: boolean | null;
        addresses: Array<Parameters<typeof resolveGoverningState>[0][number]>;
      }> = await tx.customer.findMany({
        where: { tenantId, id: { in: part } },
        select: { id: true, isWalkIn: true, addresses: { select: ADDRESS_SELECT } },
      });
      for (const c of rows) {
        if (c.isWalkIn === true) {
          if (!businessState) {
            const state = await tenantBusinessState(this.prisma, tenantId);
            businessState = state ? { resolved: true, state } : UNRESOLVED_STATE;
          }
          out.set(c.id, businessState);
        } else {
          out.set(c.id, resolveGoverningState(c.addresses, precedence));
        }
      }
    }
    return out;
  }
}
