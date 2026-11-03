import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RouteRunStatus, UserRole } from "@prisma/client";
import {
  SETTLE_MAX_COUNT,
  computeVariance,
  roundMoney,
  varianceNeedsReason,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { SettleRunDto } from "./dto/settle-run.dto";
import { lockRunStopsForTerminalStatus } from "./delivery-lines.util";

/**
 * SA-1098 A-6: the settlement write, ONE transaction under the run's stop-row lock (house order, stop rows then
 * run; SA-706f). A reopen, a stop completion and a second settle each wait their turn and are seen, never overtaken.
 * The caller supplies `readCollected` so the expected figure is read through the same `tx`.
 */
export async function settleRunInTx(
  tx: any,
  id: string,
  dto: SettleRunDto,
  user: JwtPayload,
  readCollected: (startedAt: Date | null) => Promise<{ cashTotal: number; checkTotal: number }>,
) {
  // A count past the money column overflowed into an uncoded 500; refuse it before anything is locked or written.
  if (dto.countedCash > SETTLE_MAX_COUNT) {
    throw new BadRequestException({
      code: API_ERROR_CODES.RUN_COUNT_TOO_LARGE,
      message: "That count is too large. Check the amount and try again.",
    });
  }

  await lockRunStopsForTerminalStatus(tx, id);
  const current = await tx.routeRun.findUnique({ where: { id } });
  if (!current) throw new NotFoundException("Route run not found");

  // A driver settles once; only an operator may amend an existing settlement. Read UNDER the lock, so two settles
  // sent together cannot both land (SE-7b). Coded so a client whose response was lost can tell "your write already
  // landed" from a real refusal and carry on to the COMPLETED flip.
  if (user.role === UserRole.DRIVER && current.settlementNote != null) {
    throw new BadRequestException({
      code: API_ERROR_CODES.RUN_ALREADY_SETTLED,
      message: "This run has already been settled. Ask an operator to amend it.",
    });
  }

  // A count taken with a stop left is a count that cash can still outgrow (SE-10), and a reopen can land between the
  // screen and this write (SE-14). Every role is refused; a finished or cancelled run is reconciled after the fact.
  if (current.status === RouteRunStatus.IN_PROGRESS) {
    const left = await tx.routeRunStop.count({
      where: { routeRunId: id, status: { notIn: ["COMPLETED", "SKIPPED"] } },
    });
    if (left > 0) {
      throw new BadRequestException({
        code: API_ERROR_CODES.RUN_HAS_STOPS_LEFT,
        message: "This run still has a stop left. Finish it, then settle.",
      });
    }
  }

  // The reconciliation basis is the PHYSICAL money the driver carries — cash AND checks (the mobile screen's "Cash &
  // checks to reconcile" line, `summarizeCollections().cashTotal`, and `shouldForceSettlement` agree).
  const expected = await readCollected(current.startedAt);
  const expectedPhysical = roundMoney(expected.cashTotal + expected.checkTotal);
  const variance = computeVariance(expectedPhysical, dto.countedCash);
  // The one rule the web and the native screen share (@routeflow/pricing). Coded so a client can reopen its reason
  // field when the expected figure moved; the MESSAGE stays word for word because the native screen matches
  // `includes("varianceReason")` and old builds stay in the field.
  if (varianceNeedsReason(expectedPhysical, dto.countedCash) && !dto.varianceReason) {
    throw new BadRequestException({
      code: API_ERROR_CODES.RUN_VARIANCE_REASON_REQUIRED,
      message: "Counted cash does not match the expected amount — a varianceReason is required.",
    });
  }

  const sign = variance < 0 ? "-" : "+";
  const noteLines = [
    `Settlement recorded by ${user.username} at ${new Date().toISOString()}`,
    `Expected (cash + checks): $${roundMoney(expectedPhysical).toFixed(2)}`,
    `Counted: $${roundMoney(dto.countedCash).toFixed(2)}`,
    `Variance: ${sign}$${roundMoney(Math.abs(variance)).toFixed(2)}`,
  ];
  if (dto.varianceReason) noteLines.push(`Reason: ${dto.varianceReason}`);
  // An amend (or an office settle over a driver's count) keeps what it replaces: the whole old note follows the new
  // one. A reopen still drops the note outright (A-1).
  if (current.settlementNote != null) noteLines.push("Earlier count:", current.settlementNote);

  const updated = await tx.routeRun.update({
    where: { id },
    data: { settlementNote: noteLines.join("\n"), settlementVariance: variance },
  });
  return { updated, expectedPhysical, variance };
}
