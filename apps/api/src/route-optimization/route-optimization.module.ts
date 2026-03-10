import { Module } from '@nestjs/common';
import { RouteOptimizationController } from './route-optimization.controller';
import { RouteOptimizationService } from './route-optimization.service';

@Module({
  controllers: [RouteOptimizationController],
  providers: [RouteOptimizationService],
  exports: [RouteOptimizationService],
})
export class RouteOptimizationModule {}
