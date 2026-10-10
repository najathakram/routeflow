import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { NumberingController } from "./numbering.controller";
import { NumberingService } from "./numbering.service";

// SA-274 (cause-ruling.md §2 Q6, bug-test-plan.md "Red set — api controller"):
// PAYMENT is dropped from the numbering card in this PR — a PUT for it must
// be a 400, not a pass-through to the service. Guards (`JwtAuthGuard`,
// `RolesGuard`) are declared via `@UseGuards` on the controller class, but
// calling the controller method directly (as every test below does) never
// runs Nest's request pipeline, so they need no provider here — same idiom as
// `apps/api/src/system-config/settings.controller.spec.ts`.
describe("NumberingController", () => {
  let controller: NumberingController;
  let service: { updateSettings: jest.Mock; getSettings: jest.Mock };

  beforeEach(async () => {
    service = {
      updateSettings: jest.fn().mockResolvedValue({ docType: "PAYMENT", preview: "PAY-0001" }),
      getSettings: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [NumberingController],
      providers: [{ provide: NumberingService, useValue: service }],
    }).compile();

    controller = moduleRef.get(NumberingController);
  });

  it("REG-B861-K PUT /import/numbering/PAYMENT is a 400 (Q6)", async () => {
    // Fails TODAY: PAYMENT is still in DOCUMENT_NUMBER_TYPES, so parseDocType
    // accepts it and this resolves through to the service's mocked
    // `{ docType: "PAYMENT", preview: "PAY-0001" }" — wrapped in a promise so
    // a resolved (non-throwing) return is observable by `.rejects`.
    await expect(
      Promise.resolve().then(() => controller.updateSettings("PAYMENT", {} as any)),
    ).rejects.toThrow(BadRequestException);
  });
});
