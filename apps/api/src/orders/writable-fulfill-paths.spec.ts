import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateOrderDto } from "./dto/create-order.dto";
import { UpdateFulfillPathDto } from "./dto/update-fulfill-path.dto";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { CreateCustomerDto } from "../customers/dto/create-customer.dto";
import { UpdateCustomerDto } from "../customers/dto/update-customer.dto";

/**
 * SA-650: PICKUP exists in the DB enum but NO write DTO may accept it until the counter-sale API
 * lands. List filters (read) accept it.
 */
async function fulfillPathErrors(cls: new () => object, value: string) {
  const inst = plainToInstance(cls, { fulfillPath: value });
  const errs = await validate(inst, { skipMissingProperties: true });
  return errs.filter((e) => e.property === "fulfillPath");
}

const WRITE_DTOS: Array<[string, new () => object]> = [
  ["CreateOrderDto", CreateOrderDto],
  ["UpdateFulfillPathDto", UpdateFulfillPathDto],
  ["CreateCustomerDto", CreateCustomerDto],
  ["UpdateCustomerDto", UpdateCustomerDto],
];

describe("write DTOs refuse FulfillPath PICKUP (SA-650)", () => {
  it.each(WRITE_DTOS)("%s rejects PICKUP", async (_n, cls) => {
    expect((await fulfillPathErrors(cls, "PICKUP")).length).toBeGreaterThan(0);
  });
  it.each(WRITE_DTOS)("%s still accepts ROUTE and SHIP", async (_n, cls) => {
    expect(await fulfillPathErrors(cls, "ROUTE")).toHaveLength(0);
    expect(await fulfillPathErrors(cls, "SHIP")).toHaveLength(0);
  });
  it("ListOrdersDto (read filter) accepts PICKUP", async () => {
    expect(await fulfillPathErrors(ListOrdersDto, "PICKUP")).toHaveLength(0);
  });
});
