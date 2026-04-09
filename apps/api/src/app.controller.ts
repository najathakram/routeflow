import { Controller, Get, Req } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request } from "express";
import { AppService } from "./app.service";
import { RedisThrottlerStorage } from "./common/redis-throttler.storage";

@ApiTags("health")
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly config: ConfigService,
    private readonly throttlerStorage: RedisThrottlerStorage,
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

    let redisStatus = "unknown";
    let throttleKeys: unknown = null;
    try {
      const pong = await this.throttlerStorage.redis.ping();
      redisStatus = pong === "PONG" ? "connected" : `unexpected: ${pong}`;
      // Scan for any throttle keys in Redis (non-blocking, pattern scan)
      const [, keys] = await this.throttlerStorage.redis.scan(0, "MATCH", "throttle:*", "COUNT", 20);
      const vals = keys.length > 0
        ? await Promise.all(keys.map(async (k) => ({ key: k, val: await this.throttlerStorage.redis.get(k) })))
        : [];
      throttleKeys = vals;
    } catch (e: unknown) {
      redisStatus = `error: ${(e as Error).message}`;
    }
    return { ip, fwdFor, redisUrl, redisStatus, throttleKeys };
  }
}
