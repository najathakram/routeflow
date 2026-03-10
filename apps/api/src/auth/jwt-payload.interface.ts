import { UserRole, UserStatus } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  forcePasswordChange: boolean;
}
