/**
 * SA-138 §3.1 — POLICY_REGISTRY pins.
 *
 * P1a every `…resolve(<tenant>, "<key>"` literal in apps/api/src is a registry key; P1b every key
 * without `pilotPending` has ≥ 1 production call site; P1c each default validates against its own
 * schema; P1d keys are unique and `<area>.<name>`-shaped. P2a–P2c are the §1 "policy ≠ entitlement"
 * pins. P3 keeps `pilotPending` shrink-only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import { FLAG_KEYS } from "../billing/plan-catalog.constants";
import {
  POLICY_PILOT_PENDING_ALLOWLIST,
  POLICY_REGISTRY,
  policyJsonSchema,
  type PolicyEntry,
} from "./policy-registry";

const SRC_ROOT = path.resolve(__dirname, "..");
const ENTRIES = POLICY_REGISTRY as readonly PolicyEntry<unknown>[];
const KEYS = ENTRIES.map((e) => e.key);

/** The three phase-1 pilots — the CEILING of the pilotPending allow-list (P3). Never add here. */
const PHASE1_PILOTS = [
  "orders.driverAtDoorEdit",
  "credit.approvalThreshold",
  "invoicing.priceDisclosure",
];

function sourceFiles(filter: (rel: string) => boolean): string[] {
  return (fs.readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .map(String)
    .filter((f) => f.endsWith(".ts") && filter(f))
    .map((f) => path.join(SRC_ROOT, f));
}

const isSpec = (f: string) => /\.spec\.ts$/.test(f);

/**
 * key -> production files that resolve it. A call site is a `policy`/`policies`/`policyService`
 * receiver calling `.resolve(<tenant expr>, "<key>"` (or `.get(` — reserved for a future alias).
 */
function callSites(): Map<string, string[]> {
  const re =
    /\b(?:policy|policies|policyService)\s*\.\s*(?:resolve|get)\s*(?:<[^>]*>)?\(\s*[^,()]+,\s*["'`]([^"'`]+)["'`]/g;
  const sites = new Map<string, string[]>();
  for (const file of sourceFiles((f) => !isSpec(f))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) {
      const list = sites.get(m[1]) ?? [];
      list.push(path.relative(SRC_ROOT, file));
      sites.set(m[1], list);
    }
  }
  return sites;
}

describe("POLICY_REGISTRY pins (SA-138 §3.1)", () => {
  const sites = callSites();

  it("P1a: every policy key literal resolved in apps/api/src is a registry key", () => {
    const unknown = [...sites.keys()].filter((k) => !KEYS.includes(k));
    expect(unknown).toEqual([]);
  });

  it("P1a (self-test): the call-site scanner recognises the resolve shape it pins", () => {
    const re =
      /\b(?:policy|policies|policyService)\s*\.\s*(?:resolve|get)\s*(?:<[^>]*>)?\(\s*[^,()]+,\s*["'`]([^"'`]+)["'`]/g;
    const sample = `await this.policies.resolve(tenantId, "credit.approvalThreshold", { customerId })`;
    expect([...sample.matchAll(re)].map((m) => m[1])).toEqual(["credit.approvalThreshold"]);
  });

  it("P1b: every key without pilotPending has at least one production call site", () => {
    const stale = ENTRIES.filter((e) => !e.pilotPending)
      .map((e) => e.key)
      .filter((k) => (sites.get(k)?.length ?? 0) === 0);
    expect(stale).toEqual([]);
  });

  it("P1c: each default validates against its own schema", () => {
    const bad = ENTRIES.filter((e) => !e.schema.safeParse(e.default).success).map((e) => e.key);
    expect(bad).toEqual([]);
  });

  it("P1c: each schema renders to a JSON-schema for the admin UI", () => {
    for (const e of ENTRIES) expect(typeof policyJsonSchema(e)).toBe("object");
  });

  it("P1d: keys are unique and `<area>.<name>`-shaped, with the prefix equal to `area`", () => {
    expect(new Set(KEYS).size).toBe(KEYS.length);
    const malformed = ENTRIES.filter(
      (e) => !/^[a-z]+\.[a-zA-Z][a-zA-Z0-9]*$/.test(e.key) || e.key.split(".")[0] !== e.area,
    ).map((e) => e.key);
    expect(malformed).toEqual([]);
  });

  it("P1d: every entry has a real `added` date, a description, and a non-empty scope list", () => {
    const bad = ENTRIES.filter(
      (e) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(e.added) ||
        Number.isNaN(Date.parse(`${e.added}T00:00:00Z`)) ||
        e.description.trim().length === 0 ||
        e.scopes.length === 0 ||
        new Set(e.scopes).size !== e.scopes.length ||
        e.scopes.some((s) => !["TENANT", "CATEGORY", "CUSTOMER"].includes(s)),
    ).map((e) => e.key);
    expect(bad).toEqual([]);
  });

  it("P2a: no key lives in the entitlement namespace — no `flag.` prefix, no FEATURE_REGISTRY or plan-flag key", () => {
    const featureKeys = new Set<string>([...FEATURE_REGISTRY.map((f) => f.key), ...FLAG_KEYS]);
    expect(KEYS.filter((k) => k.startsWith("flag."))).toEqual([]);
    expect(KEYS.filter((k) => featureKeys.has(k))).toEqual([]);
  });

  it("P2b: no entry is a boolean capability switch, and none carries a per-key failMode", () => {
    const boolish = ENTRIES.filter(
      (e) =>
        typeof e.default === "boolean" ||
        e.schema.safeParse(true).success ||
        e.schema.safeParse(false).success,
    ).map((e) => e.key);
    expect(boolish).toEqual([]);
    // §2: one failure rule (default = today), so no entry may declare its own.
    expect(ENTRIES.filter((e) => Object.hasOwn(e, "failMode")).map((e) => e.key)).toEqual([]);
    expect(ENTRIES.every((e) => ["enum", "money", "set"].includes(e.kind))).toBe(true);
  });

  it("P2d: the credit approval band is server-only — never carried to clients through `modes`", () => {
    const credit = ENTRIES.find((e) => e.key === "credit.approvalThreshold");
    expect(credit?.clientVisible).toBe(false);
  });

  it("P2c: PolicyService / the policy registry is never imported by a *.guard.ts", () => {
    const offenders = sourceFiles((f) => f.endsWith(".guard.ts"))
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8");
        return /policy\/policy(\.service|-registry)|\bPolicyService\b/.test(text);
      })
      .map((f) => path.relative(SRC_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("P3: pilotPending is shrink-only — every flagged key is allow-listed, the list never grows past the phase-1 pilots, and every listed key is still flagged", () => {
    const flagged = ENTRIES.filter((e) => e.pilotPending).map((e) => e.key);
    expect(flagged.filter((k) => !POLICY_PILOT_PENDING_ALLOWLIST.includes(k))).toEqual([]);
    expect(POLICY_PILOT_PENDING_ALLOWLIST.filter((k) => !PHASE1_PILOTS.includes(k))).toEqual([]);
    expect(POLICY_PILOT_PENDING_ALLOWLIST.filter((k) => !flagged.includes(k))).toEqual([]);
  });
});
