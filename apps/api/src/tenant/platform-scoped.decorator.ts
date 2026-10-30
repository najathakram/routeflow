import { SetMetadata } from "@nestjs/common";

export const PLATFORM_SCOPED_KEY = "platformScoped";

/**
 * W-767 (SA-908): marks a controller or handler built for the PLATFORM (the super-admin back office, cron, webhooks), not
 * for one business. TenantRequiredInterceptor lets a tenantless SUPER_ADMIN write through on these routes only; every other
 * write needs a business in the session (a super admin acts inside one through impersonation, "act as").
 *
 * A route marked here must take its tenant EXPLICITLY (a path or body id, as `clearFinancialData` does), never from the
 * session. `tenant-required.pin.spec.ts` lists every mutating route this covers, so a new one is reviewed.
 */
export const PlatformScoped = () => SetMetadata(PLATFORM_SCOPED_KEY, true);
