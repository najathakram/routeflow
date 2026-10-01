import type { TenantKind } from "./tenant-context.service";
import { findNestedWithoutTenant } from "./nested-tenant-walk";

/**
 * SA-619 PR-1: what happens when `forTenant()` / `tenantTransaction()` runs with no tenant scope, or
 * a SUPER_ADMIN creates a tenant-owned row without a tenantId. DARK first: one de-duplicated
 * structured warn (TENANT_CONTEXT_MISSING) plus a counter, behaviour unchanged. Enforced
 * (TENANT_CONTEXT_ENFORCE=true, read ONCE at boot) it throws TenantContextMissingError instead.
 */
export class TenantContextMissingError extends Error {
  constructor(detail: string) {
    super(
      `${detail}. Run the work inside a tenant context (tenantCtx.run) or, for legitimate ` +
        `cross-tenant work, use prisma.forSystem("<reason>").`,
    );
    this.name = "TenantContextMissingError";
  }
}

/** Enforcement is opt-in and exact: only "true" or "1"; anything else (incl. unknown) stays dark. */
export function readEnforceFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.TENANT_CONTEXT_ENFORCE;
  return v === "true" || v === "1";
}

type Violation = "MISSING" | "SUPER_ADMIN_CREATE" | "NESTED_CROSS_TENANT" | "NESTED_DEPTH";
const WINDOW_MS = 60_000;
const STACK_FRAMES = 5;
/** Dark mode captures a context-less call site at most this often per kind (a stack per hit is a hot-path cost). */
const CAPTURE_GAP_MS = 1_000;

/** The most distinct sites kept in `stats()`; the rest collapse into "other" (totals stay exact). */
const MAX_SITES = 100;
const MAX_REASONS = 200;
const MAX_REASON_LENGTH = 120;

export interface TenantContextStats {
  enforce: boolean;
  /** When this process started counting (ISO). */
  since: string;
  counts: Record<Violation, number>;
  byKind: Record<string, number>;
  /** Noisiest first; a site key is `<violation>|<kind>|<caller file:line | model.op>`: never a stack or data. */
  sites: Array<{ site: string; count: number }>;
  systemReasons: Record<string, number>;
}

export class TenantContextGuard {
  private readonly counts = new Map<Violation, number>();
  private readonly kindCounts = new Map<string, number>();
  private readonly siteCounts = new Map<string, number>();
  private readonly started: number;
  private readonly reasons = new Map<string, number>();
  private readonly lastWarn = new Map<string, number>();
  private readonly lastCapture = new Map<string, number>();
  private readonly enforce: boolean;
  private readonly log: { warn(message: string): void };
  private readonly now: () => number;

  constructor(opts: {
    enforce: boolean;
    log: { warn(message: string): void };
    now?: () => number;
  }) {
    this.enforce = opts.enforce;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.started = this.now();
  }

