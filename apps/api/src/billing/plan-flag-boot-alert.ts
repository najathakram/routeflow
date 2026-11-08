import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { OwnerAlertService } from "../email/owner-alert.service";
import { isPlanFlagEnforcementOn } from "./plan-flag-policy";

/**
 * FG-1 WP3: at boot, when `PLAN_FLAG_ENFORCEMENT` is on, tell the owner once (`OwnerAlertService` dedupes per boot).
 * Reads the environment only and flips nothing.
 */
@Injectable()
export class PlanFlagBootAlert implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlanFlagBootAlert.name);

  constructor(private readonly ownerAlert: OwnerAlertService) {}

  onApplicationBootstrap(): void {
    if (!isPlanFlagEnforcementOn()) return;
    this.logger.warn("PLAN_FLAG_ENFORCEMENT is on at boot; the owner is alerted once.");
    void this.ownerAlert.planFlagEnforcementOnAtBoot();
  }
}
