import { UserRole, UserStatus } from "@prisma/client";

export interface JwtPayload {
  sub: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  forcePasswordChange: boolean;
  tenantId: string | null;
  tenantSlug: string | null;
  isAdmin?: boolean;
  canActAsDriver?: boolean;
  /** Present only on impersonation tokens issued by platform admins. */
  impersonatedBy?: string;
  // ─── Plans & Billing entitlement snapshot (client renders gates; server re-resolves) ───
  /** Plan key: STARTER | TEAM | BUSINESS | ENTERPRISE. */
  plan?: string;
  /** Granted feature-flag keys. */
  flags?: string[];
  /** Active add-on SKU codes. */
  addons?: string[];
  /** Included seat cap (null = unlimited). */
  seats?: number | null;
  /** Trial end ISO timestamp, if in trial. */
  trialEnds?: string | null;
}
