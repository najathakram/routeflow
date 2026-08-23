import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";
import { COMMISSION_EPS } from "./commission-math";
import {
  GenerateCommissionStatementDto,
  ListCommissionStatementsDto,
  RecordCommissionPayoutDto,
} from "./commission-statements.controller";

type PendingLine = {
  kind: "CLAIM" | "ADJUSTMENT" | "CARRYFORWARD";
  accrualId?: string;
  adjustmentId?: string;
  carriedFromStatementId?: string;
  amount: number;
  description?: string;
};

/**
 * Commission statement generation, approval, void, and payouts. Reads the
 * accrual ledger directly (CommissionAccrual.payableAmount/claimedAmount +
 * CommissionAdjustment rows) rather than going through CommissionEngineService
 * — the engine owns per-invoice sync; this service owns turning converged
 * ledger state into a per-agent claim document. See the plan's "Statement /
 * payout lifecycle" section for the exact invariants enforced here.
 */
@Injectable()
export class CommissionStatementsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListCommissionStatementsDto) {
    const where: any = {};
    if (query.agentId) where.agentId = query.agentId;
    if (query.status) where.status = query.status;
    return this.prisma.forTenant().commissionStatement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { agent: { select: { id: true, name: true } } },
    });
  }

  async findOne(id: string) {
    const statement = await this.prisma.forTenant().commissionStatement.findUnique({
      where: { id },
      include: {
        agent: { select: { id: true, name: true } },
        lines: {
          include: {
            accrual: { include: { invoice: { select: { id: true, invoiceNumber: true } } } },
            adjustment: true,
            carriedFrom: { select: { id: true, statementNumber: true } },
          },
        },
        payouts: true,
      },
    });
    if (!statement) throw new NotFoundException("Commission statement not found");
    return statement;
  }

  /** Copies generateInvoiceNumber's max+1 scan pattern (invoices.service.ts). */
  private async nextStatementNumber(db: any): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `CST-${year}-`;
    const last = await db.commissionStatement.findFirst({
      where: { statementNumber: { startsWith: prefix } },
      orderBy: { statementNumber: "desc" },
    });
    const seq = last ? parseInt(last.statementNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  async generate(dto: GenerateCommissionStatementDto) {
    const agent = await this.prisma
      .forTenant()
      .salesAgent.findUnique({ where: { id: dto.agentId } });
    if (!agent) throw new NotFoundException("Sales agent not found");

    const existingPending = await this.prisma.forTenant().commissionStatement.findFirst({
      where: { agentId: dto.agentId, status: "PENDING" },
    });
    if (existingPending) {
      throw new ConflictException(
        `Agent already has a PENDING statement (${existingPending.statementNumber}) — approve or void it first.`,
      );
    }

    return this.prisma.tenantTransaction(
      async (tx) => {
        const accrualWhere: any = { agentId: dto.agentId };
        if (dto.periodFrom || dto.periodTo) {
          accrualWhere.basisDate = {};
          if (dto.periodFrom) accrualWhere.basisDate.gte = new Date(dto.periodFrom);
          if (dto.periodTo) accrualWhere.basisDate.lte = new Date(dto.periodTo);
        }
        const accruals = await tx.commissionAccrual.findMany({
          where: accrualWhere,
          include: { adjustments: { include: { line: true } } },
        });

        // The period window narrows CLAIM lines ONLY. Adjustments (clawbacks,
        // corrections) land on the ORIGINAL accrual's basisDate — a February
        // credit note against a January invoice writes its clawback onto the
        // January accrual, and a monthly periodFrom window would otherwise
        // strand that debt forever once it moves past January. Sweep unclaimed
        // adjustments from EVERY accrual the agent has.
        const inPeriodIds = new Set(accruals.map((a: any) => a.id));
        const outOfPeriodCarriers =
          dto.periodFrom || dto.periodTo
            ? (
                await tx.commissionAccrual.findMany({
                  where: {
                    agentId: dto.agentId,
                    adjustments: { some: { line: { is: null } } },
                  },
                  include: { adjustments: { include: { line: true } } },
                })
              ).filter((a: any) => !inPeriodIds.has(a.id))
            : [];

        const lines: PendingLine[] = [];

        for (const accrual of accruals) {
          const adjTotal = roundMoney(
            accrual.adjustments.reduce((s: number, a: any) => s + Number(a.amount), 0),
          );
          const drift = roundMoney(
            Number(accrual.payableAmount) - Number(accrual.claimedAmount) - adjTotal,
          );
          if (drift > COMMISSION_EPS) {
            lines.push({ kind: "CLAIM", accrualId: accrual.id, amount: drift });
          }
        }

        // Sweep every unclaimed adjustment (not yet tied to a statement line)
        // regardless of the accrual's own drift sign or period membership.
        for (const accrual of [...accruals, ...outOfPeriodCarriers]) {
          for (const adj of accrual.adjustments) {
            if (!adj.line) {
              lines.push({
                kind: "ADJUSTMENT",
                adjustmentId: adj.id,
                amount: roundMoney(Number(adj.amount)),
                description: `${adj.kind} adjustment on accrual ${accrual.id}`,
              });
            }
          }
        }

        // Sweep prior non-VOID statements with an unabsorbed negative residual —
        // each swept at most once (carriedInto's unique carriedFromStatementId ref
        // frees up again if that CARRYFORWARD line is later deleted by a void).
        const priorStatements = await tx.commissionStatement.findMany({
          where: { agentId: dto.agentId, status: { not: "VOID" } },
          include: { carriedInto: true },
        });
        for (const prior of priorStatements) {
          const residual = roundMoney(Number(prior.totalAmount) - Number(prior.paidAmount));
          if (residual < -COMMISSION_EPS && prior.carriedInto.length === 0) {
            lines.push({
              kind: "CARRYFORWARD",
              carriedFromStatementId: prior.id,
              amount: residual,
              description: `Carryforward of unabsorbed balance from ${prior.statementNumber}`,
            });
          }
        }

        if (lines.length === 0) {
          throw new BadRequestException(
            "Nothing to generate — no unclaimed commission for this agent.",
          );
        }

        const totalAmount = roundMoney(lines.reduce((s, l) => s + l.amount, 0));
        const statementNumber = await this.nextStatementNumber(tx);

        const statement = await tx.commissionStatement.create({
          data: {
            statementNumber,
            agentId: dto.agentId,
            periodFrom: dto.periodFrom ? new Date(dto.periodFrom) : null,
            periodTo: dto.periodTo ? new Date(dto.periodTo) : null,
            totalAmount,
          },
        });

        for (const line of lines) {
          await tx.commissionStatementLine.create({
            data: {
              statementId: statement.id,
              kind: line.kind,
              accrualId: line.accrualId ?? null,
              adjustmentId: line.adjustmentId ?? null,
              carriedFromStatementId: line.carriedFromStatementId ?? null,
              amount: line.amount,
              description: line.description ?? null,
            },
          });
          if (line.kind === "CLAIM" && line.accrualId) {
            const accrual = accruals.find((a: any) => a.id === line.accrualId);
            await tx.commissionAccrual.update({
              where: { id: line.accrualId },
              data: { claimedAmount: roundMoney(Number(accrual.claimedAmount) + line.amount) },
            });
          }
        }

        return tx.commissionStatement.findUnique({
          where: { id: statement.id },
          include: { lines: true },
        });
      },
      { isolationLevel: "Serializable" },
    );
  }

  async approve(id: string) {
    return this.prisma.tenantTransaction(
      async (tx) => {
        const statement = await tx.commissionStatement.findUnique({
          where: { id },
          include: { lines: { where: { kind: "CLAIM" } } },
        });
        if (!statement) throw new NotFoundException("Commission statement not found");
        if (statement.status !== "PENDING") {
          throw new ConflictException(
            `Only a PENDING statement can be approved (this one is ${statement.status}).`,
          );
        }

        for (const line of statement.lines) {
          if (!line.accrualId) continue;
          const accrual = await tx.commissionAccrual.findUnique({
            where: { id: line.accrualId },
            include: { adjustments: { include: { line: true } } },
          });
          if (!accrual) throw new ConflictException("Statement is stale — regenerate");

          // Any UNCLAIMED adjustment means the engine moved money on this accrual
          // AFTER the statement was generated. A clawback writes its payable drop
          // and the compensating negative adjustment in ONE transaction, so a
          // naive expected-value check nets them to zero and approves a payout on
          // bounced cash — commission on bad debt. Regeneration sweeps the
          // adjustment as its own statement line, which is the only honest total.
          if (accrual.adjustments.some((a: any) => !a.line)) {
            throw new ConflictException("Statement is stale — regenerate");
          }

          const adjTotal = roundMoney(
            accrual.adjustments.reduce((s: number, a: any) => s + Number(a.amount), 0),
          );
          // Live drift as of now, excluding THIS line's own claim (already
          // folded into claimedAmount at generation time) — re-derives what the
          // line SHOULD be right now. Anything that moved since generate (a
          // clawback, a rate/reassignment adjustment) makes this diverge.
          const priorClaimed = roundMoney(Number(accrual.claimedAmount) - Number(line.amount));
          const expected = roundMoney(Number(accrual.payableAmount) - priorClaimed - adjTotal);
          if (Math.abs(expected - Number(line.amount)) > COMMISSION_EPS) {
            throw new ConflictException("Statement is stale — regenerate");
          }

          // Converged (drift ≈ 0, something claimed) → flip the accrual's
          // display status to SETTLED now that this claim is about to be locked
          // in by approval.
          const drift = roundMoney(
            Number(accrual.payableAmount) - Number(accrual.claimedAmount) - adjTotal,
          );
          if (Math.abs(drift) <= COMMISSION_EPS && Number(accrual.claimedAmount) > 0) {
            await tx.commissionAccrual.update({
              where: { id: accrual.id },
              data: { status: "SETTLED" },
            });
          }
        }

        return tx.commissionStatement.update({
          where: { id },
          data: { status: "APPROVED", approvedAt: new Date() },
        });
      },
      { isolationLevel: "Serializable" },
    );
  }

  async voidStatement(id: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      const statement = await tx.commissionStatement.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!statement) throw new NotFoundException("Commission statement not found");
      if (statement.status !== "PENDING") {
        throw new ConflictException(
          `Only a PENDING statement can be voided (this one is ${statement.status}).`,
        );
      }

      for (const line of statement.lines) {
        if (line.kind === "CLAIM" && line.accrualId) {
          const accrual = await tx.commissionAccrual.findUnique({ where: { id: line.accrualId } });
          if (accrual) {
            await tx.commissionAccrual.update({
              where: { id: line.accrualId },
              data: {
                claimedAmount: roundMoney(
                  Math.max(0, Number(accrual.claimedAmount) - Number(line.amount)),
                ),
              },
            });
          }
        }
        // ADJUSTMENT / CARRYFORWARD lines: deleting the line frees the unique ref
        // (adjustmentId / carriedFromStatementId) so the next generation sweeps
        // them again automatically — no separate release step needed.
        await tx.commissionStatementLine.delete({ where: { id: line.id } });
      }

      return tx.commissionStatement.update({ where: { id }, data: { status: "VOID" } });
    });
  }

  async recordPayout(id: string, dto: RecordCommissionPayoutDto) {
    return this.prisma.tenantTransaction(async (tx) => {
      const statement = await tx.commissionStatement.findUnique({
        where: { id },
        include: { agent: { select: { name: true } } },
      });
      if (!statement) throw new NotFoundException("Commission statement not found");
      if (statement.status !== "APPROVED") {
        throw new ConflictException("Payouts require an APPROVED statement.");
      }
      if (Number(statement.totalAmount) <= 0) {
        throw new BadRequestException("Statement has no payable total.");
      }

      // Re-derive already-paid from the payout rows inside the tx — never trust
      // paidAmount as a snapshot (mirrors vendor-bills' recordSupplierPayment).
      const existingPayouts = await tx.commissionPayout.findMany({ where: { statementId: id } });
      const alreadyPaid = roundMoney(
        existingPayouts.reduce((s: number, p: any) => s + Number(p.amount), 0),
      );
      const remaining = roundMoney(Number(statement.totalAmount) - alreadyPaid);
      const amount = roundMoney(dto.amount);
      if (amount <= 0) throw new BadRequestException("Payout amount must be positive.");
      if (amount > remaining + COMMISSION_EPS) {
        throw new BadRequestException(
          `Payout of ${amount.toFixed(2)} exceeds the remaining balance of ${remaining.toFixed(2)}.`,
        );
      }

      let category = await tx.expenseCategory.findFirst({
        where: { code: "COMMISSIONS_AND_FEES" },
      });
      if (!category) {
        category = await tx.expenseCategory.create({
          data: { name: "Commissions and Fees", code: "COMMISSIONS_AND_FEES", isCustom: false },
        });
      }

      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      const expense = await tx.expense.create({
        data: {
          categoryId: category.id,
          amount,
          date: paidAt,
          paymentMethod: dto.method,
          status: "PAID",
          paidAt,
          description: `Commission payout ${statement.statementNumber} — ${statement.agent.name}`,
        },
      });

      const payout = await tx.commissionPayout.create({
        data: {
          statementId: id,
          amount,
          method: dto.method,
          reference: dto.reference ?? null,
          notes: dto.notes ?? null,
          paidAt,
          expenseId: expense.id,
        },
      });

      const newPaid = roundMoney(alreadyPaid + amount);
      await tx.commissionStatement.update({
        where: { id },
        data: {
          paidAmount: newPaid,
          status: newPaid >= Number(statement.totalAmount) - COMMISSION_EPS ? "PAID" : "APPROVED",
        },
      });

      return payout;
    });
  }

  async listPayouts(id: string) {
    const statement = await this.prisma
      .forTenant()
      .commissionStatement.findUnique({ where: { id } });
    if (!statement) throw new NotFoundException("Commission statement not found");
    return this.prisma.forTenant().commissionPayout.findMany({
      where: { statementId: id },
      orderBy: { paidAt: "desc" },
    });
  }
}
