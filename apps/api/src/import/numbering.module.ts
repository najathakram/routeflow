import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { NumberingService } from "./numbering.service";

/**
 * Extracted from `ImportModule` (B100/F16b, cause-ruling.md §2 D4) so
 * `InvoicesModule` and `EstimatesModule` can consume `NumberingService` without
 * importing `ImportModule` itself (which would risk a module cycle). Still one
 * service, one store — `ImportModule` imports this module too rather than
 * keeping its own provider.
 */
@Module({
  imports: [PrismaModule],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
