import { Module } from "@nestjs/common";
import {
  RouteOptimizationController,
  RouteTemplateOptimizationController,
} from "./route-optimization.controller";
import { RouteOptimizationService } from "./route-optimization.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [RouteOptimizationController, RouteTemplateOptimizationController],
  providers: [RouteOptimizationService],
  exports: [RouteOptimizationService],
})
export class RouteOptimizationModule {}
