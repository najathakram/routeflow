import type { TenantKind } from "./tenant-context.service";

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

type Violation = "MISSING" | "SUPER_ADMIN_CREATE";
const WINDOW_MS = 60_000;
const STACK_FRAMES = 5;

export class TenantContextGuard {
  private readonly counts = new Map<Violation, number>();
  private readonly reasons = new Map<string, number>();
  private readonly lastWarn = new Map<string, number>();
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
  missingContext(kind: TenantKind, where: string): void {
    this.report("MISSING", `${kind}|${where}`, `kind=${kind} at=${where}`, () => {
      throw new TenantContextMissingError(`No tenant context (${kind}) at ${where}`);
    });
  }

  /** A SUPER_ADMIN tenant-owned create with no explicit tenantId (the L-124 null-tenant class). */
  superAdminCreate(model: string, operation: string, kind: TenantKind = "SUPER_ADMIN"): void {
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
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }

  private report(v: Violation, siteKey: string, detail: string, fail: () => never): void {
    this.counts.set(v, this.count(v) + 1);
    if (this.enforce) fail();
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
 * A row names its tenant when its data carries a `tenantId` KEY: a value, or an explicit `null` (a
 * deliberate platform row such as a global system-config setting; several models' tenantId is nullable
 * by design). Only an ABSENT key is the L-124 null-tenant-by-omission class.
 */
const hasTenant = (d: unknown) => !!d && typeof d === "object" && "tenantId" in (d as object);

/**
 * The ONE create check: a create / createMany / createManyAndReturn / upsert on a tenant-owned model
 * whose data carries no tenantId is reported (warn dark, throw enforced). Every other operation, and
 * every platform model, passes. Shared by the SUPER_ADMIN client extension and the raw-tx proxy.
 */
export function checkCreateHasTenant(
  guard: Pick<TenantContextGuard, "superAdminCreate">,
  isTenantOwned: (model: string) => boolean,
  model: string,
  operation: string,
  args: any,
  kind: TenantKind = "SUPER_ADMIN",
): void {
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
) {
  return {
    query: {
      $allModels: {
        async $allOperations({ args, query, model, operation }: any) {
          checkCreateHasTenant(guard, isTenantOwned, model, operation, args);
          return query(args);
        },
      },
    },
  };
}

const WRITE_OPS = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);

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
