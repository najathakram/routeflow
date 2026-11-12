import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { RouteRunStatus, RouteRunStopStatus } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * OrdersService.create's DRIVER run/stop link check, moved verbatim (size ratchet, SA-1124 PR-1a prefactor).
 *
 * B309: a driver may only link a new order to a stop/run that is their own and currently active - mirrors
 * routes.service.ts's completeWithPayment / reopenStop driver-isolation guard (B72). This runs BEFORE any order row
 * is written, so a rejected link never leaves an orphan order.
 *
 * Returns the run id the order is to be linked to (resolved from the stop when only a stop was supplied), or null
 * when the request names neither a run nor a stop.
 */
export async function resolveDriverRunLink(
  prisma: PrismaService,
  dto: { routeRunId?: string | null; routeRunStopId?: string | null },
  user: Pick<JwtPayload, "sub">,
): Promise<string | null> {
  if (!(dto.routeRunId || dto.routeRunStopId)) return null;
  const driver = await prisma.forTenant().driver.findFirst({ where: { userId: user.sub } });

  let stop: { id: string; status: RouteRunStopStatus; routeRunId: string } | null = null;
  let runId = dto.routeRunId ?? null;
  if (dto.routeRunStopId) {
    stop = await prisma.forTenant().routeRunStop.findFirst({
      where: { id: dto.routeRunStopId },
      select: { id: true, status: true, routeRunId: true },
    });
    if (!stop) throw new BadRequestException("Stop not found");
    if (dto.routeRunId && dto.routeRunId !== stop.routeRunId) {
      throw new BadRequestException("Stop does not belong to the supplied route run");
    }
    runId = stop.routeRunId;
  }

  const run = await prisma.forTenant().routeRun.findFirst({
    where: { id: runId as string },
    select: { id: true, driverId: true, status: true },
  });
  if (!driver || !run || run.driverId !== driver.id) {
    throw new ForbiddenException("You do not have access to this route run");
  }
  if (run.status !== RouteRunStatus.IN_PROGRESS) {
    throw new BadRequestException("Route run is not in progress");
  }
  if (
    stop &&
    (stop.status === RouteRunStopStatus.COMPLETED || stop.status === RouteRunStopStatus.SKIPPED)
  ) {
    throw new BadRequestException("Stop is already completed or skipped");
  }
  return runId;
}
