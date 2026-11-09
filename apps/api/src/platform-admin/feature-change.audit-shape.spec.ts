/**
 * WP11 guard (a): the change set writes its audit row inside the transaction with `tx.auditLog.create`
 * (`auditRowData`), because `AuditService.log` swallows write errors and a failed audit write has to fail the set.
 * That second writer must not drift from `PlatformAdminService.recordAdminAction`, so this drives BOTH with one
 * fixture, through the real `AuditService`, and compares what each hands to `auditLog.create`.
 */
import { AuditService } from "../audit/audit.service";
import { PlatformAdminService } from "./platform-admin.service";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "./audit-actions.constant";
import { auditRowData } from "./feature-change.service";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const META = { reason: "Pilot", hashBefore: "aaa", hashAfter: "bbb", changes: [{ key: "ocr" }] };

describe("WP11: the in-transaction audit row has the same shape as recordAdminAction's", () => {
  it("same action, entity type, entity id, actor and platformAdmin flag for the same inputs", async () => {
    const written: Record<string, unknown>[] = [];
    const prismaFake = {
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          written.push(data);
          return { id: "row" };
        }),
      },
    };
    const audit = new AuditService(prismaFake as never);
    const svc = Object.create(PlatformAdminService.prototype) as PlatformAdminService;
    (svc as unknown as { auditService: AuditService }).auditService = audit;

    await svc.recordAdminAction(TENANT, ACTOR, AdminAuditAction.FEATURE_CHANGE_SET_APPLIED, META);
    const viaService = written[0];
    const direct = auditRowData(TENANT, ACTOR, AdminAuditAction.FEATURE_CHANGE_SET_APPLIED, META);

    for (const field of ["tenantId", "userId", "action", "entityType", "entityId"] as const) {
      expect(direct[field]).toEqual(viaService[field]);
    }
    expect(direct.entityType).toBe(ADMIN_AUDIT_ENTITY);
    expect(direct.entityId).toBe(TENANT);
    expect(direct.userId).toBe(ACTOR);
    expect(direct.meta).toEqual(viaService.meta);
    expect((direct.meta as Record<string, unknown>).platformAdmin).toBe(true);
  });

  it("recordAdminAction still reaches auditLog.create (a drift in the fake is not the reason the spec passes)", async () => {
    const create = jest.fn(async () => ({ id: "row" }));
    const audit = new AuditService({ auditLog: { create } } as never);
    const svc = Object.create(PlatformAdminService.prototype) as PlatformAdminService;
    (svc as unknown as { auditService: AuditService }).auditService = audit;
    await svc.recordAdminAction(TENANT, ACTOR, AdminAuditAction.FEATURE_OVERRIDE_SET, {});
    expect(create).toHaveBeenCalledTimes(1);
  });
});
