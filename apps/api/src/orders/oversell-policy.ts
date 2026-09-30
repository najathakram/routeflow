/**
 * WS9 backorder policy: pure, injected-reader modules. No DB, no schema.
 * The adapter onto the PolicyValue resolver (#1337) lands later.
 */

export type OversellPolicy = "off" | "backorder";

export type OversellSource = "staff_entry" | "buyer" | "promotion" | "edit" | "template_cron";

export type OversellRole =
  "TENANT_ADMIN" | "OPERATOR" | "CUSTOMER" | "DRIVER" | "SUPER_ADMIN" | string;

export interface OversellPolicyReader {
  read(args: { tenantId: string; customerId?: string | null }): Promise<unknown>;
}

/** Fail closed: ONLY the exact string "backorder" enables backorders. */
export function parseOversellPolicy(raw: unknown): OversellPolicy {
  return raw === "backorder" ? "backorder" : "off";
}

const STAFF_ROLES: ReadonlySet<string> = new Set(["TENANT_ADMIN", "OPERATOR", "SUPER_ADMIN"]);

/**
 * The ONE predicate: may this actor oversell (order past available stock)?
 * - staff roles: always true, policy not read.
 * - DRIVER: always false, policy not read.
 * - source "template_cron": true, policy not read. This is current behaviour
 *   (pending owner question Q6): the standing-order cron oversells silently today.
 * - CUSTOMER: only when the resolved policy is exactly "backorder".
 * A throwing reader yields false (fail closed); never rejects. Reads at most once.
 */
export async function resolveOversellAllowed(
  reader: OversellPolicyReader,
  args: {
    tenantId: string;
    role: OversellRole;
    source: OversellSource;
    customerId?: string | null;
  },
): Promise<boolean> {
  if (STAFF_ROLES.has(args.role)) return true;
  if (args.role === "DRIVER") return false;
  if (args.source === "template_cron") return true;
  if (args.role !== "CUSTOMER") return false;
  try {
    const raw = await reader.read({ tenantId: args.tenantId, customerId: args.customerId });
    return parseOversellPolicy(raw) === "backorder";
  } catch {
    return false;
  }
}

/** Quantity of a line that exceeds available stock (qty is Decimal(10,3)). */
export function backorderQtyForLine(args: {
  requested: number;
  available: number;
  allowOversell: boolean;
}): number {
  if (!args.allowOversell) return 0;
  const raw = Math.max(0, args.requested - Math.max(0, args.available));
  return Math.round(raw * 1000) / 1000;
}

export function orderableAndBackorder(args: { stock: number; allowOversell: boolean }): {
  orderable: boolean;
  backorder: boolean;
} {
  if (args.stock > 0) return { orderable: true, backorder: false };
  return args.allowOversell
    ? { orderable: true, backorder: true }
    : { orderable: false, backorder: false };
}
