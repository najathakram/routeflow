import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";

/**
 * SA-619: what kind of caller a context belongs to. A missing tenantId used to mean BOTH "super
 * admin" and "no context" (and every unauthenticated route), which is how a context-less staff
 * lookup read every tenant's admins.
 *  - TENANT: a tenant-scoped caller (a JWT with a tenant, or `run(tenantId)` in a cron).
 *  - SUPER_ADMIN: a platform admin; reads are deliberately unscoped, tenant-owned creates need an
 *    explicit tenantId.
 *  - ANONYMOUS: a request with no authenticated user.
 *  - SYSTEM: explicit system work (paired with `forSystem(reason)`).
 *  - NONE: no store at all (nothing ran inside `run`).
 */
export type TenantKind = "TENANT" | "SUPER_ADMIN" | "ANONYMOUS" | "SYSTEM" | "NONE";

interface TenantStore {
  tenantId: string | null;
  kind: Exclude<TenantKind, "NONE">;
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
   * Run a callback inside a new tenant context. Called by TenantInterceptor. A tenant id is always
   * a TENANT context (`kind` is ignored); with no tenant the kind defaults to ANONYMOUS.
   */
  run<T>(tenantId: string | null, fn: () => T, kind?: "SUPER_ADMIN" | "ANONYMOUS" | "SYSTEM"): T {
    return this.storage.run({ tenantId, kind: tenantId ? "TENANT" : (kind ?? "ANONYMOUS") }, fn);
  }

  /** Returns tenantId or throws if context not initialised */
  get(): string {
    const store = this.storage.getStore();
    if (!store || store.tenantId === null) {
      throw new Error("TenantContext not initialized — ensure request passes through JwtAuthGuard");
    }
    return store.tenantId;
  }

  /** Returns tenantId or null (SUPER_ADMIN, unauthenticated, or no context: see `getKind`) */
  getOrNull(): string | null {
    return this.storage.getStore()?.tenantId ?? null;
  }

  /** The caller kind of the current context; NONE when nothing ran inside `run`. */
  getKind(): TenantKind {
    return this.storage.getStore()?.kind ?? "NONE";
  }

  isSuperAdmin(): boolean {
    return this.getKind() === "SUPER_ADMIN";
  }
}
