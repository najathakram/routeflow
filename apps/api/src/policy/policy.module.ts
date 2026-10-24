import { Module } from "@nestjs/common";
import { PolicyService } from "./policy.service";
import { PolicyController } from "./policy.controller";

/** SA-138 phase 1 — per-tenant POLICY values (PrismaModule is global). */
@Module({
  controllers: [PolicyController],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
