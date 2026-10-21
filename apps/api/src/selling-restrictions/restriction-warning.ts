import { BadRequestException, ConflictException } from "@nestjs/common";
import { createHash } from "crypto";
import type {
  BlockedLine,
  RestrictionAck,
  RestrictionOutcome,
  RestrictionWarningError,
  RestrictionWarningLine,
  RestrictionWarningRule,
} from "@routeflow/types";
import { staffMay } from "../auth/permissions/staff-capabilities";
import {
  carryOverrideStamp,
  hasOverrideStamp,
  type OverrideStamp,
} from "../common/restriction-override-columns";
import { assertSafeTextCell } from "../common/safe-text-cell";
import type { JurisdictionBasis } from "./sale-fulfilment";
import {
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  RESTRICTION_OVERRIDE_CODES,
  RESTRICTION_OVERRIDE_REASON_MAX,
  RESTRICTION_OVERRIDE_REASON_MIN,
  SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
} from "./override-constants";
import { stampRestrictionOverrides, type StampTx } from "./restriction-override-stamps";
import type { ChannelPrincipal } from "./selling-restrictions.core";
import { breachKeys, type StaffBreachDetail, type StaffBreachRule } from "./staff-breaches";

/**
 * Row 510: the warning-and-override protocol for a STAFF sale of a restricted product.
 *
 * A staff write the engine finds in breach of a rule is no longer refused outright when the principal may override
 * (`staffMay(role, "OVERRIDE_SELLING_RESTRICTION")`: OPERATOR, TENANT_ADMIN). It answers 409 RESTRICTION_WARNING with the
 * lines and a `warningHash`; the client collects ONE reason and resubmits the SAME payload plus
 * `{ restrictionOverrides: [{ lineKey, reason }], warningHash }`. A principal who may not override (DRIVER, SUPER_ADMIN, a
 * system caller with none) is still hard-blocked (409 SELLING_RESTRICTED). So is a SUPPORT SESSION (a token carrying
 * `impersonatedBy`) even when its role could: support sessions can't override, or the stamp and the audit row would credit
 * the account admin with a sale a support agent made. Buyers never reach this module: their channel keeps the portal's
 * hard 409.
 *
 * PURE (no Prisma). The service builds the engine verdict and passes it in; the transaction half is
 * `restriction-override-stamps.ts`. This file is the ONLY place a RESTRICTION_WARNING body is built (a pin).
 *
 * Coverage (sticky): a breached product is COVERED, and never warns, when a live line of it already on the document
 * carries a stamp whose keys are a superset of the product's current breach keys (`breachKeys`: one `ruleId:STATE` per
 * rule, STATE the state the sale is judged at, `UNKNOWN` when unresolved). A new rule id, the same rule at ANOTHER state
 * (a store sale that becomes a delivery, an unresolved sale whose customer gets an address), or a product the document
 * does not hold (an add, a swap), is UNCOVERED. A decrease or removal is never judged by the engine.
 */

export type LineKey = string;

/** One line a write adds, as the engine judges it (`SellableLine` plus its stable key). */
export interface GateLine {
  productId: string;
  /** Net change in selling units; omitted = a NEW line (always judged). */
  qtyDelta?: number;
  /** "n:<index>" (a payload entry), "l:<lineId>" (an existing line), "cr:<changeRequestId>". */
  lineKey: LineKey;
}

/** A line already on the document, as read UNDER the write's lock (the stamp columns come from the row). */
export type HeldLine = Partial<OverrideStamp> & {
  id: string;
  productId: string | null;
  /** Order lines only: a CANCELLED line holds no goods and never covers. */
  status?: string | null;
};

/** What the service hands the protocol: the engine verdict for the write's lines. */
export interface StaffJudgement {
  outcome: RestrictionOutcome;
  reasons: BlockedLine[];
  breaches: StaffBreachDetail[];
  basis: JurisdictionBasis;
}

