import { Controller, Get, Req } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import Redis from "ioredis";
import type { Request } from "express";
import { AppService } from "./app.service";

@ApiTags("health")
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly config: ConfigService,
  ) {}

  @Get("health")
  @ApiOperation({ summary: "Health check" })
  healthCheck() {
    return this.appService.healthCheck();
  }

  /** Temporary diagnostic endpoint — remove after BUG-003 verification */
  @Get("debug/throttle")
  @SkipThrottle()
  async debugThrottle(@Req() req: Request) {
    const ip = req.ip;
    const fwdFor = req.headers["x-forwarded-for"];
    const redisUrl = (this.config.get<string>("redis.url") ?? "not set").replace(/:([^@:]+)@/, ":***@");
    const password = this.config.get<string>("redis.password") || undefined;

    // Test Redis connectivity with a short-lived client
    let redisStatus = "unknown";
    try {
      const r = new Redis(this.config.get<string>("redis.url") ?? "redis://localhost:6379", {
        password,
        connectTimeout: 3_000,
        lazyConnect: true,
      });
      await r.connect();
      const pong = await r.ping();
      redisStatus = pong === "PONG" ? "connected" : `unexpected: ${pong}`;
      await r.quit().catch(() => {});
    } catch (e: unknown) {
      redisStatus = `error: ${(e as Error).message}`;
    }
    return { ip, fwdFor, redisUrl, redisStatus };
  }
}
