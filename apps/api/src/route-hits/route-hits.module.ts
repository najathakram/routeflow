import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { RouteHitsInterceptor } from "./route-hits.interceptor";
import { RouteHitsService } from "./route-hits.service";

@Module({
  imports: [ConfigModule],
  providers: [RouteHitsService, { provide: APP_INTERCEPTOR, useClass: RouteHitsInterceptor }],
  exports: [RouteHitsService],
})
export class RouteHitsModule {}
