import { Module } from "@nestjs/common";
import { RoutesService } from "./routes.service";
import { RoutesController, RouteRunsController } from "./routes.controller";
import { AuthModule } from "../auth/auth.module";
import { GatewaysModule } from "../gateways/gateways.module";

@Module({
  imports: [AuthModule, GatewaysModule],
  controllers: [RoutesController, RouteRunsController],
  providers: [RoutesService],
  exports: [RoutesService],
})
export class RoutesModule {}
