import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateOrderDto } from "./dto/create-order.dto";
import { UpdateFulfillPathDto } from "./dto/update-fulfill-path.dto";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { CreateCustomerDto } from "../customers/dto/create-customer.dto";
import { UpdateCustomerDto } from "../customers/dto/update-customer.dto";

/**
 * SA-650: PICKUP exists in the DB enum. The CUSTOMER write DTOs refuse it (a customer never has a PICKUP
 * default); the staff order switch PATCH fulfill-path accepts it for POS mode (SA-763r, below). The ORDER create DTO accepts the whole enum: the one resolver
 * refuses PICKUP where the business does not offer it (fulfil-path-resolver.spec.ts, pinned at create in
 * orders.fulfil-path-create.spec.ts). List filters (read) accept it.
 */
async function fulfillPathErrors(cls: new () => object, value: string) {
  const inst = plainToInstance(cls, { fulfillPath: value });
  const errs = await validate(inst, { skipMissingProperties: true });
  return errs.filter((e) => e.property === "fulfillPath");
}

const WRITE_DTOS: Array<[string, new () => object]> = [
  ["CreateCustomerDto", CreateCustomerDto],
  ["UpdateCustomerDto", UpdateCustomerDto],
];

describe("PATCH fulfill-path (SA-763r R3): the staff order switch takes the whole enum the staff may pick", () => {
  it("UpdateFulfillPathDto accepts ROUTE, SHIP and PICKUP and refuses anything else", async () => {
    for (const v of ["ROUTE", "SHIP", "PICKUP"]) {
      expect(await fulfillPathErrors(UpdateFulfillPathDto, v)).toHaveLength(0);
    }
    expect((await fulfillPathErrors(UpdateFulfillPathDto, "DRONE")).length).toBeGreaterThan(0);
  });
});

describe("customer write DTOs refuse FulfillPath PICKUP (SA-650)", () => {
  it.each(WRITE_DTOS)("%s rejects PICKUP", async (_n, cls) => {
    expect((await fulfillPathErrors(cls, "PICKUP")).length).toBeGreaterThan(0);
  });
  it.each(WRITE_DTOS)("%s still accepts ROUTE and SHIP", async (_n, cls) => {
    expect(await fulfillPathErrors(cls, "ROUTE")).toHaveLength(0);
    expect(await fulfillPathErrors(cls, "SHIP")).toHaveLength(0);
  });
  it("CreateOrderDto accepts the whole enum (the resolver is the refusal where PICKUP is not offered)", async () => {
    for (const v of ["ROUTE", "SHIP", "PICKUP"])
      expect(await fulfillPathErrors(CreateOrderDto, v)).toHaveLength(0);
    expect((await fulfillPathErrors(CreateOrderDto, "DRONE")).length).toBeGreaterThan(0);
  });
  it("ListOrdersDto (read filter) accepts PICKUP", async () => {
    expect(await fulfillPathErrors(ListOrdersDto, "PICKUP")).toHaveLength(0);
  });
});
