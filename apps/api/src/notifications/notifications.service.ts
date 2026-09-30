import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import * as admin from "firebase-admin";
import Expo, { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { PrismaService } from "../prisma/prisma.service";

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

interface TokenRow {
  id: string;
  token: string;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private firebaseInitialized = false;
  private readonly expo = new Expo();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    const serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT_JSON;

    if (!serviceAccountJson) {
      this.logger.warn("FCM_SERVICE_ACCOUNT_JSON not set — Firebase push notifications disabled.");
      return;
    }

    try {
      if (admin.apps.length > 0) {
        this.firebaseInitialized = true;
        return;
      }

      const serviceAccount = JSON.parse(Buffer.from(serviceAccountJson, "base64").toString("utf8"));

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });

      this.firebaseInitialized = true;
      this.logger.log("Firebase Admin SDK initialized.");
    } catch (err) {
      this.logger.error("Failed to initialize Firebase Admin SDK:", err);
    }
  }

  isConfigured(): boolean {
    return this.firebaseInitialized || true; // Expo push always available
  }

  /**
   * B04: per-user opt-out. Missing row (never toggled) defaults to ENABLED —
   * only an explicit "false" suppresses delivery/registration.
   */
  private async isPushEnabled(userId: string): Promise<boolean> {
    const pref = await this.prisma.forTenant().userPreference.findUnique({
      where: { userId_key: { userId, key: "pushEnabled" } },
    });
    return pref?.value !== "false";
  }

  async registerToken(userId: string, token: string, platform: "IOS" | "ANDROID"): Promise<void> {
    // B04 / REG-B04-D: server-side no-op so a stale client can't re-enable
    // delivery just by calling register-token again after toggling off.
    if (!(await this.isPushEnabled(userId))) return;
    await this.prisma.forTenant().deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await this.prisma.forTenant().deviceToken.deleteMany({
      where: { userId, token },
    });
  }

  /**
   * RF-009: Send push notifications to a user's registered devices.
   * Expo push tokens (ExponentPushToken[...]) are routed to the Expo Push API;
   * native FCM tokens are routed to Firebase when configured.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    // B04 / REG-B04-C: an explicit pushEnabled=false skips delivery entirely —
    // checked BEFORE the token lookup so a disabled user's tokens are never
    // even read for this send.
    if (!(await this.isPushEnabled(userId))) return 0;

    const tokens = await this.prisma.forTenant().deviceToken.findMany({
      where: { userId },
      select: { token: true, id: true },
    });

    if (tokens.length === 0) return 0;

    const { expoTokens, fcmTokens } = this.partitionTokens(tokens);

    let successCount = 0;
    if (expoTokens.length > 0) {
      successCount += await this.sendViaExpo(expoTokens, payload);
    }
    if (fcmTokens.length > 0 && this.firebaseInitialized) {
      successCount += await this.sendViaFirebase(fcmTokens, payload);
    }

    return successCount;
  }

  async sendToAll(payload: PushPayload): Promise<{ sent: number; deviceCount: number }> {
    const allTokens = await this.prisma.forTenant().deviceToken.findMany({
      select: { token: true, id: true, userId: true },
    });

    // B04: exclude devices belonging to a user who has explicitly opted out —
    // same rule as sendToUser, applied as a pre-filter here since this fans
    // out over every device at once.
    const disabledUserIds = new Set(
      (
        await this.prisma.forTenant().userPreference.findMany({
          where: { key: "pushEnabled", value: "false" },
          select: { userId: true },
        })
      ).map((p: { userId: string }) => p.userId),
    );
    const tokens = allTokens.filter((t: { userId: string }) => !disabledUserIds.has(t.userId));

    const deviceCount = tokens.length;
    if (deviceCount === 0) return { sent: 0, deviceCount: 0 };

    const { expoTokens, fcmTokens } = this.partitionTokens(tokens);

    let sent = 0;
    if (expoTokens.length > 0) {
      sent += await this.sendViaExpo(expoTokens, payload);
    }
    if (fcmTokens.length > 0 && this.firebaseInitialized) {
      // FCM multicast limit is 500 tokens per batch
      const batchSize = 500;
      for (let i = 0; i < fcmTokens.length; i += batchSize) {
        sent += await this.sendViaFirebase(fcmTokens.slice(i, i + batchSize), payload);
      }
    }

    return { sent, deviceCount };
  }

  async sendTestNotification(userId: string): Promise<{ sent: number; deviceCount: number }> {
    const tokens = await this.prisma.forTenant().deviceToken.count({ where: { userId } });
    const sent = await this.sendToUser(userId, {
      title: "Test Notification",
      body: "RouteFlow push notifications are working!",
    });
    return { sent, deviceCount: tokens };
  }

  async getStatus(): Promise<{ configured: boolean; deviceCount: number }> {
    const deviceCount = await this.prisma.forTenant().deviceToken.count();
    return { configured: this.isConfigured(), deviceCount };
  }

  /** Send a push notification to a customer by their customerId */
  async sendToCustomer(
    customerId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const customer = await this.prisma.forTenant().customer.findFirst({
      where: { id: customerId },
      select: { userId: true },
    });
    if (!customer?.userId) return;
    await this.sendToUser(customer.userId, { title, body, data });
  }

  /** Send a push notification to a driver by their driverId */
  async sendToDriver(
    driverId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const driver = await this.prisma.forTenant().driver.findFirst({
      where: { id: driverId },
      select: { userId: true },
    });
    if (!driver?.userId) return;
    await this.sendToUser(driver.userId, { title, body, data });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private partitionTokens(tokens: TokenRow[]): { expoTokens: TokenRow[]; fcmTokens: TokenRow[] } {
    const expoTokens: TokenRow[] = [];
    const fcmTokens: TokenRow[] = [];
    for (const t of tokens) {
      if (Expo.isExpoPushToken(t.token)) {
        expoTokens.push(t);
      } else {
        fcmTokens.push(t);
      }
    }
    return { expoTokens, fcmTokens };
  }

  private async sendViaExpo(tokens: TokenRow[], payload: PushPayload): Promise<number> {
    const messages: ExpoPushMessage[] = tokens.map((t) => ({
      to: t.token,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      sound: "default" as const,
    }));

    const chunks = this.expo.chunkPushNotifications(messages);
    const allTickets: ExpoPushTicket[] = [];

    for (const chunk of chunks) {
      try {
        const tickets = await this.expo.sendPushNotificationsAsync(chunk);
        allTickets.push(...tickets);
      } catch (err) {
        this.logger.error("Expo push chunk error:", err);
      }
    }

    // Remove tokens that Expo reports as no longer registered
    const invalidIds: string[] = [];
    allTickets.forEach((ticket, idx) => {
      if (ticket.status === "error" && (ticket as any).details?.error === "DeviceNotRegistered") {
        invalidIds.push(tokens[idx].id);
      }
    });

    if (invalidIds.length > 0) {
      await this.prisma.forTenant().deviceToken.deleteMany({
        where: { id: { in: invalidIds } },
      });
    }

    return allTickets.filter((t) => t.status === "ok").length;
  }

  private async sendViaFirebase(tokens: TokenRow[], payload: PushPayload): Promise<number> {
    const message: admin.messaging.MulticastMessage = {
      tokens: tokens.map((t) => t.token),
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
    };

    const result = await admin.messaging().sendEachForMulticast(message);

    const invalidIndices: number[] = [];
    result.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const errCode = resp.error?.code;
        if (
          errCode === "messaging/invalid-registration-token" ||
          errCode === "messaging/registration-token-not-registered"
        ) {
          invalidIndices.push(idx);
        }
      }
    });

    if (invalidIndices.length > 0) {
      const invalidIds = invalidIndices.map((i) => tokens[i].id);
      await this.prisma.forTenant().deviceToken.deleteMany({
        where: { id: { in: invalidIds } },
      });
    }

    return result.successCount;
  }
}
