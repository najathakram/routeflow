import { AsyncLocalStorage } from "async_hooks";

/**
 * Row 556 / SA-970 §2.3 - who is impersonating, for the whole request.
 *
 * `TenantInterceptor` runs the rest of the request inside `runWithImpersonation(user.impersonatedBy, ...)` (the
 * platform-admin id an impersonation token carries; `AuditLog.impersonatedBy` is written from the same field).
 * The add-on writer reads it with `currentImpersonatedBy()` so an `addon.state_changed` made under support
 * impersonation says so, without threading a new argument through every service signature.
 */
const storage = new AsyncLocalStorage<{ impersonatedBy: string | null }>();

export function runWithImpersonation<T>(impersonatedBy: string | null | undefined, fn: () => T): T {
  return storage.run({ impersonatedBy: impersonatedBy ?? null }, fn);
}

/** The platform admin impersonating this request, or null (no request context, or not impersonated). */
export function currentImpersonatedBy(): string | null {
  return storage.getStore()?.impersonatedBy ?? null;
}
