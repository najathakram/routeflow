import { Module } from "@nestjs/common";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";

@Module({
  imports: [PrismaModule, GatewaysModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
