import { Injectable, OnModuleInit, OnModuleDestroy, Optional } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { TenantContextService } from "../tenant/tenant-context.service";

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
  async tenantTransaction<T>(fn: (tx: any) => Promise<T>, options?: Parameters<PrismaClient["$transaction"]>[1]): Promise<T> {
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
    const WRITE_METHODS = new Set(["create", "createMany", "upsert"]);
    const SCOPED_METHODS = new Set([
      "findMany", "findFirst", "findFirstOrThrow", "count",
      "update", "updateMany", "delete", "deleteMany", "aggregate", "groupBy",
    ]);

    return new Proxy(rawTx, {
      get(target, modelName) {
        const model = target[modelName];
        if (!model || typeof model !== "object" || typeof modelName !== "string" || modelName.startsWith("$")) {
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
                } else if (method === "createMany") {
                  const data = Array.isArray(args.data)
                    ? args.data.map((d: any) => ({ ...d, tenantId }))
                    : { ...args.data, tenantId };
                  args = { ...args, data };
                } else if (method === "upsert") {
                  args = { ...args, create: { ...args.create, tenantId }, where: { ...args.where, tenantId } };
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

            return fn.bind(modelTarget);
          },
        });
      },
    });
  }

  private _tenantExtension(tenantId: string) {
    return {
      query: {
        $allModels: {
          async findMany({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async findFirst({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async findFirstOrThrow({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async count({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async create({ args, query }: any) { args.data = { ...args.data, tenantId }; return query(args); },
          async createMany({ args, query }: any) {
            args.data = Array.isArray(args.data) ? args.data.map((d: any) => ({ ...d, tenantId })) : { ...args.data, tenantId };
            return query(args);
          },
          async update({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async updateMany({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async upsert({ args, query }: any) { args.where = { ...args.where, tenantId }; args.create = { ...args.create, tenantId }; return query(args); },
          async delete({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async deleteMany({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async aggregate({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
          async groupBy({ args, query }: any) { args.where = { ...args.where, tenantId }; return query(args); },
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
