import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole, type PolicyValue } from "@prisma/client";
import type {
  PoliciesResponse,
  PolicyHistoryResponse,
  PolicyJsonValue,
  PolicyValueRow,
  PolicyWriteResponse,
} from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PolicyService, type PolicyActor } from "./policy.service";
import { POLICY_REGISTRY, policyJsonSchema, type PolicyEntry } from "./policy-registry";
import { ClearPolicyDto, ClearPolicyQueryDto, SetPolicyDto } from "./dto/policy.dto";

function toRow(r: PolicyValue): PolicyValueRow {
  return {
    id: r.id,
    key: r.key,
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    value: r.value as PolicyJsonValue,
    reason: r.reason,
    setById: r.setById,
    setByName: r.setByName,
    createdAt: r.createdAt.toISOString(),
    supersededAt: r.supersededAt ? r.supersededAt.toISOString() : null,
    supersededById: r.supersededById,
  };
}

/**
 * SA-138 phase 1 — the tenant's own POLICY values. Addon-free on purpose: a policy is not a
 * feature, and nothing on the platform side may make one unreachable to the tenant.
 */
@ApiTags("policies")
@ApiBearerAuth()
@Controller("policies")
@UseGuards(JwtAuthGuard, RolesGuard)
export class PolicyController {
  constructor(private readonly policies: PolicyService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  @ApiOperation({ summary: "Policy registry plus this tenant's active values per scope" })
  async list(@CurrentUser() user: JwtPayload): Promise<PoliciesResponse> {
    const tenantId = this.tenantOf(user);
    const rows = await this.policies.listActive(tenantId);
    return {
      policies: (POLICY_REGISTRY as readonly PolicyEntry<unknown>[]).map((e) => ({
        key: e.key,
        area: e.area,
        kind: e.kind,
        schema: policyJsonSchema(e),
        default: e.default as PolicyJsonValue,
        scopes: [...e.scopes],
        description: e.description,
        added: e.added,
        pilotPending: e.pilotPending === true,
        active: rows.filter((r) => r.key === e.key).map(toRow),
      })),
    };
  }

  @Get(":key/history")
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Superseded values of one policy, newest first" })
  async history(
    @CurrentUser() user: JwtPayload,
    @Param("key") key: string,
  ): Promise<PolicyHistoryResponse> {
    const rows = await this.policies.history(this.tenantOf(user), key);
    return { key, history: rows.map(toRow) };
  }

  @Put(":key")
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Set a policy value at one scope (reason required)" })
  async set(
    @CurrentUser() user: JwtPayload,
    @Param("key") key: string,
    @Body() body: SetPolicyDto,
  ): Promise<PolicyWriteResponse> {
    const row = await this.policies.set({
      tenantId: this.tenantOf(user),
      key,
      scopeType: body.scopeType,
      scopeId: body.scopeId ?? null,
      value: body.value,
      reason: body.reason,
      actor: this.actorOf(user),
    });
    return { row: toRow(row) };
  }

  @Delete(":key")
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Clear a policy value at one scope (reason required)" })
  async clear(
    @CurrentUser() user: JwtPayload,
    @Param("key") key: string,
    @Query() query: ClearPolicyQueryDto,
    @Body() body: ClearPolicyDto,
  ): Promise<PolicyWriteResponse> {
    const row = await this.policies.clear({
      tenantId: this.tenantOf(user),
      key,
      scopeType: query.scopeType,
      scopeId: query.scopeId ?? null,
      reason: body.reason,
      actor: this.actorOf(user),
    });
    return { row: toRow(row) };
  }

  private tenantOf(user: JwtPayload): string {
    if (!user?.tenantId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: API_ERROR_CODES.TENANT_CONTEXT_REQUIRED,
        message: "Policies are per tenant — no tenant context on this token.",
      });
    }
    return user.tenantId;
  }

  private actorOf(user: JwtPayload): PolicyActor {
    return {
      id: user.sub ?? null,
      name: user.username ?? null,
      impersonatedBy: user.impersonatedBy ?? null,
    };
  }
}
