/** Admin account protection: DELETE /drivers/:id hands the CALLER'S ROLE to the service. */
import { UserRole } from "@prisma/client";
import { DriversController } from "./drivers.controller";

describe("DriversController: admin account protection wiring", () => {
  const service = {
    remove: jest.fn().mockResolvedValue({ success: true }),
    update: jest.fn().mockResolvedValue({}),
    updateByUserId: jest.fn().mockResolvedValue({}),
    changeStatus: jest.fn().mockResolvedValue({ success: true }),
  };
  const controller = new DriversController(service as any);
  const operator = { sub: "op1", username: "op", role: UserRole.OPERATOR } as any;
  const admin = { sub: "ad1", username: "ad", role: UserRole.TENANT_ADMIN } as any;
  beforeEach(() => jest.clearAllMocks());

  it("remove passes the caller's role", async () => {
    await controller.remove("drv-1", operator);
    expect(service.remove).toHaveBeenCalledWith("drv-1", UserRole.OPERATOR);
    await controller.remove("drv-1", admin);
    expect(service.remove).toHaveBeenLastCalledWith("drv-1", UserRole.TENANT_ADMIN);
  });

  it("update and changeStatus pass the caller's role", async () => {
    const dto = { contactName: "New" } as any;
    await controller.update("drv-1", dto, operator);
    expect(service.update).toHaveBeenCalledWith("drv-1", dto, UserRole.OPERATOR);
    await controller.update("drv-1", dto, admin);
    expect(service.update).toHaveBeenLastCalledWith("drv-1", dto, UserRole.TENANT_ADMIN);
    const status = { status: "INACTIVE" } as any;
    await controller.changeStatus("drv-1", status, operator);
    expect(service.changeStatus).toHaveBeenCalledWith("drv-1", status, UserRole.OPERATOR);
    await controller.changeStatus("drv-1", status, admin);
    expect(service.changeStatus).toHaveBeenLastCalledWith("drv-1", status, UserRole.TENANT_ADMIN);
  });

  it("PATCH /drivers/me (self edit) passes the caller's own role", async () => {
    const dto = { contactName: "New" } as any;
    await controller.updateMe(admin, dto);
    expect(service.updateByUserId).toHaveBeenCalledWith("ad1", dto, UserRole.TENANT_ADMIN);
  });
});
