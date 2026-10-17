import { BadRequestException, ValidationPipe } from "@nestjs/common";
import {
  AddRuleTargetsDto,
  RemoveRuleTargetsDto,
  RulesHoldingDto,
  RULE_TARGETS_MAX_PER_REQUEST,
  RULE_TARGETS_MAX_PER_RULE,
} from "./rule-targets.dto";
import { CreateRestrictionDto } from "./create-restriction.dto";

/**
 * Row 509 PR2: the DTO half of the rule-target caps and shapes. The coded RULE_TARGET_LIMIT (1,000 per call)
 * is the service's job so the web gets `code` + `field`; the DTO only bounds memory (5,000 per array) and
 * checks shapes. The shared contract numbers are pinned against `@routeflow/types`.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const run = <T>(metatype: new () => T, body: object) =>
  pipe.transform(body, { type: "body", metatype });
const ids = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe("rule target caps match the shared contract", () => {
  it("per request / per rule", () => {
    const shared = require("@routeflow/types") as {
      RULE_TARGETS_MAX_PER_REQUEST: number;
      RULE_TARGETS_MAX_PER_RULE: number;
    };
    expect(RULE_TARGETS_MAX_PER_REQUEST).toBe(shared.RULE_TARGETS_MAX_PER_REQUEST);
    expect(RULE_TARGETS_MAX_PER_RULE).toBe(shared.RULE_TARGETS_MAX_PER_RULE);
  });
});

describe("AddRuleTargetsDto", () => {
  it("accepts product ids, label ids, or both", async () => {
    await expect(run(AddRuleTargetsDto, { productIds: ["a"] })).resolves.toBeInstanceOf(
      AddRuleTargetsDto,
    );
    await expect(run(AddRuleTargetsDto, { categoryIds: ["c"] })).resolves.toBeInstanceOf(
      AddRuleTargetsDto,
    );
    await expect(
      run(AddRuleTargetsDto, { productIds: ["a"], categoryIds: ["c"] }),
    ).resolves.toBeInstanceOf(AddRuleTargetsDto);
  });

  it("rejects non-string ids, over-long ids and unknown fields", async () => {
    await expect(run(AddRuleTargetsDto, { productIds: [1] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run(AddRuleTargetsDto, { productIds: ["x".repeat(65)] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run(AddRuleTargetsDto, { productIds: ["a"], extra: 1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("bounds memory at the per-rule cap per array; the 1,000 per-call cap is the service's coded error", async () => {
    await expect(
      run(AddRuleTargetsDto, { productIds: ids(RULE_TARGETS_MAX_PER_REQUEST + 1) }),
    ).resolves.toBeInstanceOf(AddRuleTargetsDto);
    await expect(
      run(AddRuleTargetsDto, { productIds: ids(RULE_TARGETS_MAX_PER_RULE + 1) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("RemoveRuleTargetsDto", () => {
  it("trims the reason; a blank reason means the default", async () => {
    const a = await run(RemoveRuleTargetsDto, { productIds: ["a"], reason: "  gone  " });
    expect(a.reason).toBe("gone");
    const b = await run(RemoveRuleTargetsDto, { productIds: ["a"], reason: "   " });
    expect(b.reason).toBeUndefined();
  });

  it("refuses a reason over 500 characters", async () => {
    await expect(
      run(RemoveRuleTargetsDto, { productIds: ["a"], reason: "r".repeat(501) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("RulesHoldingDto", () => {
  it("needs 1..1000 product ids", async () => {
    await expect(run(RulesHoldingDto, { productIds: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run(RulesHoldingDto, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(RulesHoldingDto, { productIds: ids(RULE_TARGETS_MAX_PER_REQUEST) }),
    ).resolves.toBeInstanceOf(RulesHoldingDto);
    await expect(
      run(RulesHoldingDto, { productIds: ids(RULE_TARGETS_MAX_PER_REQUEST + 1) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("CreateRestrictionDto.targets", () => {
  const base = { jurisdiction: "FEDERAL", reason: "why" };

  it("accepts a nested targets object next to the legacy fields", async () => {
    const dto = await run(CreateRestrictionDto, {
      ...base,
      targets: { productIds: ["a", "b"], categoryIds: ["c"] },
    });
    expect(dto.targets).toEqual({ productIds: ["a", "b"], categoryIds: ["c"] });
    await expect(run(CreateRestrictionDto, { ...base, productId: "a" })).resolves.toBeInstanceOf(
      CreateRestrictionDto,
    );
  });

  it("validates the nested ids and rejects unknown nested fields", async () => {
    await expect(
      run(CreateRestrictionDto, { ...base, targets: { productIds: [1] } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(CreateRestrictionDto, { ...base, targets: { productIds: ["a"], extra: true } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
