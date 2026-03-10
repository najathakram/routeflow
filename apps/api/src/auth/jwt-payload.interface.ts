import { UserRole, UserStatus } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  role: UserRole;
  status: UserStatus;
  forcePasswordChange: boolean;
}
