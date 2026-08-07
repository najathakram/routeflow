import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DuplicateMatchService } from "./duplicate-match.service";

/**
 * Standalone so `VendorBillsModule` can consume the matcher without importing
 * `ImportModule` — which imports `VendorBillsModule` back and would deadlock
 * the injector.
 */
@Module({
  imports: [PrismaModule],
  providers: [DuplicateMatchService],
  exports: [DuplicateMatchService],
})
export class DuplicateMatchModule {}
