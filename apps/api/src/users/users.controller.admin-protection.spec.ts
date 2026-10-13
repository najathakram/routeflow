/** Admin account protection: the controller hands the CALLER'S ROLE to every guarded action. */
import { UserRole } from "@prisma/client";
import { UsersController } from "./users.controller";

describe("UsersController: admin account protection wiring", () => {
  const service = {
    resetPassword: jest.fn().mockResolvedValue({ tempPassword: "x" }),
    changeStatus: jest.fn().mockResolvedValue({ id: "t1" }),
    updateUser: jest.fn().mockResolvedValue({ id: "t1" }),
    unlockUser: jest.fn().mockResolvedValue({ id: "t1" }),
    toggleDriverPermit: jest.fn().mockResolvedValue({ id: "t1" }),
  };
  const controller = new UsersController(service as any, {} as any);
  const operator = { sub: "op1", username: "op", role: UserRole.OPERATOR } as any;
  const admin = { sub: "ad1", username: "ad", role: UserRole.TENANT_ADMIN } as any;
  beforeEach(() => jest.clearAllMocks());

  it("reset-password passes the caller's role", async () => {
    await controller.resetPassword("t1", operator);
    expect(service.resetPassword).toHaveBeenCalledWith("t1", UserRole.OPERATOR);
    await controller.resetPassword("t1", admin);
    expect(service.resetPassword).toHaveBeenLastCalledWith("t1", UserRole.TENANT_ADMIN);
  });
  it("status change passes the caller's role", async () => {
    await controller.changeStatus("t1", { status: "SUSPENDED" } as any, operator);
    expect(service.changeStatus).toHaveBeenCalledWith(
      "t1",
      { status: "SUSPENDED" },
      UserRole.OPERATOR,
      "op1", // the caller's id: self-deactivation is refused (SA M2)
    );
  });
  it("update passes the caller's role", async () => {
    // Editing ANOTHER user is account administration (admin only); an operator edits their own record.
    await controller.update("t1", { email: "a@b.example" } as any, admin);
    expect(service.updateUser).toHaveBeenCalledWith(
      "t1",
      { email: "a@b.example" },
      "ad",
      UserRole.TENANT_ADMIN,
    );
    await controller.update("op1", { email: "a@b.example" } as any, operator);
    expect(service.updateUser).toHaveBeenLastCalledWith(
      "op1",
      { email: "a@b.example", role: undefined },
      "op",
      UserRole.OPERATOR,
    );
  });
  it("unlock and driver-permit pass the caller's role", async () => {
    await controller.unlock("t1", operator);
    expect(service.unlockUser).toHaveBeenCalledWith("t1", UserRole.OPERATOR);
    await controller.toggleDriverPermit("t1", admin);
    expect(service.toggleDriverPermit).toHaveBeenCalledWith("t1", UserRole.TENANT_ADMIN);
  });
});
