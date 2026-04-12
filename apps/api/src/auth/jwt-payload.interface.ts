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
}
