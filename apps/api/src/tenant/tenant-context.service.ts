import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";

/**
 * Whose work this is. TENANT: a business is in scope. SUPER_ADMIN: a platform admin with no business. ANONYMOUS: a
 * request with no tenant and no admin (public routes, buyer routes before their seller resolves). SYSTEM: reserved
 * for the body of `prisma.forSystem(reason, fn)`, never set by a request. NONE: no store at all (a cron or queue job that never
 * entered a context).
 */
export type TenantKind = "TENANT" | "SUPER_ADMIN" | "ANONYMOUS" | "SYSTEM";
export type TenantContextKind = TenantKind | "NONE";

interface TenantStore {
  tenantId: string | null;
  kind: TenantKind;
  /** `Controller.handler` of the request, for the dark warn's log line. Never an id. */
  label?: string;
}

/**
 * Singleton service that uses AsyncLocalStorage to isolate tenant context
 * per async execution chain (i.e., per HTTP request). This avoids the
 * Scope.REQUEST / APP_INTERCEPTOR incompatibility in NestJS.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantStore>();

  /**
   * Run a callback inside a new tenant context. A tenant id means kind TENANT; with none, the caller says which
   * tenantless kind it is (the interceptor reads it from the JWT), ANONYMOUS by default.
   */
  run<T>(
    tenantId: string | null,
    fn: () => T,
    tenantless: Exclude<TenantKind, "TENANT" | "SYSTEM"> = "ANONYMOUS",
    label?: string,
  ): T {
    const kind: TenantKind = tenantId ? "TENANT" : tenantless;
    return this.storage.run({ tenantId, kind, label }, fn);
  }

  /**
   * B1284: the ONLY producer of kind SYSTEM (`run()` cannot name it). Its one caller is `PrismaService.forSystem`, which
   * holds the literal reason and the allow-list row; `tenant-context-system-door.inventory.spec` fails on any other
   * caller. The reason is the context label and is never an id.
   */
  runSystem<T>(reason: string, fn: () => T): T {
    return this.storage.run({ tenantId: null, kind: "SYSTEM", label: reason }, fn);
  }

  /** Returns tenantId or throws if context not initialised */
  get(): string {
    const store = this.storage.getStore();
    if (!store || store.tenantId === null) {
      throw new Error("TenantContext not initialized — ensure request passes through JwtAuthGuard");
    }
    return store.tenantId;
  }

  /** Returns tenantId or null (SUPER_ADMIN or unauthenticated) */
  getOrNull(): string | null {
    return this.storage.getStore()?.tenantId ?? null;
  }

  /** The kind of the running context; NONE when there is no store at all. */
  kind(): TenantContextKind {
    return this.storage.getStore()?.kind ?? "NONE";
  }

  /** The request's `Controller.handler`, when the interceptor set one. */
  label(): string | undefined {
    return this.storage.getStore()?.label;
  }

  isSuperAdmin(): boolean {
    return this.kind() === "SUPER_ADMIN";
  }
}
