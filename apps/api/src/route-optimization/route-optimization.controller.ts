import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RouteOptimizationService } from './route-optimization.service';

@ApiTags('route-runs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@Controller('route-runs')
export class RouteOptimizationController {
  constructor(private readonly service: RouteOptimizationService) {}

  @Post(':id/optimize')
  optimize(@Param('id') id: string) {
    return this.service.optimizeRoute(id);
  }
}
