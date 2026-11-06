import { CustomersController } from "./customers.controller";

/**
 * D6 / B462 — the operator statement route is the ONLY caller that asks
 * `getStatementForOperator` for the credit-exposure figures. The buyer portal reuses
 * the same service method (buyer.controller.ts) and must NOT be handed the seller's
 * unissued-draft totals; that side is pinned in buyer.controller.spec.ts.
 */
describe("CustomersController.getStatement — operator statement asks for exposure (D6 / B462)", () => {
  it("passes { includeExposure: true } to getStatementForOperator", async () => {
    const customersService = {
      getStatementForOperator: jest.fn().mockResolvedValue({ creditExposure: 95 }),
    };
    const controller = new CustomersController(
      customersService as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(controller.getStatement("cust-1")).resolves.toEqual({ creditExposure: 95 });

    expect(customersService.getStatementForOperator).toHaveBeenCalledTimes(1);
    expect(customersService.getStatementForOperator).toHaveBeenCalledWith("cust-1", {
      includeExposure: true,
    });
  });
});
