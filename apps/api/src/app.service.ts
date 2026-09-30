import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
  healthCheck() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      branch: process.env.RAILWAY_GIT_BRANCH ?? null,
    };
  }
}
