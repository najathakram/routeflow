/**
 * Row 510: the client side of the staff restriction warning. Pure (no React, no api-client), so it is unit-testable and
 * the mobile twin (apps/mobile/lib/restriction-warning.ts) is the SAME text below the imports (a web test pins that).
 *
 * The server owns the verdict and the `warningHash`; a client only echoes them (L-303). A staff write that would sell a
 * restricted product answers 409 RESTRICTION_WARNING; the client shows the lines, collects ONE reason, and resubmits the
 * SAME payload plus a RestrictionAck. A DRIVER (who may not override) gets the hard 409 SELLING_RESTRICTED instead.
 */
import {
  API_ERROR_CODES,
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  RESTRICTION_OVERRIDE_REASON_MAX,
  RESTRICTION_OVERRIDE_REASON_MIN,
  SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
  type BlockedLine,
  type RestrictionAck,
  type RestrictionWarningError,
  type RestrictionWarningLine,
  type RestrictionWarningRule,
} from "@routeflow/types";

/** Fixed dialog copy, shared by the web dialog and the mobile modal. */
export const RESTRICTION_COPY = {
  title: "Sell a restricted product?",
  body: "These items are restricted. Add a reason to sell them anyway. The reason is saved with each line.",
  reasonLabel: "Reason",
  reasonPlaceholder: "Why is this sale OK?",
  sellAnyway: "Sell anyway",
  goBack: "Go back",
  legalBadge: "Legal ban",
  unchecked: "This item couldn't be checked.",
  /** A repeat 409 (the server's list changed after "Sell anyway"): the reason is cleared, so say why. */
  listChanged: "The list changed; review it again",
  blockedTitle: DRIVER_RESTRICTION_BLOCK_MESSAGE,
  blockedBody: "These items can't be sold from here.",
  ok: "OK",
} as const;

type AxiosLike =
  { response?: { status?: number; data?: Record<string, unknown> } } | null | undefined;

/** The 409 RESTRICTION_WARNING body, or null for any other error (a warning with no lines or no hash can't be acknowledged). */
export function parseRestrictionWarning(err: unknown): RestrictionWarningError | null {
  const res = (err as AxiosLike)?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.RESTRICTION_WARNING) return null;
  const { lines, warningHash } = res.data as Partial<RestrictionWarningError>;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (typeof warningHash !== "string" || warningHash === "") return null;
  return res.data as unknown as RestrictionWarningError;
}

/** The two fixed sentences of a hard block that has no override: a DRIVER's, and a support session's. */
const OVERRIDE_BLOCK_MESSAGES: readonly string[] = [
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
];

/**
 * The hard block a principal who can't override gets (409 SELLING_RESTRICTED with one of the two fixed sentences: a
 * DRIVER's "Ask the office to approve this sale", or a support session's "Ask the account admin"): no override exists.
 * `message` echoes the server's sentence, which the modal titles itself with.
 */
export function parseRestrictionHardBlock(
  err: unknown,
): { message: string; lines: BlockedLine[]; ruleLines: RestrictionWarningLine[] } | null {
  const res = (err as AxiosLike)?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.SELLING_RESTRICTED) return null;
  const message = res.data.message;
  if (typeof message !== "string" || !OVERRIDE_BLOCK_MESSAGES.includes(message)) return null;
  const lines = Array.isArray(res.data.blockedLines)
    ? (res.data.blockedLines as BlockedLine[])
    : [];
  const ruleLines = Array.isArray(res.data.lines)
    ? (res.data.lines as RestrictionWarningLine[])
    : [];
  return { message, lines, ruleLines };
}

export interface BlockRow {
  key: string;
  name: string;
  items: { text: string; legal: boolean }[];
}

/** One displayed rule line of a product. */
export interface RuleRow {
  key: string;
  text: string;
  legal: boolean;
}

/**
 * The rule lines to DISPLAY for one product: two rules with the same state(s) and the same wording show ONE line (the
 * wording is the whole message to the user), and the line is legal if any merged rule is. Display only: the ack and the
 * server's `warningHash` still cover every rule, because they are built from the lines and the hash, never from these rows.
 */