export interface StampPlan {
  lineKey: LineKey;
  productId: string;
  /** Trimmed, 3..200 characters, not formula-led. */
  reason: string;
  /** The stamp keys, sorted: `ruleId:STATE` per rule (`staff-breaches.ts` `breachKeys`). Stored as-is. */
  ruleIds: string[];
}

export interface CarriedStamp {
  productId: string;
  stamp: OverrideStamp;
}

/**
 * The outcome of a staff write's restriction gate: what to stamp, and (after `recheck` under the lock) what to carry.
 * `stampRestrictionOverrides` applies it inside the write's transaction.
 */
export interface StaffWriteDecision {
  /** Newly acknowledged lines (one per warned lineKey). Empty when nothing was breached or all was covered. */
  stamps: readonly StampPlan[];
  /** Stamps already on the document's lines (read under the lock): re-applied to a product's recreated / new lines. */
  carried: readonly CarriedStamp[];
  /** Held line id -> product id, for the stamped held lines (a line whose product changed has its stamp cleared). */
  heldStamped: ReadonlyMap<string, string | null>;
  /** The hash the client acknowledged (null when no warning was needed). */
  warningHash: string | null;
  basis: JurisdictionBasis;
  /**
   * Is there anything for a re-judge under the lock to find (a breached product, or a stamp on a held line)? When
   * false a writer that would need an EXTRA read of the document's lines to `recheck` can skip it.
   */
  active: boolean;
  /**
   * Pure recompute under the write's EXISTING lock: `held` are the document's lines as just read after the lock. A
   * product that is uncovered and whose rows hash differently from the acknowledgement throws 409 RESTRICTION_WARNING
   * (the fresh list), or the hard block for a principal who may not override. `lines` replaces the judged lines when
   * the path judges every live line of the document (promote, reopen, the path switch). Returns the final decision
   * (with `carried` and `heldStamped` set).
   *
   * Rule-set race (accepted, SA): the RULES are loaded pre-lock. A rule added mid-request is equivalent to one added
   * after commit: row 509 is not retroactive, and the next touch of the document re-judges it.
   */
  recheck(held: readonly HeldLine[], lines?: readonly GateLine[]): StaffWriteDecision;
  /**
   * Inside the write's transaction, after its line writes: stamps the acknowledged lines of document `parentId`,
   * re-applies carried stamps, clears a swapped line's, and writes the audit rows (`restriction-override-stamps.ts`).
   * Resolves to the number of newly stamped lines.
   */
  stamp(tx: StampTx, parentId: string): Promise<number>;
}

/** Whose document the stamp lands on, and who is stamping it (known when the gate is called). */
export interface StampTarget {
  document: "ORDER" | "INVOICE";
  tenantId: string;
  /** The overriding User id. */
  by: string | null;
  /** The support agent's id when the write is made in a support session (the audit row's `impersonatedBy`). */
  impersonatedBy?: string | null;
}

/** The decision for a write the protocol has nothing to say about (a buyer channel, nothing judged). */
export function noRestrictionOverride(
  basis: JurisdictionBasis = "CUSTOMER",
  target: StampTarget | null = null,
): StaffWriteDecision {
  return buildDecision({
    judgement: { outcome: "ALLOW", reasons: [], breaches: [], basis },
    lines: [],
    stamps: [],
    ackedHash: null,
    customerId: null,
    mayOverride: true,
    blocked: () => new Error("unreachable: nothing was judged"),
    held: [],
    target,
  });
}

// ─── the hash ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One uncovered warning row: a line of a breached product the document does not already cover. */
interface WarningRow {
  lineKey: LineKey;
  breach: StaffBreachDetail;
}

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort();

/**
 * `rw1:` + sha256 over the customer, the basis and the uncovered rows sorted by lineKey, each `[lineKey, productId,
 * outcome, sortedRuleIds]`. Display text is excluded (a copy change never invalidates an acknowledgement). The server is
 * the only computer; a client echoes the value opaquely (L-303: no runtime logic shared with clients).
 */
