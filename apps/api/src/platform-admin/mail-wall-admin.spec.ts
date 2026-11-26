import { BadRequestException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  ADMIN_AUDIT_ACTION_FACETS,
  AdminAuditAction,
  adminAuditActionLabel,
} from "./audit-actions.constant";
import { SetMailWallDto } from "./dto/set-mail-wall.dto";
import { PlatformAdminService } from "./platform-admin.service";

/**
 * W-1464 (mail wall): `GET/PUT platform-admin/tenants/:id/mail-wall`. The list is one PlatformConfig row per
 * business; a bad entry is a 400 that names its position and never echoes the address; the audit row carries
 * a count, never an address; an empty list removes the row.
 */
const TENANT = "qa-acme-tenant";
const ADMIN = "qa-admin-1";

describe("SetMailWallDto", () => {
  const errors = async (body: object) => validate(plainToInstance(SetMailWallDto, body));
  it("takes an array of strings up to 20, and nothing else", async () => {
    expect(await errors({ addresses: [] })).toEqual([]);
    expect(await errors({ addresses: ["a@acme.example"] })).toEqual([]);
    expect(
      (await errors({ addresses: Array.from({ length: 21 }, () => "a@acme.example") })).length,
    ).toBeGreaterThan(0);
    expect((await errors({ addresses: "a@acme.example" })).length).toBeGreaterThan(0);
    expect((await errors({ addresses: [1] })).length).toBeGreaterThan(0);
    expect((await errors({})).length).toBeGreaterThan(0);
  });
});

describe("PlatformAdminService mail wall", () => {
  let stored: string | null;
  let found: { id: string; slug: string; class: string } | null;
  let prisma: any;
  let recordAdminAction: jest.Mock;
  let self: any;
  const get = () => PlatformAdminService.prototype.getMailWall.call(self, TENANT);
  const put = (addresses: string[]) =>
    PlatformAdminService.prototype.setMailWall.call(self, TENANT, addresses, ADMIN);

  beforeEach(() => {
    stored = null;
    found = { id: TENANT, slug: "qa-acme", class: "TEST" };
    prisma = {
      tenant: { findUnique: jest.fn(async () => found) },
      $queryRaw: jest.fn(async () => (stored === null ? [] : [{ value: stored }])),
      $executeRaw: jest.fn(async (_s: TemplateStringsArray, _key: string, value?: string) => {
        stored = typeof value === "string" ? value : null; // the DELETE form passes no value
        return 1;
      }),
    };
    recordAdminAction = jest.fn();
    self = {
      prisma,
      recordAdminAction,
      _findOrThrow: async () => {
        if (!found) throw new NotFoundException();
        return found;
      },
      getMailWall: get,
    };
  });

  it("reads none, list and unreadable as three states", async () => {
    expect(await get()).toEqual({ class: "TEST", state: "none", addresses: [] });
    stored = JSON.stringify(["a@acme.example"]);
    expect(await get()).toEqual({ class: "TEST", state: "list", addresses: ["a@acme.example"] });
    stored = "garbage";
    expect(await get()).toEqual({ class: "TEST", state: "unreadable", addresses: [] });
  });

  it("stores a normalised list and audits the count only", async () => {
    const res = await put(["Tester@Acme.Example", "tester+*@acme.example"]);
    expect(JSON.parse(stored!)).toEqual(["tester@acme.example", "tester+*@acme.example"]);
    expect(res.state).toBe("list");
    expect(recordAdminAction).toHaveBeenCalledWith(
      TENANT,
      ADMIN,
      AdminAuditAction.MAIL_WALL_CHANGED,
      {
        count: 2,
      },
    );
  });

  it("refuses a whole mail domain with a 400 that names the position and not the address", async () => {
    const err = await put(["ok@acme.example", "@gmail.com"]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(String(err.message)).toContain("Entry 2");
    expect(String(err.message)).not.toContain("gmail");
    expect(stored).toBeNull();
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it("an empty list clears the row; an unknown business is a 404", async () => {
    stored = JSON.stringify(["a@acme.example"]);
    await put([]);
    expect(stored).toBeNull();
    found = null;
    await expect(put(["a@acme.example"])).rejects.toBeInstanceOf(NotFoundException);
  });

  it("MAIL_WALL_CHANGED has a plain label and shows in the audit-log filter", () => {
    expect(adminAuditActionLabel(AdminAuditAction.MAIL_WALL_CHANGED)).toBe(
      "Allowed mail addresses changed",
    );
    expect(ADMIN_AUDIT_ACTION_FACETS.map((f) => f.code)).toContain(
      AdminAuditAction.MAIL_WALL_CHANGED,
    );
  });
});
