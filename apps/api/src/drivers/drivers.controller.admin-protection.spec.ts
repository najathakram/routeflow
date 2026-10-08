/** Admin account protection: DELETE /drivers/:id hands the CALLER'S ROLE to the service. */
import { UserRole } from "@prisma/client";
import { DriversController } from "./drivers.controller";

describe("DriversController: admin account protection wiring", () => {
  const service = { remove: jest.fn().mockResolvedValue({ success: true }) };
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
});
