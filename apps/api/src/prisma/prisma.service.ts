import { Injectable, OnModuleInit, OnModuleDestroy, Optional } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { TenantContextService } from "../tenant/tenant-context.service";

/**
 * The exact error Prisma's own `*OrThrow` operations raise when no row matches
 * (P2025). Cross-tenant reads must be indistinguishable from "not found", so a
 * foreign-tenant row rejects with this instead of resolving.
 */
function tenantNotFound(model: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`No ${model} found`, {
    code: "P2025",
    clientVersion: Prisma.prismaVersion.client,
  });
}

/**
 * Models that carry a scalar `tenantId` column, derived from the generated client
 * (`Prisma.ModelName` x `Prisma.<Model>ScalarFieldEnum`) — never a hand-written list, so a
 * model added later is covered the day it lands (pinned by `tenant-unique-lookup.spec.ts`).
 * The set is keyed BOTH ways: the PascalCase model name the `$extends` handler receives
 * (`Customer`) and the camelCase delegate key the transaction proxy sees (`customer`).
 * Built lazily on first use.
 */
let tenantModelKeys: ReadonlySet<string> | undefined;
export function getTenantModelNames(): ReadonlySet<string> {
  if (!tenantModelKeys) {
    const keys = new Set<string>();
    for (const name of Object.keys(Prisma.ModelName)) {
      const fields = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[
        `${name}ScalarFieldEnum`
      ];
      if (fields && "tenantId" in fields) {
        keys.add(name);
        keys.add(name.charAt(0).toLowerCase() + name.slice(1));
      }
    }
    tenantModelKeys = keys;
  }
  return tenantModelKeys;
}

/** `model` is a model name (`Order`, extension layer) or a client delegate key (`order`,
 *  transaction-proxy layer). */
export function isTenantModel(model: string): boolean {
  return !!model && getTenantModelNames().has(model);
}

/**
 * Fail closed at boot: if the derived tenant-model set is empty or misses a model that is known
 * to be tenant-scoped, the guard would silently leave unique lookups unscoped, so refuse to load.
 */
const EXPECTED_TENANT_MODELS = ["Customer", "Order", "Invoice"];
export function assertTenantModelSet(names: ReadonlySet<string>): void {
  const missing = EXPECTED_TENANT_MODELS.flatMap((m) => [
    m,
    m.charAt(0).toLowerCase() + m.slice(1),
  ]).filter((m) => !names.has(m));
  if (names.size === 0 || missing.length > 0) {
    throw new Error(
      `tenant guard: derived tenant-model set is incomplete (size ${names.size}, missing: ${missing.join(", ") || "-"})`,
    );
  }
}
assertTenantModelSet(getTenantModelNames());

/**
 * ONE implementation of the `findUnique` / `findUniqueOrThrow` tenant guard, shared by the
 * `forTenant()` extension and the `tenantTransaction` proxy so the two layers cannot drift.
 *
 * - Non-tenant models pass through untouched.
 * - For a tenant model the tenant filter travels in the query itself: Prisma accepts
 *   non-unique filters beside the unique selector in a unique `where`, so the lookup is
 *   scoped exactly like the other verbs, whatever the caller's `select` returns.
 * - The result is still checked afterwards as defense in depth, and that check fails CLOSED:
 *   a row whose `tenantId` is missing or different is treated as not found. So the check
 *   stays meaningful when a caller's `select` leaves the column out, `tenantId` is added to
 *   the selection for the query and removed again from what the caller receives.
 */
export async function runTenantUniqueLookup(opts: {
  model: string;
  operation: "findUnique" | "findUniqueOrThrow";
  args: any;
  tenantId: string;
  run: (args: any) => Promise<any>;
}): Promise<any> {
  const { model, operation, tenantId, run } = opts;
  if (!isTenantModel(model)) return run(opts.args);

  const args: any = { ...(opts.args ?? {}) };
  args.where = { ...args.where, tenantId };

  let stripTenantId = false;
  if (args.select && args.select.tenantId !== true) {
    args.select = { ...args.select, tenantId: true };
    stripTenantId = true;
  } else if (args.omit && args.omit.tenantId) {
    args.omit = { ...args.omit, tenantId: false };
    stripTenantId = true;
  }

  const result = await run(args);
  if (result == null || result.tenantId !== tenantId) {
    if (operation === "findUniqueOrThrow") throw tenantNotFound(model);
    return null;
  }
  if (stripTenantId) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId: _scopeOnly, ...rest } = result;
    return rest;
  }
  return result;
}

/**
 * SA-394 (#2201): true iff `db` is a Prisma 7 interactive-transaction client, raw or wrapped by
 * `tenantTransaction`'s tenant Proxy (which passes `$`-prefixed keys straight through).
 *
 * Do NOT test for `$transaction`: Prisma 7 builds the tx client as a "nested" client that still
 * exposes `$transaction` (for savepoints), so that test is always false on a real DB. What a tx
 * client lacks is the runtime's itx deny-list (`$connect`, `$disconnect`, `$on`, `$use`,
 * `$extends` read as undefined). A base client and a `forTenant()` (`$extends`ed) client keep
 * `$connect`. `null`/`undefined` is not a transaction.
 */
