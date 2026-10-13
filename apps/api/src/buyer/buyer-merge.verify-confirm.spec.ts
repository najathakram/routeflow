/**
 * Row 404: the emailed merge-verification link must survive a link scanner. A mail scanner or link
 * prefetcher that opens the link (or the API GET behind the page) must not complete the merge: the
 * GET only previews the token and writes nothing; the single-use consume is an explicit POST with
 * the token in the body, made by a human click.
 */
import "reflect-metadata";
import { BadRequestException, GoneException, NotFoundException } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BuyerMergeRequestStatus } from "@prisma/client";
import { BuyerMergeService } from "./buyer-merge.service";
import { BuyerMergeController } from "./buyer-merge.controller";
import { BuyerVerifyMergeDto } from "./dto/buyer-verify-merge.dto";

type Row = {
  id: string;
  status: BuyerMergeRequestStatus;
  verificationToken: string | null;
  verificationExpires: Date | null;
  verifiedAt: Date | null;
  primaryAccountId: string;
  secondaryAccountId: string;
};

const TOKEN = "a".repeat(64);

/** One stateful merge-request row behind a Prisma-shaped mock, so a consume really clears the token. */
function build(over: Partial<Row> = {}) {
  const row: Row = {
    id: "req-1",
    status: BuyerMergeRequestStatus.PENDING_VERIFICATION,
    verificationToken: TOKEN,
    verificationExpires: new Date(Date.now() + 60 * 60 * 1000),
    verifiedAt: null,
    primaryAccountId: "buyer-primary",
    secondaryAccountId: "buyer-secondary",
    ...over,
  };
  const buyerMergeRequest = {
    findUnique: jest.fn(async (args: { where: { verificationToken?: string; id?: string } }) => {
      const w = args.where;
      if (w.verificationToken !== undefined)
        return row.verificationToken !== null && row.verificationToken === w.verificationToken
          ? { ...row }
          : null;
      return w.id === row.id ? { ...row } : null;
    }),
    findFirst: jest.fn(),
    update: jest.fn(async (args: { where: { id: string }; data: Partial<Row> }) => {
      Object.assign(row, args.data);
      return { ...row };
    }),
    // Honours a compare-and-set `where` (id + token + status) the way Postgres would: a row whose
    // token was cleared or whose status moved on since the lookup is NOT written, count 0.
    updateMany: jest.fn(
      async (args: {
        where: { id: string; verificationToken?: string; status?: BuyerMergeRequestStatus };
        data: Partial<Row>;
      }) => {
        const w = args.where;
        const match =
          w.id === row.id &&
          (w.verificationToken === undefined || w.verificationToken === row.verificationToken) &&
          (w.status === undefined || w.status === row.status);
        if (match) Object.assign(row, args.data);
        return { count: match ? 1 : 0 };
      },
    ),
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    upsert: jest.fn(),
  };
  const auditLog = { create: jest.fn(), createMany: jest.fn() };
  const prisma = {
    buyerMergeRequest,
    auditLog,
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  } as any;
  const email = new Proxy(
    {},
    {
      get: (target: Record<string, jest.Mock>, key: string) =>
        (target[key] ??= jest.fn().mockResolvedValue({ delivered: true })),
    },
  ) as any;
  const svc = new BuyerMergeService(prisma, email, {} as any);
  return { svc, prisma, email, row, buyerMergeRequest, auditLog };
}