  /**
   * The counters, readable (SA-619 PR-2a): "72 h of zero warns" is `counts` staying 0 since `since`.
   * Counts are exact; `sites` are sampled (dark mode captures a site at most once per kind per second).
   */
  stats(): TenantContextStats {
    const sites = [...this.siteCounts.entries()]
      .map(([site, count]) => ({ site, count }))
      .sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));
    return {
      enforce: this.enforce,
      since: new Date(this.started).toISOString(),
      counts: {
        MISSING: this.count("MISSING"),
        SUPER_ADMIN_CREATE: this.count("SUPER_ADMIN_CREATE"),
        NESTED_CROSS_TENANT: this.count("NESTED_CROSS_TENANT"),
        NESTED_DEPTH: this.count("NESTED_DEPTH"),
      },
      byKind: Object.fromEntries(this.kindCounts),
      sites,
      systemReasons: this.systemReasons(),
    };
  }

  /** One structured log line carrying `stats()` (zeros included). */
  statsLine(): string {
    return `TENANT_CONTEXT_STATS ${JSON.stringify(this.stats())}`;
  }

  private bumpSite(key: string): void {
    if (this.siteCounts.has(key) || this.siteCounts.size < MAX_SITES)
      this.siteCounts.set(key, (this.siteCounts.get(key) ?? 0) + 1);
    else this.siteCounts.set("other", (this.siteCounts.get("other") ?? 0) + 1);
  }

  /** How many times a violation was seen (every hit, not just the logged ones). */
  count(v: Violation): number {
    return this.counts.get(v) ?? 0;
  }

  /** `forSystem(reason)` uses seen so far, by reason. */
  systemReasons(): Record<string, number> {
    return Object.fromEntries(this.reasons);
  }

  /** `forTenant()` / `tenantTransaction()` ran with no tenant scope (ANONYMOUS / NONE / SYSTEM). */
  missingContext(kind: TenantKind, where: string | (() => string)): void {
    // `where` may be a thunk: capturing a call site means building a stack, which on a hot context-less
    // path (webhooks, anonymous buyers) must not happen per hit. Dark: at most one capture per kind per
    // CAPTURE_GAP_MS (the counter still counts every hit); enforced: the throw needs the site, so capture.
    this.bump("MISSING");
    this.kindCounts.set(kind, (this.kindCounts.get(kind) ?? 0) + 1);
    const site = typeof where === "function" ? where : () => where;
    if (this.enforce) {
      const w = site();
      this.bumpSite(`MISSING|${kind}|${w}`);
      throw new TenantContextMissingError(`No tenant context (${kind}) at ${w}`);
    }
    const t = this.now();
    const last = this.lastCapture.get(kind);
    if (last !== undefined && t - last < CAPTURE_GAP_MS) return;
    this.lastCapture.set(kind, t);
    const w = site();
    this.bumpSite(`MISSING|${kind}|${w}`);
    this.warnOnce("MISSING", `${kind}|${w}`, `kind=${kind} at=${w}`);
  }

  /** Whether this guard throws (TENANT_CONTEXT_ENFORCE) instead of warning. */
  get enforcing(): boolean {
    return this.enforce;
  }

  /**
   * SA-620c: a nested write the tenant walker had to repair (DARK): a cross-tenant child overridden with the
   * context tenant, or the depth cap hit. A warn + counter; the walker itself throws when enforced, so this is
   * only reached in dark mode (in ENFORCED mode these NESTED_* counters UNDERCOUNT: the walker throws first). `detail` is model + path: never a tenant id or row data.
   */
  nestedViolation(kind: "CROSS_TENANT_CHILD" | "DEPTH", detail: string): void {
    const v: Violation = kind === "DEPTH" ? "NESTED_DEPTH" : "NESTED_CROSS_TENANT";
    this.bumpSite(`${v}|${detail}`);
    this.report(v, detail, `nested=${kind} ${detail}`, () => {
      throw new TenantContextMissingError(`Nested ${kind}: ${detail}`);
    });
  }

  /** A SUPER_ADMIN tenant-owned create with no explicit tenantId (the L-124 null-tenant class). */
  superAdminCreate(model: string, operation: string, kind: TenantKind = "SUPER_ADMIN"): void {
    this.kindCounts.set(kind, (this.kindCounts.get(kind) ?? 0) + 1);
    this.bumpSite(`SUPER_ADMIN_CREATE|${kind}|${model}.${operation}`);
    this.report(
      "SUPER_ADMIN_CREATE",
      `${kind}|${model}.${operation}`,
      `kind=${kind} model=${model} op=${operation}`,
      () => {
        throw new TenantContextMissingError(
          `${kind} ${operation} on tenant-owned ${model} needs an explicit tenantId`,
        );
      },
    );
  }

  /** The one explicit unscoped door: only the reason is recorded. */
  system(reason: string): void {
    if (typeof reason !== "string" || reason.trim() === "")
      throw new Error("forSystem(reason): a non-empty literal reason is required");
    // Bounded like the sites: a reason is a short literal; a runaway one cannot grow the map or the endpoint.
    const key = reason.length > MAX_REASON_LENGTH ? reason.slice(0, MAX_REASON_LENGTH) : reason;
    if (this.reasons.has(key) || this.reasons.size < MAX_REASONS)
      this.reasons.set(key, (this.reasons.get(key) ?? 0) + 1);
    else this.reasons.set("other", (this.reasons.get("other") ?? 0) + 1);
  }

  private bump(v: Violation): void {
    this.counts.set(v, this.count(v) + 1);
  }

  private report(v: Violation, siteKey: string, detail: string, fail: () => never): void {
    this.bump(v);
    if (this.enforce) fail();
    this.warnOnce(v, siteKey, detail);
  }

  /** One structured warn per site per WINDOW_MS (with a bounded stack); the counter is separate. */
  private warnOnce(v: Violation, siteKey: string, detail: string): void {
    const key = `${v}|${siteKey}`;
    const t = this.now();
    const last = this.lastWarn.get(key);
    if (last !== undefined && t - last < WINDOW_MS) return;
    this.lastWarn.set(key, t);
    const stack = (new Error().stack ?? "")
      .split("\n")
      .filter((l) => /^\s+at /.test(l) && !l.includes("tenant-context-guard"))
      .slice(0, STACK_FRAMES)
      .join("\n");
    this.log.warn(`TENANT_CONTEXT_MISSING ${v} ${detail}\n${stack}`);
  }
}

