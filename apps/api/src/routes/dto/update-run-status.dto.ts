import { IsEnum } from 'class-validator';
import { RouteRunStatus } from '@prisma/client';

export class UpdateRunStatusDto {
  @IsEnum(RouteRunStatus) status: RouteRunStatus;
}