export function isTxClient(db: unknown): boolean {
  return db != null && typeof (db as { $connect?: unknown }).$connect !== "function";
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Optional() private readonly tenantCtx?: TenantContextService) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Returns the current request's tenantId (null for SUPER_ADMIN / unset context). */
  getTenantId(): string | null {
    return this.tenantCtx?.getOrNull() ?? null;
  }

  /**
   * Tenant-aware transaction wrapper. The `tx` passed to the callback has the
   * same forTenant() auto-injection as the regular client, so creates inside
   * the transaction automatically receive the current tenantId.
   *
   * Usage: replace `this.prisma.$transaction(async (tx) => {...})`
   *        with   `this.prisma.tenantTransaction(async (tx) => {...})`
   */
  async tenantTransaction<T>(
    fn: (tx: any) => Promise<T>,
    options?: Parameters<PrismaClient["$transaction"]>[1],
  ): Promise<T> {
    const tenantId = this.getTenantId();
    return this.$transaction(async (rawTx: any) => {
      // Layer 3: set PostgreSQL session variable for RLS policies
      if (tenantId) {
        await rawTx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      } else {
        await rawTx.$executeRaw`SELECT set_config('app.current_tenant_id', '', true)`;
      }
      if (!tenantId) return fn(rawTx);
      return fn(this._wrapTxWithTenant(rawTx, tenantId));
    }, options as any);
  }

  /**
   * Creates a JavaScript Proxy around a Prisma transaction client that
   * auto-injects tenantId into all write/read operations. Used because
   * the PrismaPg driver adapter does not support $extends on transaction clients.
   */
  private _wrapTxWithTenant(rawTx: any, tenantId: string): any {
    // Every method a Prisma 7 model delegate exposes must land in exactly one of the
    // sets below or in the explicit throw at the bottom of the model proxy — nothing
    // may fall through unscoped. Enumerated from the generated client
    // (`Object.getOwnPropertyNames` walked over a delegate and its prototype chain):
    //   aggregate · aggregateRaw · count · create · createMany · createManyAndReturn ·
    //   delete · deleteMany · findFirst · findFirstOrThrow · findMany · findRaw ·
    //   findUnique · findUniqueOrThrow · groupBy · update · updateMany ·
    //   updateManyAndReturn · upsert
    const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);
    const SCOPED_METHODS = new Set([
      "findMany",
      "findFirst",
      "findFirstOrThrow",
      "count",
      "update",
      "updateMany",
      "updateManyAndReturn",
      "delete",
      "deleteMany",
      "aggregate",
      "groupBy",
    ]);
    // findUnique / findUniqueOrThrow carry the tenant filter in `where` for tenant models and
    // are re-checked on the way out (fail closed) — see runTenantUniqueLookup.
    const UNIQUE_METHODS = new Set(["findUnique", "findUniqueOrThrow"]);
    // Model verbs deliberately left unscoped. Empty on purpose, and the honest answer
    // rather than a decorative list: the client-level escape hatches ($queryRaw,
    // $executeRaw, $transaction, $connect, …) never reach a model proxy — the outer
    // proxy below returns them bound and untouched — and every model verb Prisma
    // exposes for the Postgres provider is scoped above. `aggregateRaw`/`findRaw` are
    // MongoDB-only, carry no tenant-scopable `where`, and are therefore left to the
    // throw rather than waved through.
    const PASS_THROUGH_METHODS = new Set<string>();

    return new Proxy(rawTx, {
      get(target, modelName) {
        const model = target[modelName];
        // `_`-prefixed keys are PrismaClient's own internal state (`_engine`,
        // `_extensions`, `_originalClient`, `_runtimeDataModel`, …) — object-valued
        // and not `$`-prefixed, so without this they would be wrapped as if they
        // were model delegates and every method on them would hit the fail-closed
        // throw below. A Prisma model name can never start with `_`, so nothing
        // scopable is lost.
        if (
          !model ||
          typeof model !== "object" ||
          typeof modelName !== "string" ||
          modelName.startsWith("$") ||
          modelName.startsWith("_")
        ) {
          return typeof model === "function" ? model.bind(target) : model;
        }
        // Wrap model operations
        return new Proxy(model, {
          get(modelTarget, method) {
            const fn = modelTarget[method];
            if (typeof fn !== "function" || typeof method !== "string") return fn;

            if (WRITE_METHODS.has(method)) {
              return (args: any = {}) => {
                if (method === "create") {
                  args = { ...args, data: { ...args.data, tenantId } };
                } else if (method === "createMany" || method === "createManyAndReturn") {
                  const data = Array.isArray(args.data)
                    ? args.data.map((d: any) => ({ ...d, tenantId }))
                    : { ...args.data, tenantId };
                  args = { ...args, data };
                } else if (method === "upsert") {
                  // Same scoping as the `forTenant()` extension: the tenant filter rides in
                  // `where` (tenant models only), so an upsert keyed by a foreign row's id
                  // can neither update nor read it.
                  const where = isTenantModel(modelName) ? { ...args.where, tenantId } : args.where;
                  args = {
                    ...args,
                    where,
                    create: { ...args.create, tenantId },
                  };
                }
                return fn.call(modelTarget, args);
              };
            }

            if (SCOPED_METHODS.has(method)) {
              return (args: any = {}) => {
                args = { ...args, where: { ...args.where, tenantId } };
                return fn.call(modelTarget, args);
              };
            }

            if (UNIQUE_METHODS.has(method)) {
              return (args: any = {}) =>
                runTenantUniqueLookup({
                  model: modelName,
                  operation: method as "findUnique" | "findUniqueOrThrow",
                  args,
                  tenantId,
                  run: (a) => fn.call(modelTarget, a),
                });
            }

            if (PASS_THROUGH_METHODS.has(method)) return fn.bind(modelTarget);

            // Fail closed. A Prisma upgrade that adds a model verb — or a typo'd
            // one — must not slip past the tenant guard unscoped and unnoticed,
            // which is precisely how `findUniqueOrThrow` went unguarded (L-055).
            // Thrown when the operation is CALLED, not when it is read, so the
            // failure lands exactly where the unscoped query would have run.
            return () => {
              throw new Error(
                `tenant guard: unhandled Prisma operation "${method}" on ${modelName}`,
              );
            };
          },
        });
      },
    });
  }

  private _tenantExtension(tenantId: string) {
    // ONE dispatch point, on purpose. Prisma COMPOSES a `$allModels.$allOperations`
    // handler with per-operation handlers rather than choosing between them — a named
    // handler's own `query(args)` call runs the catch-all next — so a fail-closed
    // catch-all cannot coexist with a named map: every scoped operation would throw
    // on its way to the database (verified against the generated client, and caught
    // by the DB-backed tenant-findunique pins). Dispatching here instead keeps the
    // per-operation scoping identical to the map it replaces AND gives this layer the
    // same explicit `default` fall-through the tx proxy has.
    return {
      query: {
        $allModels: {
          async $allOperations({ args, query, model, operation }: any) {
            switch (operation) {
              // Tenant filter in `where` + fail-closed re-check; one implementation shared
              // with the tx proxy (runTenantUniqueLookup).
              case "findUnique":
              case "findUniqueOrThrow":
                return runTenantUniqueLookup({
                  model,
                  operation,
                  args,
                  tenantId,
                  run: query,
                });

              case "create":
                args.data = { ...args.data, tenantId };
                return query(args);

              case "createMany":
              case "createManyAndReturn":
                args.data = Array.isArray(args.data)
                  ? args.data.map((d: any) => ({ ...d, tenantId }))
                  : { ...args.data, tenantId };
                return query(args);

              case "upsert":
                args.where = { ...args.where, tenantId };
                args.create = { ...args.create, tenantId };
                return query(args);

              case "findMany":
              case "findFirst":
              case "findFirstOrThrow":
              case "count":
              case "update":
              case "updateMany":
              case "updateManyAndReturn":
              case "delete":
              case "deleteMany":
              case "aggregate":
              case "groupBy":
                args.where = { ...args.where, tenantId };
                return query(args);

              // Fail closed, mirroring the tx proxy's throw. The client-level escape
              // hatches ($queryRaw/$executeRaw/$transaction) sit outside `$allModels`
              // and never arrive here; what does is a model verb this switch does not
              // scope — today only MongoDB's `aggregateRaw`/`findRaw`, and tomorrow
              // whatever a Prisma upgrade adds, which must then be scoped deliberately
              // rather than inherited unscoped (how `findUniqueOrThrow` slipped through
              // in the first place — L-055).
              default:
                throw new Error(
                  `tenant guard: unhandled Prisma operation "${operation}" on ${model}`,
                );
            }
          },
        },
      },
    };
  }

  /**
   * Returns a Prisma client extension that automatically injects `tenantId`
   * into every query for the current request context.
   *
   * - SUPER_ADMIN (tenantId === null): returns unscoped `this` — full DB access
   * - All other roles: every read/write is silently scoped to the tenant
   *
   * Usage in services: replace `this.prisma.model.*` → `this.prisma.forTenant().model.*`
   */
  forTenant() {
    const tenantId = this.tenantCtx?.getOrNull() ?? null;
    if (!tenantId) return this;
    return this.$extends(this._tenantExtension(tenantId)) as unknown as this;
  }
}
