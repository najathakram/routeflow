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
  /**
   * Whether the account has a usable password (false for Google-only users).
   * Rendering hint only — it goes stale if the password changes elsewhere;
   * GET /users/me is the authoritative fresh read, and the server re-checks
   * the DB before any password mutation.
   */
  hasPassword?: boolean;
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
