import "reflect-metadata";
import { Logger, type ArgumentMetadata } from "@nestjs/common";
import { buildGlobalValidationPipe } from "./global-validation-pipe";
import { auditAiKeyChange } from "./claude-api-key";
import { UpdateAnthropicKeyDto } from "../system-config/dto/update-anthropic-key.dto";
import { UpdateAiConfigDto } from "../platform-admin/dto/update-ai-config.dto";

/**
 * SA-1102 A-1(d): both key endpoints validate the key through the one global pipe (S-14) and audit a change with the
 * last 4 characters only (S-15).
 */
const GOOD = "sk-ant-api03-GOODGOODGOODGOODGOODGOODGOODab12";
const pipe = buildGlobalValidationPipe();
const run = (type: new () => object, body: unknown) =>
  pipe.transform(body, { type: "body", metatype: type } as ArgumentMetadata);
const refusal = async (type: new () => object, body: unknown) =>
  run(type, body).then(
    () => null,
    (e: any) => e,
  );

describe.each([
  ["PATCH /settings/anthropic", UpdateAnthropicKeyDto],
  ["PATCH /platform-admin/ai-config", UpdateAiConfigDto],
])("S-14: %s validates the key", (_name, Dto) => {
  it.each([
    ["not a key", "hello"],
    ["the wrong prefix", "sk-live-" + "A".repeat(30)],
    ["too short", "sk-ant-short"],
    ["a space inside", "sk-ant-api03-" + "A".repeat(20) + " " + "B".repeat(5)],
    ["a number", 12345],
  ])("rejects %s with 400 and the one sentence", async (_label, apiKey) => {
    const err = await refusal(Dto, { apiKey });
    expect(err?.getStatus?.()).toBe(400);
    expect(JSON.stringify(err?.getResponse?.())).toContain(
      "That doesn't look like a Claude API key.",
    );
  });

  it("accepts a well-formed key, trimmed, and accepts '' (clear) and no key at all", async () => {
    await expect(run(Dto, { apiKey: `  ${GOOD}\n` })).resolves.toMatchObject({ apiKey: GOOD });
    await expect(run(Dto, { apiKey: "" })).resolves.toMatchObject({ apiKey: "" });
    await expect(run(Dto, {})).resolves.toBeDefined();
  });
});

describe("the platform AI config DTO keeps its other fields", () => {
  it("accepts model, scanModel, maxTokens and the monthly cap; rejects an unknown field and a negative cap", async () => {
    await expect(
      run(UpdateAiConfigDto, {
        model: "claude-sonnet-5-5",
        scanModel: "claude-haiku-5-5",
        maxTokens: 4096,
        monthlyCapUsd: 0,
      }),
    ).resolves.toBeDefined();
    expect((await refusal(UpdateAiConfigDto, { surprise: 1 }))?.getStatus?.()).toBe(400);
    expect((await refusal(UpdateAiConfigDto, { monthlyCapUsd: -1 }))?.getStatus?.()).toBe(400);
  });
});

describe("S-15: the audit row keeps the last 4 characters and nothing else", () => {
  const prismaWith = (create: jest.Mock) => ({ auditLog: { create } }) as any;

  it("a set writes one ai_key.set row whose meta is { last4 }", async () => {
    const create = jest.fn().mockResolvedValue({});
    await auditAiKeyChange(prismaWith(create), {
      tenantId: "t1",
      userId: "u1",
      entityType: "SystemConfig",
      apiKey: GOOD,
    });
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      action: "ai_key.set",
      entityType: "SystemConfig",
      meta: { last4: "ab12" },
    });
    // No part of the key but its last 4 characters is anywhere in the row.
    expect(JSON.stringify(data)).not.toContain(GOOD.slice(0, -4));
    expect(JSON.stringify(data)).not.toContain("sk-ant");
  });

  it("a clear writes ai_key.cleared with no key material", async () => {
    const create = jest.fn().mockResolvedValue({});
    await auditAiKeyChange(prismaWith(create), {
      tenantId: null,
      userId: "admin-1",
      entityType: "PlatformConfig",
      apiKey: "",
    });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      action: "ai_key.cleared",
      entityType: "PlatformConfig",
      tenantId: null,
    });
    expect(data.meta).toBeUndefined();
  });

  it("a failed audit write never throws and its log line never holds the key", async () => {
    const create = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error(`boom ${GOOD}`), { code: "P2002" }));
    const errors: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation((m: unknown) => void errors.push(String(m)));
    await expect(
      auditAiKeyChange(prismaWith(create), {
        tenantId: "t1",
        userId: "u1",
        entityType: "SystemConfig",
        apiKey: GOOD,
      }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("sk-ant");
  });
});