function expectNoWrites(ctx: ReturnType<typeof build>) {
  const m = ctx.buyerMergeRequest;
  for (const fn of [m.update, m.updateMany, m.create, m.delete, m.deleteMany, m.upsert])
    expect(fn).not.toHaveBeenCalled();
  expect(ctx.auditLog.create).not.toHaveBeenCalled();
  expect(ctx.auditLog.createMany).not.toHaveBeenCalled();
  expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
  expect(ctx.prisma.$executeRaw).not.toHaveBeenCalled();
  expect(ctx.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  for (const fn of Object.values(ctx.email as Record<string, jest.Mock>))
    expect(fn).not.toHaveBeenCalled();
}

describe("BuyerMergeService.verifyMergeToken: the single-use consume is unchanged", () => {
  it("one consume succeeds exactly once", async () => {
    const ctx = build();
    const out = await ctx.svc.verifyMergeToken(TOKEN);
    expect(out).toEqual({
      success: true,
      message:
        "Your account ownership is confirmed. A platform admin will review and complete the merge shortly.",
    });
    expect(ctx.buyerMergeRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(ctx.buyerMergeRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "req-1",
        verificationToken: TOKEN,
        status: BuyerMergeRequestStatus.PENDING_VERIFICATION,
      },
      data: {
        status: BuyerMergeRequestStatus.PENDING_REVIEW,
        verifiedAt: expect.any(Date),
        verificationToken: null,
        verificationExpires: null,
      },
    });
    // the consume is a compare-and-set: never a blind update by id
    expect(ctx.buyerMergeRequest.update).not.toHaveBeenCalled();
    expect(ctx.row.verificationToken).toBeNull();
    expect(ctx.row.status).toBe(BuyerMergeRequestStatus.PENDING_REVIEW);
  });

  it("a second consume (replay) is NotFound and writes nothing more", async () => {
    const ctx = build();
    await ctx.svc.verifyMergeToken(TOKEN);
    await expect(ctx.svc.verifyMergeToken(TOKEN)).rejects.toThrow(NotFoundException);
    expect(ctx.buyerMergeRequest.updateMany).toHaveBeenCalledTimes(1);
  });

  it("an unknown token is NotFound on consume and writes nothing", async () => {
    const ctx = build();
    await expect(ctx.svc.verifyMergeToken("b".repeat(64))).rejects.toThrow(NotFoundException);
    expectNoWrites(ctx);
  });

  it("an expired token is Gone on consume and is not consumed", async () => {
    const ctx = build({ verificationExpires: new Date(Date.now() - 1000) });
    await expect(ctx.svc.verifyMergeToken(TOKEN)).rejects.toThrow(GoneException);
    expectNoWrites(ctx);
  });

  it("a processed request is BadRequest on consume", async () => {
    const ctx = build({ status: BuyerMergeRequestStatus.COMPLETED });
    await expect(ctx.svc.verifyMergeToken(TOKEN)).rejects.toThrow(BadRequestException);
    expectNoWrites(ctx);
  });
});

