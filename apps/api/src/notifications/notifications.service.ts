import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import * as admin from "firebase-admin";
import { PrismaService } from "../prisma/prisma.service";

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private firebaseInitialized = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    const serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT_JSON;

    if (!serviceAccountJson) {
      this.logger.warn("FCM_SERVICE_ACCOUNT_JSON not set — push notifications disabled.");
      return;
    }

    try {
      // Avoid re-initializing if already done
      if (admin.apps.length > 0) {
        this.firebaseInitialized = true;
        return;
      }

      const serviceAccount = JSON.parse(
        Buffer.from(serviceAccountJson, "base64").toString("utf8"),
      );

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
    return this.firebaseInitialized;
  }

  async registerToken(userId: string, token: string, platform: "IOS" | "ANDROID"): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({
      where: { userId, token },
    });
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    if (!this.firebaseInitialized) return 0;

    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true, id: true },
    });

    if (tokens.length === 0) return 0;

    const message: admin.messaging.MulticastMessage = {
      tokens: tokens.map((t) => t.token),
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
    };

    const result = await admin.messaging().sendEachForMulticast(message);

    // Remove invalid tokens
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
      await this.prisma.deviceToken.deleteMany({
        where: { id: { in: invalidIds } },
      });
    }

    return result.successCount;
  }

  async sendToAll(payload: PushPayload): Promise<{ sent: number; deviceCount: number }> {
    if (!this.firebaseInitialized) return { sent: 0, deviceCount: 0 };

    const allTokens = await this.prisma.deviceToken.findMany({
      select: { token: true },
    });

    const deviceCount = allTokens.length;
    if (deviceCount === 0) return { sent: 0, deviceCount: 0 };

    // FCM multicast limit is 500 tokens
    let sent = 0;
    const batchSize = 500;
    for (let i = 0; i < allTokens.length; i += batchSize) {
      const batch = allTokens.slice(i, i + batchSize).map((t) => t.token);
      const message: admin.messaging.MulticastMessage = {
        tokens: batch,
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
      };
      const result = await admin.messaging().sendEachForMulticast(message);
      sent += result.successCount;
    }

    return { sent, deviceCount };
  }

  async sendTestNotification(userId: string): Promise<{ sent: number; deviceCount: number }> {
    const tokens = await this.prisma.deviceToken.count({ where: { userId } });
    const sent = await this.sendToUser(userId, {
      title: "Test Notification",
      body: "RouteFlow push notifications are working!",
    });
    return { sent, deviceCount: tokens };
  }

  async getStatus(): Promise<{ configured: boolean; deviceCount: number }> {
    const deviceCount = await this.prisma.deviceToken.count();
    return { configured: this.firebaseInitialized, deviceCount };
  }

  /** Send a push notification to a customer by their customerId */
  async sendToCustomer(
    customerId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
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
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    });
    if (!driver?.userId) return;
    await this.sendToUser(driver.userId, { title, body, data });
  }
}
