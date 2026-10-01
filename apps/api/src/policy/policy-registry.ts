/**
 * SA-138 phase 1 — the per-tenant POLICY registry.
 *
 * A POLICY is the tenant saying how ITS OWN operation runs; an ENTITLEMENT (feature-registry.ts,
 * plan-catalog.constants.ts) is the platform saying what the tenant MAY USE. The two never meet:
 * no key here starts with `flag.` or matches a FEATURE_REGISTRY key, no `*.guard.ts` imports
 * PolicyService, and no entry is a boolean whose false value removes a capability — an enum value
 * like `disabled` names a BEHAVIOUR of a capability the tenant already has. `policy-registry.spec.ts`
 * pins all three (P2a–P2c).
 *
 * The failure rule is one rule, not per key: a failed or invalid read resolves to `default`, and
 * every `default` IS today's behaviour. That is why an entry carries no `failMode` field.
 *
 * Call-site convention (P1a/P1b scan for it): inject PolicyService as `policies` (or `policy` /
 * `policyService`) and pass the key as a string literal, the second argument of `resolve`.
 *
 * `schema` validates stored JSON at read AND write. It is a zod v4 schema so `GET /policies` can
 * hand the admin UI a JSON-schema of it (`z.toJSONSchema`).
 */
import { z, type ZodType } from "zod/v4";
import type { PolicyScopeType } from "@prisma/client";

export type { PolicyScopeType };

export type PolicyArea = "orders" | "credit" | "invoicing";
export type PolicyKind = "enum" | "money" | "set";

export interface PolicyEntry<T = unknown> {
  /** `<area>.<name>` — the area prefix must equal `area`. */
  key: string;
  area: PolicyArea;
  kind: PolicyKind;
  /** Validates stored JSON at read AND write. */
  schema: ZodType<T>;
  /** Today's behaviour, always — also the value every failed/invalid read resolves to. */
  default: T;
  /** Which scope layers may hold a value for this key. */
  scopes: readonly PolicyScopeType[];
  /** Rendered by the admin UI. */
  description: string;
  /** YYYY-MM-DD the entry was added. */
  added: string;
  /**
   * Phase 1 only: the key has no production call site yet (P1b waived). Shrink-only — each pilot
   * PR removes its key's flag and `POLICY_PILOT_PENDING_ALLOWLIST` entry together (P3).
   */
  pilotPending?: true;
  /**
   * `false` keeps the key out of `TenantFeaturesResponse.modes`, which every tenant-bearing token
   * (buyer, driver) can read. Set it on any policy that is the tenant's INTERNAL business rule
   * rather than something a client renders — the office still reads it through `GET /policies`.
   */
  clientVisible?: false;
}

function entry<T>(e: PolicyEntry<T>): PolicyEntry<T> {
  return e;
}

export const AT_DOOR_EDIT_MODES = ["amend", "replace", "disabled"] as const;
export type AtDoorEditMode = (typeof AT_DOOR_EDIT_MODES)[number];

export const PRICE_DISCLOSURE_FACTS = ["originalPrice", "discount", "msrp"] as const;
export type PriceDisclosureFact = (typeof PRICE_DISCLOSURE_FACTS)[number];

export const POLICY_REGISTRY = [
  entry<AtDoorEditMode>({
    key: "orders.driverAtDoorEdit",
    area: "orders",
    kind: "enum",
    schema: z.enum(AT_DOOR_EDIT_MODES),
    default: "amend",
    scopes: ["TENANT", "CUSTOMER"],
    description:
      "How a driver's at-the-door change to an order is applied: 'amend' adds the change to the " +
      "held quantity (today), 'replace' sets the quantity actually taken, 'disabled' leaves " +
      "at-door edits to the office.",
    added: "2026-09-24",
    pilotPending: true,
  }),
  entry<number | null>({
    key: "credit.approvalThreshold",
    area: "credit",
    kind: "money",
    // Cents-precision, non-negative, finite. `null` = no approval band (today's hard block).
    schema: z
      .number()
      .finite()
      .nonnegative()
      // Tolerance, not ===: 0.29 * 100 is 28.999999999999996 in IEEE-754.
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, {
        message: "must be whole cents",
      })
      .nullable(),
    default: null,
    scopes: ["TENANT", "CUSTOMER"],
    // The seller's credit-risk band: a buyer must never learn how far over its limit it can go.
    clientVisible: false,
    description:
      "How far over a customer's credit limit an office order may go and still be accepted as " +
      "awaiting credit approval. Empty = no band: every order over the limit is blocked (today).",
    added: "2026-09-24",
    pilotPending: true,
  }),
  entry<PriceDisclosureFact[]>({
    key: "invoicing.priceDisclosure",
    area: "invoicing",
    kind: "set",
    schema: z
      .array(z.enum(PRICE_DISCLOSURE_FACTS))
      .refine((a) => new Set(a).size === a.length, { message: "duplicate entries" }),
    default: [...PRICE_DISCLOSURE_FACTS],
    scopes: ["TENANT", "CUSTOMER"],
    description:
      "Which price facts a buyer sees on the buyer portal, invoice PDFs and invoice emails: the " +
      "original (pre-discount) price, the discount, and the MSRP. All three are shown today.",
    added: "2026-09-24",
    pilotPending: true,
  }),
] as const;

/**
 * P3: the ONLY keys that may carry `pilotPending`. Shrink-only — a pilot PR deletes its key here
 * in the same diff that removes the flag and adds the first call site. Never add to this list.
 */
export const POLICY_PILOT_PENDING_ALLOWLIST: readonly string[] = [
  "orders.driverAtDoorEdit",
  "credit.approvalThreshold",
  "invoicing.priceDisclosure",
];

export type PolicyKey = (typeof POLICY_REGISTRY)[number]["key"];

/** The value type a registry key resolves to. */
export type PolicyValueOf<K extends PolicyKey> =
  Extract<(typeof POLICY_REGISTRY)[number], { key: K }> extends PolicyEntry<infer T> ? T : never;

const BY_KEY: ReadonlyMap<string, PolicyEntry<unknown>> = new Map(
  (POLICY_REGISTRY as readonly PolicyEntry<unknown>[]).map((e) => [e.key, e]),
);

export function policyEntry(key: string): PolicyEntry<unknown> | undefined {
  return BY_KEY.get(key);
}

export function isPolicyKey(key: string): key is PolicyKey {
  return BY_KEY.has(key);
}

/** The JSON-schema of an entry's value, for the admin UI (`GET /policies`). */
export function policyJsonSchema(e: PolicyEntry<unknown>): Record<string, unknown> {
  return z.toJSONSchema(e.schema, { unrepresentable: "any" }) as Record<string, unknown>;
}