describe("BuyerMergeService.verifyMergeToken: the consume is compare-and-set", () => {
  it("a lost race (updateMany count 0) is the replay 404 and has no further side effect", async () => {
    const ctx = build();
    ctx.buyerMergeRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    const err = await ctx.svc.verifyMergeToken(TOKEN).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe("Invalid verification token");
    expect(ctx.buyerMergeRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(ctx.buyerMergeRequest.update).not.toHaveBeenCalled();
    expect(ctx.auditLog.create).not.toHaveBeenCalled();
    expect(ctx.auditLog.createMany).not.toHaveBeenCalled();
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    for (const fn of Object.values(ctx.email as Record<string, jest.Mock>))
      expect(fn).not.toHaveBeenCalled();
  });

  it("a request rejected between the lookup and the update never ends PENDING_REVIEW", async () => {
    const ctx = build();
    // the admin rejects right after the consume's lookup read PENDING_VERIFICATION
    ctx.buyerMergeRequest.findUnique.mockImplementationOnce(async () => {
      const seen = { ...ctx.row };
      ctx.row.status = BuyerMergeRequestStatus.REJECTED;
      return seen;
    });

    await expect(ctx.svc.verifyMergeToken(TOKEN)).rejects.toThrow(NotFoundException);

    expect(ctx.row.status).toBe(BuyerMergeRequestStatus.REJECTED);
    expect(ctx.row.verifiedAt).toBeNull();
    expect(ctx.buyerMergeRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(ctx.buyerMergeRequest.update).not.toHaveBeenCalled();
  });

  it("a token cleared by a concurrent consume is a 404, not a second success", async () => {
    const ctx = build();
    ctx.buyerMergeRequest.findUnique.mockImplementationOnce(async () => {
      const seen = { ...ctx.row };
      ctx.row.status = BuyerMergeRequestStatus.PENDING_REVIEW;
      ctx.row.verificationToken = null;
      return seen;
    });

    await expect(ctx.svc.verifyMergeToken(TOKEN)).rejects.toThrow(NotFoundException);
    expect(ctx.row.status).toBe(BuyerMergeRequestStatus.PENDING_REVIEW);
  });
});

describe("BuyerMergeController: the only consume path is the POST (row 413)", () => {
  const proto = BuyerMergeController.prototype as unknown as Record<string, () => unknown>;
  const handlerFor = (method: RequestMethod, path: string) =>
    Object.getOwnPropertyNames(BuyerMergeController.prototype).find(
      (k) =>
        k !== "constructor" &&
        Reflect.getMetadata(METHOD_METADATA, proto[k]) === method &&
        Reflect.getMetadata(PATH_METADATA, proto[k]) === path,
    );

  function controller() {
    const svc = {
      verifyMergeToken: jest.fn().mockResolvedValue({ success: true }),
    };
    return { ctrl: new BuyerMergeController(svc as any), svc };
  }

  it("no GET route reaches verify-merge: a link scanner's prefetch has nothing to hit (row 413)", () => {
    const gets = Object.getOwnPropertyNames(BuyerMergeController.prototype)
      .filter((k) => k !== "constructor")
      .filter((k) => Reflect.getMetadata(METHOD_METADATA, proto[k]) === RequestMethod.GET)
      .map((k) => String(Reflect.getMetadata(PATH_METADATA, proto[k])));
    expect(gets.filter((p) => p.includes("verify-merge"))).toEqual([]);
    const routes = Object.getOwnPropertyNames(BuyerMergeController.prototype)
      .filter((k) => k !== "constructor")
      .map((k) => [
        Reflect.getMetadata(METHOD_METADATA, proto[k]),
        String(Reflect.getMetadata(PATH_METADATA, proto[k])),
      ])
      .filter(([, path]) => String(path).includes("verify-merge"));
    expect(routes).toEqual([[RequestMethod.POST, "verify-merge"]]);
  });

  it("the service has no non-consuming token read left", () => {
    expect((BuyerMergeService.prototype as unknown as Record<string, unknown>).peekMergeToken).toBe(
      undefined,
    );
  });

  it("POST verify-merge (token in the body) consumes, answers 200 and is throttled like verify-email", async () => {
    const key = handlerFor(RequestMethod.POST, "verify-merge");
    expect(key).toBeDefined();
    const fn = proto[key!];
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, fn)).toBe(200);
    expect(Reflect.getMetadata("THROTTLER:LIMITdefault", fn)).toBe(5);
    expect(Reflect.getMetadata("THROTTLER:TTLdefault", fn)).toBe(900_000);
    const { ctrl, svc } = controller();
    await (ctrl as any)[key!]({ token: TOKEN });
    expect(svc.verifyMergeToken).toHaveBeenCalledWith(TOKEN);
  });

  it("no POST route carries the token in its path", () => {
    const posts = Object.getOwnPropertyNames(BuyerMergeController.prototype)
      .filter((k) => k !== "constructor")
      .filter((k) => Reflect.getMetadata(METHOD_METADATA, proto[k]) === RequestMethod.POST)
      .map((k) => String(Reflect.getMetadata(PATH_METADATA, proto[k])));
    expect(posts.some((p) => p.includes(":token"))).toBe(false);
  });
});

describe("BuyerVerifyMergeDto", () => {
  const errs = async (body: unknown) =>
    (await validate(plainToInstance(BuyerVerifyMergeDto, body as object))).map((e) => e.property);

  it("accepts a token string", async () => {
    expect(await errs({ token: TOKEN })).toEqual([]);
  });

  it.each([[{}], [{ token: "" }], [{ token: 42 }]])("rejects %j", async (body) => {
    expect(await errs(body)).toEqual(["token"]);
  });
});