export function lineRuleRows(rules: readonly RestrictionWarningRule[]): RuleRow[] {
  const rows = new Map<string, RuleRow>();
  for (const r of rules) {
    const text = ruleText(r);
    const key = `${[...r.states].sort().join(",")}|${text}`;
    const have = rows.get(key);
    if (have) have.legal = have.legal || r.legal;
    else rows.set(key, { key, text, legal: r.legal });
  }
  return [...rows.values()];
}

/** The driver block's rows from the server's per-line rules: the SAME text and legal flag staff see. */
export function driverBlockRows(ruleLines: RestrictionWarningLine[]): BlockRow[] {
  return ruleLines.map((l) => ({
    key: l.lineKey,
    name: l.displayName,
    items:
      l.rules.length === 0
        ? [{ text: RESTRICTION_COPY.unchecked, legal: false }]
        : lineRuleRows(l.rules).map(({ text, legal }) => ({ text, legal })),
  }));
}

/**
 * Is `nextHash` the answer to the re-send of an earlier warning, with a DIFFERENT list? `sentHash` is the hash the user
 * just acknowledged (null when no re-send is pending: a first warning). A different hash is "the list changed", so the
 * reason typed for the old list is dropped, never reused. The same hash is not a repeat, and no clock decides it.
 */
export function isRepeatWarning(sentHash: string | null, nextHash: string): boolean {
  return sentHash !== null && sentHash !== nextHash;
}

export interface ReasonCheck {
  ok: boolean;
  /** The trimmed reason: what is sent. */
  value: string;
  /** Trimmed length (what the counter shows). */
  length: number;
  error: string | null;
}

/** Live validation of the one reason field: trimmed, MIN..MAX (the server applies the same rule after trim). */
export function checkOverrideReason(raw: string): ReasonCheck {
  const value = raw.trim();
  const length = value.length;
  if (length < RESTRICTION_OVERRIDE_REASON_MIN) {
    return {
      ok: false,
      value,
      length,
      error: `Add a reason (at least ${RESTRICTION_OVERRIDE_REASON_MIN} characters).`,
    };
  }
  if (length > RESTRICTION_OVERRIDE_REASON_MAX) {
    return {
      ok: false,
      value,
      length,
      error: `Shorten the reason to ${RESTRICTION_OVERRIDE_REASON_MAX} characters or fewer.`,
    };
  }
  return { ok: true, value, length, error: null };
}

/** The ack for a reason: the SAME reason for every listed line, plus the server's hash echoed untouched. */
export function buildAck(warning: RestrictionWarningError, reason: string): RestrictionAck {
  const check = checkOverrideReason(reason);
  if (!check.ok) throw new Error(check.error ?? "Invalid reason");
  return {
    restrictionOverrides: warning.lines.map((l) => ({ lineKey: l.lineKey, reason: check.value })),
    warningHash: warning.warningHash,
  };
}

/** A mutation whose variable is a bare id may also carry an ack: `"o1"` or `{ id: "o1", ...ack }`. */
export type IdWithAck = string | ({ id: string } & RestrictionAck);

/**
 * The original payload plus the ack (top-level fields); no ack returns the payload itself. A bare id stays a bare id
 * until there is an ack to carry, so an existing `mutate(id)` call keeps its shape.
 */
export function mergeAck(payload: string, ack: RestrictionAck | null | undefined): IdWithAck;
export function mergeAck<T extends object>(payload: T, ack: RestrictionAck | null | undefined): T;
export function mergeAck(payload: string | object, ack: RestrictionAck | null | undefined) {
  if (!ack) return payload;
  return typeof payload === "string" ? { id: payload, ...ack } : { ...payload, ...ack };
}

export function splitIdAck(v: IdWithAck): { id: string; ack: RestrictionAck | undefined } {
  if (typeof v === "string") return { id: v, ack: undefined };
  const { id, ...ack } = v;
  return { id, ack: Object.keys(ack).length > 0 ? (ack as RestrictionAck) : undefined };
}

/** One rule's sentence: the server's fixed copy, else the legal sentence built from the states. */
export function ruleText(rule: RestrictionWarningRule): string {
  if (rule.reasonText) return rule.reasonText;
  if (rule.legal && rule.states.length > 0) {
    return `This product is banned in ${rule.states.join(", ")} by law.`;
  }
  return RESTRICTION_COPY.unchecked;
}