export function warningHash(
  rows: ReadonlyArray<{ lineKey: string; productId: string; outcome: string; ruleIds: string[] }>,
  customerId: string | null,
  basis: string,
): string {
  const sorted = [...rows]
    .sort((a, b) => (a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0))
    .map((r) => [r.lineKey, r.productId, r.outcome, sortedIds(r.ruleIds)]);
  const digest = createHash("sha256")
    .update(JSON.stringify({ c: customerId, b: basis, l: sorted }))
    .digest("hex");
  return `rw1:${digest}`;
}

const hashOfRows = (rows: readonly WarningRow[], customerId: string | null, basis: string) =>
  warningHash(
    rows.map((r) => ({
      lineKey: r.lineKey,
      productId: r.breach.productId,
      outcome: r.breach.outcome,
      // the state-qualified keys: an acknowledgement given at one judged state is not one for another
      ruleIds: breachKeys(r.breach),
    })),
    customerId,
    basis,
  );

// ─── coverage ─────────────────────────────────────────────────────────────────────────────────────────────────────

const isLive = (h: HeldLine) => h.status !== "CANCELLED";
const isSuperset = (have: readonly string[], need: readonly string[]) =>
  need.every((id) => have.includes(id));

/** Is `breach` already acknowledged by a live stamped line of its product on the document? */
function isCovered(breach: StaffBreachDetail, held: readonly HeldLine[]): boolean {
  return held.some(
    (h) =>
      isLive(h) &&
      h.productId === breach.productId &&
      hasOverrideStamp(h) &&
      isSuperset(h.restrictionOverrideRuleIds ?? [], breachKeys(breach)),
  );
}

/** A line adds sellable quantity unless its numeric delta is <= 0 (NaN / omitted = unsized, judged). */
const addsQuantity = (l: GateLine) => !(typeof l.qtyDelta === "number" && l.qtyDelta <= 0);

/** The uncovered rows: one per adding line of each breached, uncovered product. */
function uncoveredRows(
  breaches: readonly StaffBreachDetail[],
  lines: readonly GateLine[],
  held: readonly HeldLine[],
): WarningRow[] {
  const rows: WarningRow[] = [];
  for (const breach of breaches) {
    if (isCovered(breach, held)) continue;
    const mine = lines.filter((l) => l.productId === breach.productId);
    const adding = mine.filter(addsQuantity);
    for (const l of adding.length > 0 ? adding : mine) rows.push({ lineKey: l.lineKey, breach });
  }
  return rows;
}

/** Every live stamped held line's stamp, one per product (the first), for re-applying to recreated / new lines. */
function carriedFrom(held: readonly HeldLine[]): CarriedStamp[] {
  const out = new Map<string, CarriedStamp>();
  for (const h of held) {
    if (!isLive(h) || !h.productId || !hasOverrideStamp(h) || out.has(h.productId)) continue;
    out.set(h.productId, { productId: h.productId, stamp: carryOverrideStamp(h) });
  }
  return [...out.values()];
}

// ─── the copy (built only here) ───────────────────────────────────────────────────────────────────────────────────

function ruleReasonText(
  rule: StaffBreachRule,
  breach: StaffBreachDetail,
  basis: JurisdictionBasis,
): string {
  switch (rule.kind) {
    case "FEDERAL":
      return "This product is banned federally by law.";
    case "STATE_HIT":
      return `This product is banned in ${breach.state ?? "this sale's state"} by law.`;
    case "MALFORMED_STATE":
    case "UNRECOGNISED":
      return `This product is banned by law (${rule.reason}).`;
    case "STATE_UNRESOLVED":
      return basis === "STORE"
        ? "This store's state can't be determined — add it under Settings > Business."
        : "This customer's state can't be determined — add or correct the customer's address.";
  }
}

