import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  constructor(app: INestApplication) {
    super(app);
    const config = app.get(ConfigService);
    const rawUrl = config.get<string>('redis.url') ?? 'redis://localhost:6379';
    const password = config.get<string>('redis.password');

    const options = password ? { password } : {};

    const pubClient = createClient({ url: rawUrl, ...options });
    const subClient = pubClient.duplicate();

    // Connect both clients (non-blocking; socket.io-redis-adapter handles reconnects)
    void Promise.all([pubClient.connect(), subClient.connect()]).catch((err) =>
      console.error('Redis adapter connection error:', err),
    );

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
