import { IsEnum } from 'class-validator';
import { UserStatus } from '@prisma/client';

export class ChangeUserStatusDto {
  @IsEnum(UserStatus) status: UserStatus;
}
