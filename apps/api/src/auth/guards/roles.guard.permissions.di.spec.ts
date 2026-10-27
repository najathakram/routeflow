import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Global,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import request from "supertest";
import { PrismaService } from "../../prisma/prisma.service";
import { Roles } from "../decorators/roles.decorator";
import { OperatorPermissionsModule } from "../permissions/operator-permissions.module";
import { RequirePermission } from "../permissions/permission.decorators";
import { listenOnLoopback } from "../../common/testing/listen-loopback";
import { RolesGuard } from "./roles.guard";

/**
 * Operator permissions PR3: `RolesGuard` gets the permission service through Nest's DI in a REAL module graph (the service
 * is exported by the @Global OperatorPermissionsModule), not only through a hand-built constructor. A controller that
 * lists `@UseGuards(RolesGuard)` needs no module change; the old one-argument construction path stays valid.
 */
@Injectable()
class FakeAuth implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    ctx.switchToHttp().getRequest().user = { sub: "op1", tenantId: "t1", role: UserRole.OPERATOR };
    return true;
  }
}

@Controller("probe")
class ProbeController {
  @Get("orders")
  @UseGuards(FakeAuth, RolesGuard)
  @Roles(UserRole.OPERATOR)
  @RequirePermission("ORDERS")
  orders() {
    return { ok: true };
  }
}

const findFirst = jest.fn();
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: { user: { findFirst } } }],
  exports: [PrismaService],
})
class FakePrismaModule {}

describe("RolesGuard resolves OperatorPermissionsService through the module graph", () => {
  const boot = async () => {
    const mod = await Test.createTestingModule({
      imports: [FakePrismaModule, OperatorPermissionsModule],
      controllers: [ProbeController],
      providers: [FakeAuth],
    }).compile();
    const app = mod.createNestApplication();
    await listenOnLoopback(app);
    return app;
  };

  it("an operator who switched ORDERS off is still served in SHADOW (the lookup ran through the real service)", async () => {
    findFirst.mockResolvedValue({ deniedPermissionGroups: ["ORDERS"], permissionsVersion: 3 });
    const app = await boot();
    await request(app.getHttpServer()).get("/probe/orders").expect(200, { ok: true });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      id: "op1",
      tenantId: "t1",
      deletedAt: null,
    });
    await app.close();
  });
});
