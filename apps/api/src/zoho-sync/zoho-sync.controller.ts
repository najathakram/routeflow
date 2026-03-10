import { Controller, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('zoho-sync')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class ZohoSyncController {}
