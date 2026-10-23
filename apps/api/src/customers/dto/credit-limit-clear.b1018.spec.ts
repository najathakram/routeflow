import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateCustomerDto } from "./create-customer.dto";
import { UpdateCustomerDto } from "./update-customer.dto";
import { customerUpdateData } from "../customer-update-data";

/**
 * B1018 / SA-642: `null` clears a stored credit limit ("no limit") on UPDATE ONLY. `undefined` leaves it alone, `0` is a real
 * $0 limit, a number sets it. A create payload may omit the field but may not send null.
 */
const PIPE_OPTS = { whitelist: true, forbidNonWhitelisted: true };
const upd = (extra: Record<string, unknown>) =>
  plainToInstance(UpdateCustomerDto, { ...extra }, { enableImplicitConversion: true });
const cre = (extra: Record<string, unknown>) =>
  plainToInstance(
    CreateCustomerDto,
    { username: "acme", businessName: "Acme", contactName: "A Buyer", ...extra },
    { enableImplicitConversion: true },
  );
const clErrors = async (dto: object) =>
  (await validate(dto, PIPE_OPTS)).filter((e) => e.property === "creditLimit");

describe("UpdateCustomerDto.creditLimit (B1018)", () => {
  it("accepts null (clear), 0 (a real $0 limit), a number and the column max", async () => {
    for (const v of [null, 0, 500, 99_999_999.99])
      expect(await clErrors(upd({ creditLimit: v }))).toEqual([]);
  });

  it("accepts an omitted field (leave as is)", async () => {
    expect(await clErrors(upd({}))).toEqual([]);
  });

  it.each([["abc"], [-1], [1.234], [100_000_000]])("still refuses %p", async (v) => {
    expect((await clErrors(upd({ creditLimit: v }))).length).toBeGreaterThan(0);
  });
});

describe("CreateCustomerDto.creditLimit (B1018): null is for UPDATE only", () => {
  it("refuses null on create, accepts omitted, 0 and a number", async () => {
    expect((await clErrors(cre({ creditLimit: null }))).length).toBeGreaterThan(0);
    for (const extra of [{}, { creditLimit: 0 }, { creditLimit: 250 }])
      expect(await clErrors(cre(extra))).toEqual([]);
  });
});

describe("customerUpdateData.creditLimit (B1018)", () => {
  it("null clears, undefined leaves the key out, 0 and a number are written as given", () => {
    expect(customerUpdateData(upd({ creditLimit: null }))).toHaveProperty("creditLimit", null);
    expect(customerUpdateData(upd({}))).not.toHaveProperty("creditLimit");
    expect(customerUpdateData(upd({ creditLimit: 0 }))).toHaveProperty("creditLimit", 0);
    expect(customerUpdateData(upd({ creditLimit: 500 }))).toHaveProperty("creditLimit", 500);
  });

  it("an unrelated partial PATCH never carries creditLimit (no accidental clear)", () => {
    const data = customerUpdateData(upd({ phone: "5551234567", notes: "x" }));
    expect(data).not.toHaveProperty("creditLimit");
  });
});
