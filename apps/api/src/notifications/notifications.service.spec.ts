/**
 * notifications.service.spec.ts
 * ──────────────────────────────
 * B04 (train 2, cause-ruling.md §2/§3, D1): the mobile Settings → Push
 * notifications switch used to be local-only state — nothing server-side
 * ever consulted it. This pins the two halves of the fix:
 *   - REG-B04-C: `sendToUser` must not deliver to a user whose `pushEnabled`
 *     UserPreference is explicitly "false".
 *   - REG-B04-D: `registerToken` must no-op (never persist a DeviceToken row)
 *     for a user whose `pushEnabled` preference is "false" — the server-side
 *     guard the ruling picked so a stale client can't re-enable delivery by
 *     calling register-token again after toggling off.
 * A missing preference row (never toggled) must default to ENABLED — this is
 * an opt-out, not an opt-in.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { NotificationsService } from "./notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("NotificationsService — push preference gating (B04)", () => {
  let service: NotificationsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it("REG-B04-C send skips users with pushEnabled=false", async () => {
    prisma.userPreference.findUnique.mockResolvedValue({
      userId: "user-1",
      key: "pushEnabled",
      value: "false",
    });
    prisma.deviceToken.findMany.mockResolvedValue([
      { id: "dt-1", token: "ExponentPushToken[abc]" },
    ]);

    const sent = await service.sendToUser("user-1", { title: "Hi", body: "There" });

    expect(sent).toBe(0);
    // The disabled preference must short-circuit BEFORE any token is loaded —
    // otherwise a caller inspecting the token list would still see live rows.
    expect(prisma.deviceToken.findMany).not.toHaveBeenCalled();
  });

  it("REG-B04-D register is a no-op when pushEnabled=false", async () => {
    prisma.userPreference.findUnique.mockResolvedValue({
      userId: "user-1",
      key: "pushEnabled",
      value: "false",
    });

    await service.registerToken("user-1", "ExponentPushToken[xyz]", "IOS");

    expect(prisma.deviceToken.upsert).not.toHaveBeenCalled();
  });

  it("send still reaches the token lookup when no preference row exists (opt-out, default enabled)", async () => {
    prisma.userPreference.findUnique.mockResolvedValue(null);
    // No tokens — keeps this a pure gating test with no outbound Expo/FCM call.
    prisma.deviceToken.findMany.mockResolvedValue([]);

    const sent = await service.sendToUser("user-1", { title: "Hi", body: "There" });

    expect(prisma.deviceToken.findMany).toHaveBeenCalled();
    expect(sent).toBe(0);
  });

  it("REG-B04-E sendToAll skips users with pushEnabled=false", async () => {
    // Two devices on two different users — user-1 has explicitly opted out,
    // user-2 hasn't. Non-Expo-shaped tokens keep this out of the real
    // Expo/FCM send path (FCM stays unconfigured in this test module), so
    // only the pre-filter itself is under test.
    prisma.deviceToken.findMany.mockResolvedValue([
      { id: "dt-1", token: "device-token-1", userId: "user-1" },
      { id: "dt-2", token: "device-token-2", userId: "user-2" },
    ]);
    prisma.userPreference.findMany.mockResolvedValue([{ userId: "user-1" }]);

    const result = await service.sendToAll({ title: "Hi", body: "There" });

    // The mutation this pins against removes the pre-filter — without it,
    // deviceCount reports both devices instead of just the enabled one.
    expect(result.deviceCount).toBe(1);
    expect(prisma.userPreference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "pushEnabled", value: "false" } }),
    );
  });
});
