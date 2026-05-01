// Jest stub for expo-server-sdk (ESM package — cannot be parsed by ts-jest without transform)
"use strict";

class Expo {
  constructor() {}
  static isExpoPushToken(token) {
    return typeof token === "string" && token.startsWith("ExponentPushToken[");
  }
  async sendPushNotificationsAsync() {
    return [];
  }
  async getPushNotificationReceiptsAsync() {
    return {};
  }
}

module.exports = Expo;
module.exports.default = Expo;
module.exports.Expo = Expo;
