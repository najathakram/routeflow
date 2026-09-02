import { JwtStrategy } from "./jwt.strategy";
import { BuyerJwtStrategy } from "../../buyer/strategies/buyer-jwt.strategy";

const configService = { get: () => ({ secret: "test-secret" }) } as any;

const staffPayload = {
  sub: "ta1",
  username: "tenant_admin",
  role: "TENANT_ADMIN",
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
} as any;

describe("JwtStrategy / BuyerJwtStrategy — impersonatedBy propagation (B165, B138)", () => {
  it("REG-B165 REG-B138 the staff strategy passes impersonatedBy through to req.user", async () => {
    const out = await new JwtStrategy(configService).validate({
      ...staffPayload,
      impersonatedBy: "sa1",
    });
    expect(out).toMatchObject({ sub: "ta1", id: "ta1", role: "TENANT_ADMIN", tenantId: "t1" });
    expect(out.impersonatedBy).toBe("sa1");
  });

  it("pin (B165): without the claim the staff result carries impersonatedBy undefined and no isAdmin", async () => {
    const out = await new JwtStrategy(configService).validate(staffPayload);
    expect(out.impersonatedBy).toBeUndefined();
    expect(out).not.toHaveProperty("isAdmin");
  });

  it("REG-B165 the buyer strategy passes impersonatedBy through", async () => {
    const out = await new BuyerJwtStrategy(configService).validate({
      sub: "b1",
      email: "b@x.test",
      type: "BUYER",
      impersonatedBy: "sa1",
    } as any);
    expect(out).toMatchObject({ sub: "b1", email: "b@x.test", type: "BUYER" });
    expect((out as any).impersonatedBy).toBe("sa1");
  });

  it("pin (B165): a buyer token without the claim yields impersonatedBy undefined", async () => {
    const out = await new BuyerJwtStrategy(configService).validate({
      sub: "b1",
      email: "b@x.test",
      type: "BUYER",
    } as any);
    expect((out as any).impersonatedBy).toBeUndefined();
  });
});
