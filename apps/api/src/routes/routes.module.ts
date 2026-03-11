import { Module } from "@nestjs/common";
import { RoutesService } from "./routes.service";
import { RoutesController, RouteRunsController } from "./routes.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [RoutesController, RouteRunsController],
  providers: [RoutesService],
  exports: [RoutesService],
})
export class RoutesModule {}
