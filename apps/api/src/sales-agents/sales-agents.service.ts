import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AgentAssignment } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { roundMoney } from "@routeflow/pricing";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CommissionEngineService } from "./commission-engine.service";
import { COMMISSION_EPS } from "./commission-math";
import {
  AddAgentAssignmentDto,
  AddCustomerCommissionRateDto,
  AddSalesAgentRateDto,
  BulkAgentAssignmentDto,
  CloseAgentAssignmentDto,
  CreateSalesAgentDto,
  ListCommissionAccrualsDto,
  ListSalesAgentsDto,
  RecomputeCommissionsDto,
  UpdateSalesAgentDto,
  UpdateSalesAgentStatusDto,
} from "./sales-agents.controller";

/**
 * Sales agent records + rates + customer attribution + the accrual ledger
 * (read side). All money re-derives from CommissionAccrual/CommissionAdjustment
 * rows — nothing here is a cached total. Backdated rate/assignment writes
 * trigger CommissionEngineService.recomputeCommissionRange so the ledger stays
 * converged (see the plan's "ledger invariant" section).
 */
@Injectable()
export class SalesAgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commissionEngine: CommissionEngineService,
    private readonly audit: AuditService,
  ) {}

  private async ensureExists(id: string) {
    const agent = await this.prisma.forTenant().salesAgent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException("Sales agent not found");
    return agent;
  }

  private async ensureActiveAgent(id: string) {
    const agent = await this.ensureExists(id);
    if (agent.deletedAt) throw new BadRequestException("Sales agent has been deleted");
    return agent;
  }

  async findAll(query: ListSalesAgentsDto) {
    const where: any = {};
    if (!query.includeDeleted) where.deletedAt = null;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
      ];
    }
    const agents = await this.prisma.forTenant().salesAgent.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        assignments: { where: { effectiveTo: null }, select: { id: true } },
        rates: { orderBy: { effectiveFrom: "desc" }, take: 1 },
      },
    });
    return agents.map(({ assignments, rates, ...agent }: any) => ({
      ...agent,
      openAssignmentCount: assignments.length,
      currentRatePct: rates[0] ? Number(rates[0].ratePct) : null,
    }));
  }

  async create(dto: CreateSalesAgentDto) {
    return this.prisma.tenantTransaction(async (tx) => {
      const agent = await tx.salesAgent.create({
        data: {
          name: dto.name,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          notes: dto.notes ?? null,
        },
      });
      if (dto.defaultRatePct != null) {
        await tx.salesAgentRate.create({
          data: {
            agentId: agent.id,
            ratePct: dto.defaultRatePct,
            effectiveFrom: dto.rateEffectiveFrom ? new Date(dto.rateEffectiveFrom) : new Date(),
          },
        });
      }
      return agent;
    });
  }

  async findOne(id: string) {
    const agent = await this.prisma.forTenant().salesAgent.findUnique({
      where: { id },
      include: {
        rates: { orderBy: { effectiveFrom: "desc" } },
        assignments: {
          where: { effectiveTo: null },
          include: { customer: { select: { id: true, businessName: true } } },
        },
      },
    });
    if (!agent) throw new NotFoundException("Sales agent not found");
    const totals = await this.prisma.forTenant().commissionAccrual.aggregate({
      where: { agentId: id },
      _sum: { accruedAmount: true, payableAmount: true, claimedAmount: true },
    });
    return {
      ...agent,
      accrualTotals: {
        accrued: roundMoney(Number(totals._sum.accruedAmount ?? 0)),
        payable: roundMoney(Number(totals._sum.payableAmount ?? 0)),
        claimed: roundMoney(Number(totals._sum.claimedAmount ?? 0)),
      },
    };
  }

  async update(id: string, dto: UpdateSalesAgentDto) {
    await this.ensureActiveAgent(id);
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.notes !== undefined) data.notes = dto.notes;
    return this.prisma.forTenant().salesAgent.update({ where: { id }, data });
  }

  async updateStatus(id: string, dto: UpdateSalesAgentStatusDto, user: JwtPayload) {
    const agent = await this.ensureActiveAgent(id);
    const data: any = { status: dto.status };
    if (dto.status === "STOPPED_FOR_NEW") {
      data.stopNewBusinessAt = dto.stopNewBusinessAt ? new Date(dto.stopNewBusinessAt) : new Date();
    } else if (agent.status === "STOPPED_FOR_NEW") {
      // Leaving STOPPED_FOR_NEW clears the grandfathering pivot.
      data.stopNewBusinessAt = null;
    }
    const updated = await this.prisma.forTenant().salesAgent.update({ where: { id }, data });
    await this.audit.log({
      tenantId: this.prisma.getTenantId(),
      userId: user.sub,
      action: "salesAgent.status",
      entityType: "SalesAgent",
      entityId: id,
      meta: { from: agent.status, to: dto.status, stopNewBusinessAt: updated.stopNewBusinessAt },
    });
    return updated;
  }

  async remove(id: string) {
    await this.ensureActiveAgent(id);
    const [claimedAccruals, openStatement] = await Promise.all([
      this.prisma.forTenant().commissionAccrual.findMany({
        where: { agentId: id, claimedAmount: { gt: 0 } },
        include: { adjustments: { select: { amount: true } } },
      }),
      // "non-PAID statement" per the plan's DELETE /:id acceptance criterion —
      // PENDING/APPROVED are open financial obligations; VOID is conservatively
      // included too (it's an edge case, and over-blocking a delete is the safe
      // failure mode for money — never data loss, just a manual unblock).
      this.prisma.forTenant().commissionStatement.findFirst({
        where: { agentId: id, status: { not: "PAID" } },
      }),
    ]);
    const hasUnconvergedDrift = claimedAccruals.some((a: any) => {
      const adjTotal = a.adjustments.reduce((s: number, x: any) => s + Number(x.amount), 0);
      const drift = Number(a.payableAmount) - Number(a.claimedAmount) - adjTotal;
      return Math.abs(drift) > COMMISSION_EPS;
    });
    if (hasUnconvergedDrift || openStatement) {
      throw new ConflictException(
        "Cannot delete a sales agent with unconverged claimed commission or a non-paid statement outstanding.",
      );
    }
    return this.prisma.forTenant().salesAgent.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addRate(agentId: string, dto: AddSalesAgentRateDto) {
    await this.ensureActiveAgent(agentId);
    const effectiveFrom = new Date(dto.effectiveFrom);
    let rate;
    try {
      rate = await this.prisma.forTenant().salesAgentRate.create({
        data: { agentId, ratePct: dto.ratePct, effectiveFrom },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException(
          "A rate already exists for this agent at that effective date/time.",
        );
      }
      throw err;
    }
    if (effectiveFrom.getTime() >= Date.now()) return { rate };
    const recompute = await this.commissionEngine.recomputeCommissionRange(
      { agentId },
      effectiveFrom,
    );
    return { rate, recompute };
  }

  async removeRate(agentId: string, rateId: string) {
    await this.ensureActiveAgent(agentId);
    const rate = await this.prisma.forTenant().salesAgentRate.findUnique({ where: { id: rateId } });
    if (!rate || rate.agentId !== agentId) throw new NotFoundException("Rate not found");
    if (rate.effectiveFrom.getTime() <= Date.now()) {
      throw new BadRequestException(
        "Only future-dated rates can be removed; past rates are history — insert a correcting row instead.",
      );
    }
    await this.prisma.forTenant().salesAgentRate.delete({ where: { id: rateId } });
    return { deleted: true };
  }

  async addCustomerRate(agentId: string, dto: AddCustomerCommissionRateDto) {
    await this.ensureActiveAgent(agentId);
    const effectiveFrom = new Date(dto.effectiveFrom);
    let rate;
    try {
      rate = await this.prisma.forTenant().customerCommissionRate.create({
        data: { customerId: dto.customerId, agentId, ratePct: dto.ratePct, effectiveFrom },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException("A customer rate already exists at that effective date/time.");
      }
      throw err;
    }
    if (effectiveFrom.getTime() >= Date.now()) return { rate };
    const recompute = await this.commissionEngine.recomputeCommissionRange(
      { customerId: dto.customerId },
      effectiveFrom,
    );
    return { rate, recompute };
  }

  /**
   * An assignment interval is [effectiveFrom, effectiveTo). Closing the open row
   * at or before its own effectiveFrom inverts it, and an inverted interval
   * covers no date at all — so every accrual the outgoing agent earned would be
   * silently reattributed, with nothing in the row data left to recover the real
   * window from. History is never rewritten here: reject and make the operator
   * correct the existing row explicitly.
   */
  private assertClosesAfterStart(
    open: { effectiveFrom: Date } | null,
    closeAt: Date,
    customerId: string,
  ) {
    if (!open || closeAt.getTime() > open.effectiveFrom.getTime()) return;
    throw new BadRequestException(
      `Customer ${customerId} already has an assignment effective ${open.effectiveFrom.toISOString()}; ` +
        `the new effective date (${closeAt.toISOString()}) must be after it. ` +
        `Correct the existing assignment instead of backdating over it.`,
    );
  }

  async addAssignment(agentId: string, dto: AddAgentAssignmentDto) {
    await this.ensureActiveAgent(agentId);
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date();
    let assignment;
    try {
      assignment = await this.prisma.tenantTransaction(async (tx) => {
        // Close the customer's currently-open row (if any); the partial unique
        // index (AgentAssignment_open_assignment_key) backstops races between
        // this updateMany and the create below.
        const open = await tx.agentAssignment.findFirst({
          where: { customerId: dto.customerId, effectiveTo: null },
          select: { effectiveFrom: true },
        });
        this.assertClosesAfterStart(open, effectiveFrom, dto.customerId);
        await tx.agentAssignment.updateMany({
          where: { customerId: dto.customerId, effectiveTo: null },
          data: { effectiveTo: effectiveFrom },
        });
        return tx.agentAssignment.create({
          data: { customerId: dto.customerId, agentId, effectiveFrom },
        });
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException("Another assignment change raced this one — reload and retry.");
      }
      throw err;
    }
    if (effectiveFrom.getTime() >= Date.now()) return { assignment };
    const recompute = await this.commissionEngine.recomputeCommissionRange(
      { customerId: dto.customerId },
      effectiveFrom,
    );
    return { assignment, recompute };
  }

  async addAssignmentsBulk(agentId: string, dto: BulkAgentAssignmentDto) {
    await this.ensureActiveAgent(agentId);
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date();
    const assignments = await this.prisma.tenantTransaction(async (tx) => {
      const created: AgentAssignment[] = [];
      for (const customerId of dto.customerIds) {
        const open = await tx.agentAssignment.findFirst({
          where: { customerId, effectiveTo: null },
          select: { effectiveFrom: true },
        });
        this.assertClosesAfterStart(open, effectiveFrom, customerId);
        await tx.agentAssignment.updateMany({
          where: { customerId, effectiveTo: null },
          data: { effectiveTo: effectiveFrom },
        });
        created.push(
          await tx.agentAssignment.create({ data: { customerId, agentId, effectiveFrom } }),
        );
      }
      return created;
    });
    if (effectiveFrom.getTime() >= Date.now()) return { assignments };
    // agentId scope covers every customer now assigned to this agent — including
    // the ones just bulk-assigned — so one recompute call suffices for the batch.
    const recompute = await this.commissionEngine.recomputeCommissionRange(
      { agentId },
      effectiveFrom,
    );
    return { assignments, recompute };
  }

  async closeAssignment(dto: CloseAgentAssignmentDto) {
    const effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : new Date();
    const open = await this.prisma.forTenant().agentAssignment.findFirst({
      where: { customerId: dto.customerId, effectiveTo: null },
      select: { effectiveFrom: true },
    });
    if (!open) throw new NotFoundException("No open assignment found for this customer");
    this.assertClosesAfterStart(open, effectiveTo, dto.customerId);
    const result = await this.prisma.forTenant().agentAssignment.updateMany({
      where: { customerId: dto.customerId, effectiveTo: null },
      data: { effectiveTo },
    });
    if (result.count === 0) {
      throw new NotFoundException("No open assignment found for this customer");
    }
    if (effectiveTo.getTime() >= Date.now()) return { closed: result.count };
    // A backdated close is an attribution change like any other backdate — sweep
    // it through the same recompute path so invoices in the backdated window
    // zero-target the agent who lost the customer (acceptance criterion #11).
    const recompute = await this.commissionEngine.recomputeCommissionRange(
      { customerId: dto.customerId },
      effectiveTo,
    );
    return { closed: result.count, recompute };
  }

  /**
   * Read side for the customer-page "agent box" and the mobile parity row:
   * the OPEN assignment (effectiveTo IS NULL — at most one, enforced by the
   * AgentAssignment_open_assignment_key partial unique index) plus the
   * customer's currently-effective per-customer rate. Display-only — the
   * engine resolves rates per-invoice on basisDate; this is "as of now".
   */
  async currentAssignment(customerId: string) {
    const assignment = await this.prisma.forTenant().agentAssignment.findFirst({
      where: { customerId, effectiveTo: null },
      include: { agent: { select: { id: true, name: true, status: true, deletedAt: true } } },
    });
    const rate = await this.prisma.forTenant().customerCommissionRate.findFirst({
      where: { customerId, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: "desc" },
      select: { ratePct: true, effectiveFrom: true },
    });
    return {
      assignment: assignment
        ? { id: assignment.id, effectiveFrom: assignment.effectiveFrom, agent: assignment.agent }
        : null,
      customerRatePct: rate ? Number(rate.ratePct) : null,
    };
  }

  async getAccruals(agentId: string, query: ListCommissionAccrualsDto) {
    await this.ensureExists(agentId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where: any = { agentId };
    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      where.basisDate = {};
      if (query.from) where.basisDate.gte = new Date(query.from);
      if (query.to) where.basisDate.lte = new Date(query.to);
    }
    const [rows, total] = await Promise.all([
      this.prisma.forTenant().commissionAccrual.findMany({
        where,
        orderBy: { basisDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          invoice: { select: { id: true, invoiceNumber: true } },
          customer: { select: { id: true, businessName: true } },
          adjustments: { select: { amount: true } },
        },
      }),
      this.prisma.forTenant().commissionAccrual.count({ where }),
    ]);
    const items = rows.map(({ adjustments, ...row }: any) => {
      const adjustmentsTotal = roundMoney(
        adjustments.reduce((s: number, a: any) => s + Number(a.amount), 0),
      );
      const drift = roundMoney(
        Number(row.payableAmount) - Number(row.claimedAmount) - adjustmentsTotal,
      );
      return { ...row, adjustmentsTotal, drift };
    });
    return { items, total, page, limit };
  }

  async recompute(agentId: string, dto: RecomputeCommissionsDto) {
    await this.ensureExists(agentId);
    return this.commissionEngine.recomputeCommissionRange({ agentId }, new Date(dto.fromDate));
  }
}