function warningLine(row: WarningRow, judgement: StaffJudgement): RestrictionWarningLine {
  const { breach } = row;
  const rules: RestrictionWarningRule[] = breach.unknownProduct
    ? [
        {
          id: "",
          states: [],
          legal: true,
          reasonText:
            judgement.reasons.find((r) => r.productId === breach.productId)?.message ??
            "This product can't be checked against selling restrictions.",
        },
      ]
    : breach.rules.map((rule) => ({
        id: rule.id,
        states: rule.states,
        legal: rule.legal,
        reasonText: rule.legal
          ? ruleReasonText(rule, breach, judgement.basis)
          : `This product is limited for this sale (${rule.reason}).`,
      }));
  return {
    lineKey: row.lineKey,
    productId: breach.productId,
    displayName: breach.productName,
    outcome: breach.outcome,
    rules,
  };
}

function warningConflict(
  rows: readonly WarningRow[],
  hash: string,
  judgement: StaffJudgement,
): ConflictException {
  const lines = rows.map((r) => warningLine(r, judgement));
  const products = new Set(rows.map((r) => r.breach.productId)).size;
  const body: RestrictionWarningError = {
    code: RESTRICTION_OVERRIDE_CODES.warning,
    message:
      products === 1
        ? "This sale includes a restricted product. Give a reason to sell it anyway."
        : `This sale includes ${products} restricted products. Give a reason to sell them anyway.`,
    lines,
    warningHash: hash,
  };
  return new ConflictException(body);
}

function invalidReason(lineKey: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: RESTRICTION_OVERRIDE_CODES.reasonInvalid,
    lineKey,
    message: `Give a reason of ${RESTRICTION_OVERRIDE_REASON_MIN} to ${RESTRICTION_OVERRIDE_REASON_MAX} characters.`,
    error: "Bad Request",
  });
}

/** trim, bound, and refuse a formula-led reason (a spreadsheet would run it). Returns the trimmed reason. */
function validReason(lineKey: string, raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (
    reason.length < RESTRICTION_OVERRIDE_REASON_MIN ||
    reason.length > RESTRICTION_OVERRIDE_REASON_MAX
  )
    throw invalidReason(lineKey);
  assertSafeTextCell({ restrictionOverrideReason: reason });
  return reason;
}

// ─── the decision ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The service's ONE builder of the staff SELLING_RESTRICTED 409 (the B612 pin: no other file builds that body). */
export type StaffBlock = (
  reasons: BlockedLine[],
  message?: string,
  lines?: RestrictionWarningLine[],
) => Error;

interface DecisionInput {
  judgement: StaffJudgement;
  lines: readonly GateLine[];
  stamps: readonly StampPlan[];
  ackedHash: string | null;
  customerId: string | null;
  mayOverride: boolean;
  /** DRIVER: the hard block says to ask the office. */
  driver?: boolean;
  /** A support session: the hard block says to ask the account admin. */
  supportSession?: boolean;
  blocked: StaffBlock;
  held: readonly HeldLine[];
  target: StampTarget | null;
}

function buildDecision(d: DecisionInput): StaffWriteDecision {
  const heldStamped = new Map<string, string | null>(
    d.held.filter((h) => isLive(h) && hasOverrideStamp(h)).map((h) => [h.id, h.productId]),
  );
  const decision: StaffWriteDecision = {
    stamps: d.stamps,
    carried: carriedFrom(d.held),
    heldStamped,
    warningHash: d.ackedHash,
    basis: d.judgement.basis,
    active: d.judgement.breaches.length > 0 || heldStamped.size > 0,
    recheck(held, lines) {
      const rows = uncoveredRows(d.judgement.breaches, lines ?? d.lines, held);
      if (rows.length > 0) {
        const fresh = hashOfRows(rows, d.customerId, d.judgement.basis);
        if (fresh !== d.ackedHash) throw raise(d, rows, fresh);
      }
      return buildDecision({ ...d, held });
    },
    stamp(tx, parentId) {
      // A decision with no target stamps nothing (no stamps, or a caller that carries none).
      if (!d.target) return Promise.resolve(0);
      return stampRestrictionOverrides(tx, decision, {
        model: d.target.document === "ORDER" ? "orderItem" : "invoiceItem",
        parentId,
        documentType: d.target.document,
        tenantId: d.target.tenantId,
        by: d.target.by,
        impersonatedBy: d.target.impersonatedBy ?? null,
      });
    },
  };
  return decision;
}

