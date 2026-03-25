import { Module } from "@nestjs/common";
import { EstimatesController } from "./estimates.controller";
import { EstimatesService } from "./estimates.service";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
  imports: [PrismaModule],
  controllers: [EstimatesController],
  providers: [EstimatesService],
  exports: [EstimatesService],
})
export class EstimatesModule {}
