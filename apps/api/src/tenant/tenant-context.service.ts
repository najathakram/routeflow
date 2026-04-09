import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";

interface TenantStore {
  tenantId: string | null;
}

/**
 * Singleton service that uses AsyncLocalStorage to isolate tenant context
 * per async execution chain (i.e., per HTTP request). This avoids the
 * Scope.REQUEST / APP_INTERCEPTOR incompatibility in NestJS.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantStore>();

  /** Run a callback inside a new tenant context. Called by TenantInterceptor. */
  run<T>(tenantId: string | null, fn: () => T): T {
    return this.storage.run({ tenantId }, fn);
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

  isSuperAdmin(): boolean {
    return this.getOrNull() === null;
  }
}