/** The refusal for an uncovered set: the warning to a principal who may override, else the hard block. */
function raise(
  d: Pick<DecisionInput, "judgement" | "mayOverride" | "driver" | "supportSession" | "blocked">,
  rows: readonly WarningRow[],
  hash: string,
): Error {
  if (d.mayOverride) return warningConflict(rows, hash, d.judgement);
  const products = new Set(rows.map((r) => r.breach.productId));
  // A driver and a support session get the same shared modal: the per-line outcome staff see (legal flag + text), no
  // hash, no override. Only the sentence differs (who to ask).
  const shared = d.supportSession || d.driver;
  return d.blocked(
    d.judgement.reasons.filter((r) => products.has(r.productId)),
    d.supportSession
      ? SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE
      : d.driver
        ? DRIVER_RESTRICTION_BLOCK_MESSAGE
        : undefined,
    shared ? rows.map((r) => warningLine(r, d.judgement)) : undefined,
  );
}

export interface DecideParams {
  judgement: StaffJudgement;
  lines: readonly GateLine[];
  /** The document's lines already on it (empty for a create). */
  held?: readonly HeldLine[];
  principal?: ChannelPrincipal | null;
  ack?: RestrictionAck | null;
  customerId: string | null;
  blocked: StaffBlock;
  /** Where the stamp lands (the service passes it from the gate's parameters). */
  target?: StampTarget | null;
}

/**
 * The pre-write decision. Throws: 409 RESTRICTION_WARNING (override possible, not yet acknowledged / stale),
 * 409 SELLING_RESTRICTED through `blocked` (override impossible), 400 RESTRICTION_OVERRIDE_REASON_INVALID.
 */
export function decideStaffWrite(p: DecideParams): StaffWriteDecision {
  const held = p.held ?? [];
  const rows = uncoveredRows(p.judgement.breaches, p.lines, held);
  // A support session can't override whatever its role says (see the header): a token carrying impersonatedBy.
  const supportSession = !!p.principal?.impersonatedBy;
  const mayOverride =
    !supportSession && staffMay(p.principal?.role, "OVERRIDE_SELLING_RESTRICTION");
  const base: DecisionInput = {
    judgement: p.judgement,
    lines: p.lines,
    stamps: [],
    ackedHash: null,
    customerId: p.customerId,
    mayOverride,
    driver: p.principal?.role === "DRIVER",
    supportSession,
    blocked: p.blocked,
    held,
    target: p.target ?? null,
  };
  if (rows.length === 0) return buildDecision(base);
  if (!mayOverride) throw raise(base, rows, hashOfRows(rows, p.customerId, p.judgement.basis));

  // Overrides naming a line that is not uncovered are ignored (no error, no stamp).
  const uncoveredKeys = new Set(rows.map((r) => r.lineKey));
  const given = new Map<string, string>();
  for (const o of p.ack?.restrictionOverrides ?? []) {
    if (uncoveredKeys.has(o?.lineKey) && !given.has(o.lineKey))
      given.set(o.lineKey, validReason(o.lineKey, o.reason)); // 400 before any 409
  }
  const hash = hashOfRows(rows, p.customerId, p.judgement.basis);
  if (p.ack?.warningHash !== hash || rows.some((r) => !given.has(r.lineKey)))
    throw warningConflict(rows, hash, p.judgement);

  return buildDecision({
    ...base,
    ackedHash: hash,
    stamps: rows.map((r) => ({
      lineKey: r.lineKey,
      productId: r.breach.productId,
      reason: given.get(r.lineKey)!,
      ruleIds: sortedIds(breachKeys(r.breach)),
    })),
  });
}