/**
 * A row names its tenant when `data.tenantId` is a value or an explicit `null` (a deliberate platform
 * row such as a global system-config setting; several models' tenantId is nullable by design). An
 * ABSENT key and `tenantId: undefined` (which Prisma treats as "not set" and writes as NULL) are the
 * L-124 null-tenant-by-omission class.
 */
const hasTenant = (d: unknown) =>
  !!d && typeof d === "object" && (d as { tenantId?: unknown }).tenantId !== undefined;

/**
 * The ONE create check: a create / createMany / createManyAndReturn / upsert on a tenant-owned model
 * whose data carries no tenantId is reported (warn dark, throw enforced), and (SA-620) so is every NESTED
 * tenant-owned create inside a create / upsert / update / updateMany (the same walker that stamps them).
 * Every other operation, and every platform model, passes. Shared by the SUPER_ADMIN client extension and the raw-tx proxy.
 */
export function checkCreateHasTenant(
  guard: Pick<TenantContextGuard, "superAdminCreate">,
  isTenantOwned: (model: string) => boolean,
  model: string,
  operation: string,
  args: any,
  kind: TenantKind = "SUPER_ADMIN",
): void {
  // SA-620: the nested children are checked by the SAME walker that stamps them on the TENANT path, on
  // every write that can carry a nested create (create, upsert, update, updateMany), for any parent.
  const nestedData =
    operation === "upsert"
      ? [args?.create, args?.update]
      : operation === "create" ||
          operation === "update" ||
          operation === "updateMany" ||
          operation === "updateManyAndReturn"
        ? [args?.data]
        : [];
  for (const d of nestedData)
    for (const child of findNestedWithoutTenant(model, d))
      guard.superAdminCreate(child.model, "create", kind);
  if (!isTenantOwned(model)) return;
  if (operation === "create" && !hasTenant(args?.data))
    guard.superAdminCreate(model, operation, kind);
  else if (
    (operation === "createMany" || operation === "createManyAndReturn") &&
    !(Array.isArray(args?.data) ? args.data.every(hasTenant) : hasTenant(args?.data))
  )
    guard.superAdminCreate(model, operation, kind);
  else if (operation === "upsert" && !hasTenant(args?.create))
    guard.superAdminCreate(model, operation, kind);
}

/**
 * A Prisma client extension for a SUPER_ADMIN context: the create check above runs before every
 * operation; the query always runs unchanged. Reads and every other operation pass straight through.
 */
export function superAdminCreateExtension(
  guard: Pick<TenantContextGuard, "superAdminCreate">,
  isTenantOwned: (model: string) => boolean,
  kind: TenantKind = "SUPER_ADMIN",
) {
  return {
    query: {
      $allModels: {
        async $allOperations({ args, query, model, operation }: any) {
          checkCreateHasTenant(guard, isTenantOwned, model, operation, args, kind);
          return query(args);
        },
      },
    },
  };
}

const WRITE_OPS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "upsert",
  // an update can carry a nested create (SA-620); only the nested children are checked, never the row
  "update",
  "updateMany",
  "updateManyAndReturn",
]);

/**
 * SA-619a: a transaction proxy for every NON-TENANT kind. Only the WRITE methods of tenant-owned
 * models are intercepted (the create check, then the call with its arguments untouched); reads,
 * `$`-prefixed client members and everything else pass through unscoped, as ruled for SUPER_ADMIN.
 */
export function wrapTxWithCreateCheck(
  rawTx: any,
  guard: Pick<TenantContextGuard, "superAdminCreate">,
  isTenantOwned: (model: string) => boolean,
  kind: TenantKind = "SUPER_ADMIN",
): any {
  return new Proxy(rawTx, {
    get(target, name) {
      const delegate = target[name];
      if (
        !delegate ||
        typeof delegate !== "object" ||
        typeof name !== "string" ||
        name.startsWith("$") ||
        name.startsWith("_")
      )
        return typeof delegate === "function" ? delegate.bind(target) : delegate;
      // A model delegate is the model name with a lower-case first letter.
      const model = name.charAt(0).toUpperCase() + name.slice(1);
      return new Proxy(delegate, {
        get(modelTarget, method) {
          const fn = modelTarget[method];
          if (typeof fn !== "function" || typeof method !== "string" || !WRITE_OPS.has(method))
            return typeof fn === "function" ? fn.bind(modelTarget) : fn;
          return (args: any = {}) => {
            checkCreateHasTenant(guard, isTenantOwned, model, method, args, kind);
            return fn.call(modelTarget, args);
          };
        },
      });
    },
  });
}
